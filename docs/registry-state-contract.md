# Contrato de estado registry — `forge-cli/RegistryState/v1`

Fonte única do formato que `forge-cli` escreve e que leitores externos
(forge-portal, scripts, hosts) podem consumir. O CLI é o único escritor;
leitores são somente-leitura e nunca inventam campos.

## Arquivos

| Arquivo                                   | Conteúdo                                              | Escrita                     |
| ----------------------------------------- | ----------------------------------------------------- | --------------------------- |
| `~/.forge-cli/forges/state.json`          | Índice agregado `{ "forges": { <nome>: <receipt> } }` | atômica (`writeFileAtomic`) |
| `~/.forge-cli/forges/<nome>/receipt.json` | Receipt por Forja                                     | atômica                     |
| `~/.forge-cli/forges/<nome>/install.json` | Metadados da instalação ativa                         | atômica                     |
| `~/.forge-cli/forges/state.json.corrupt`  | Backup quando o state não parseia                     | rename                      |

`~` = `os.homedir()` do processo CLI (override de testes: `home` explícito
nas APIs; o portal honra `FORGE_HOME_OVERRIDE`).

## `state.json`

```json
{
  "forges": {
    "<nome-da-forja>": { "<receipt>" }
  }
}
```

- Chaves são nomes de Forja validados por `isSafeRepoName`
  (`[a-z0-9][a-z0-9-]*`, sem `..`, `/`, `\`) — leitores podem confiar que
  chaves não carregam traversal.
- Valores não-objeto são filtrados na leitura (state poisoned degrada
  para ausência, nunca crash).

## Receipt (por Forja)

| Campo            | Tipo                        | Semântica                            |
| ---------------- | --------------------------- | ------------------------------------ |
| `forge`          | string                      | nome da Forja                        |
| `method`         | `"registry"`                | método de instalação                 |
| `dist`           | string                      | distribuição PyPI instalada          |
| `version`        | string                      | versão resolvida (PEP 440)           |
| `requiresPython` | string?                     | spec do release (PyPI)               |
| `python`         | string                      | interpretador usado na venv          |
| `source`         | string                      | `pypi` ou `offline-cache`            |
| `venv`           | string                      | path absoluto da venv                |
| `bin`            | string                      | path absoluto do console script      |
| `installedAt`    | string                      | ISO 8601                             |
| `verifiedHash`   | string                      | `sha256:<hex>` do artefato instalado |
| `verify.ok`      | bool                        | pós-install `<bin> --help` passou    |
| `files`          | string[]                    | artefatos gravados (bounded)         |
| `yanked`         | bool                        | release marcada yanked no PyPI       |
| `staleCache`     | bool                        | metadados vieram de cache expirado   |
| `pinned`         | string?                     | pin ativo (`pin --method registry`)  |
| `history`        | `{version, installedAt}[]`? | versões anteriores (rollback)        |

Campos novos podem aparecer em versões futuras do CLI — leitores devem
tolerar campos desconhecidos e tratar campos conhecidos ausentes como
`null`/não-presentes.

## Leitura (forge-portal)

`portal_core.forge_portal.read_registry_state()` projeta o state em
`forge-cli/RegistryState/v1`:

```json
{
  "schema": "forge-cli/RegistryState/v1",
  "state_path": "...",
  "present": true,
  "forges": { "<nome>": { "<receipt projetado>" } }
}
```

- `present: false` (+ `error: "malformed"` quando aplicável) se o
  arquivo não existir, não parsear ou `forges` não for objeto —
  o portal renderiza "não instalado", nunca um receipt inventado.
- `GET /api/v1/registry/state` expõe a mesma projeção (somente-leitura,
  host loopback + sessão, como toda a API do portal).
- Projeção é whitelist de escalares/containers pequenos — nada de
  objetos arbitrários vindos do disco.

## Consistência e recuperação

O CLI trata `state.json` + `install.json` + venv como um único fato.
`installConsistency(home, name)` compara os três e classifica:

- `ok` — as três fontes concordam;
- `not-installed` — nada no state, nada no disco;
- `orphaned` — diretório/venv presente sem entrada no state
  (típico de kill entre "venv criada" e "state commitado");
- `missing-receipt` — entrada no state sem `install.json`;
- `unreadable-receipt` — `install.json` existe mas não parseia;
- `forge-mismatch` / `version-mismatch` — receipt diverge do state;
- `missing-venv` — registro coerente, venv ausente.

Regras do contrato de consistência:

1. Qualquer status diferente de `ok`/`not-installed` é exposto por
   `forge-cli registry` (`consistent: false` + `consistency`) — uma
   instalação pela metade nunca aparece saudável.
2. `install` recusa com `stage: "incomplete"` sobre estado
   inconsistente; `--clean` é o caminho de reparo (backup da instalação
   anterior até o commit, restauração em qualquer falha).
3. `uninstall --method registry` remove também órfãs (disco sem state),
   senão o reparo ficaria sem saída.
4. O commit é a última fronteira: receipt + state são gravados juntos
   sob o lifecycle lock; falha nesse ponto é `stage: "persist"` com o
   errno (EACCES/ENOSPC) no detalhe — o disco pode conter a venv, mas
   a instalação permanece "não saudável" até o reparo.
5. Escritas são atômicas (tmp + fsync + rename) e varrem `*.tmp`
   órfãos de runs mortos com SIGKILL.

## Lifecycle lock

`~/.forge-cli/forges/.forge-lifecycle.lock` é um diretório criado com
`mkdir` (atômico por construção de fs) contendo `info.json`
(`pid`, `at`). Titular com PID morto é quebrado na hora; lock sem
metadata legível só é stale após o threshold de idade; a liberação é
best-effort. O lock serializa install/uninstall/pin/update — quem
perde a corrida re-checa o state sob o lock antes de recusar, então
`already-installed`/`incomplete` refletem o estado pós-serialização,
nunca uma corrida de observação.
