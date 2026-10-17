# Contrato de estado registry — `forge-cli/RegistryState/v1`

Fonte única do formato que `forge-cli` escreve e que leitores externos
(forge-portal, scripts, hosts) podem consumir. O CLI é o único escritor;
leitores são somente-leitura e nunca inventam campos.

## Arquivos

| Arquivo | Conteúdo | Escrita |
|---|---|---|
| `~/.forge-cli/forges/state.json` | Índice agregado `{ "forges": { <nome>: <receipt> } }` | atômica (`writeFileAtomic`) |
| `~/.forge-cli/forges/<nome>/receipt.json` | Receipt por Forja | atômica |
| `~/.forge-cli/forges/<nome>/install.json` | Metadados da instalação ativa | atômica |
| `~/.forge-cli/forges/state.json.corrupt` | Backup quando o state não parseia | rename |

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

| Campo | Tipo | Semântica |
|---|---|---|
| `forge` | string | nome da Forja |
| `method` | `"registry"` | método de instalação |
| `dist` | string | distribuição PyPI instalada |
| `version` | string | versão resolvida (PEP 440) |
| `requiresPython` | string? | spec do release (PyPI) |
| `python` | string | interpretador usado na venv |
| `source` | string | `pypi` ou `offline-cache` |
| `venv` | string | path absoluto da venv |
| `bin` | string | path absoluto do console script |
| `installedAt` | string | ISO 8601 |
| `verifiedHash` | string | `sha256:<hex>` do artefato instalado |
| `verify.ok` | bool | pós-install `<bin> --help` passou |
| `files` | string[] | artefatos gravados (bounded) |
| `yanked` | bool | release marcada yanked no PyPI |
| `staleCache` | bool | metadados vieram de cache expirado |
| `pinned` | string? | pin ativo (`pin --method registry`) |
| `history` | `{version, installedAt}[]`? | versões anteriores (rollback) |

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
