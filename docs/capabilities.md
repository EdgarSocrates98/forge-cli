# Matriz de capacidades das Forjas

Levantamento estático (leitura do código e da documentação dos repositórios,
clones rasos em diretório temporário, sem executar instaladores). Nada aqui é
suposição: o que não pôde ser confirmado está marcado **não verificado**.

Revisões inspecionadas (HEAD de `main` em 2026-10-12):

| Forja             | Commit    |
| ----------------- | --------- |
| the-forge         | `2f1d8bf` |
| spark-forge-aws   | `b554143` |
| spark-forge-azure | `2063dc5` |
| api-forge         | `7fcdf12` |
| platform-forge    | `9ace433` |
| forge-doctor-api  | `b927742` |
| forge-doctor-data | `3ac1cae` |
| forge-portal      | `d0b6ba9` |

## Métodos de instalação do forge-cli

- **git** (default) — clone + bootstrap `setup.sh`/`setup.ps1` +
  instalador nativo sob opt-in (`--native`, `--profile`, `--scope`,
  `--components`). É o fluxo descrito na matriz abaixo.
- **registry** — `install <forja> --method registry`: resolve a dist no
  PyPI, cria venv isolada em `~/.forge-cli/forges/<nome>/venv`, baixa a
  wheel para `~/.forge-cli/cache/wheels/`, confere sha256 contra o
  digest publicado e instala pelo caminho do artefato verificado.
  `uninstall --method registry` remove venv + wheel cache + receipt com
  confirmação; `--plan`, `--offline`, `--clean`, `--version` pinado,
  `--json` e `--report` são honrados. `--native` delega ao instalador
  nativo **da venv** (dry-run sem `--yes`; `--profile`/`--scope`/
  `--components`/`--host`/`--gateway-profile` passam adiante);
  Forjas cujo instalador é script de repositório (forge-doctor-api)
  recebem skip honesto — a wheel não carrega o script.
- **lifecycle registry** — `update` (mais nova no PyPI; `--check` só
  planeja; respeita pin), `reinstall` (mesma versão do receipt — reparo
  de drift), `rollback` (desempilha `history` do receipt; rollback de
  rollback funciona), `pin`/`unpin` (trava a versão instalada no state).
  Tudo com o mesmo contrato: receipts atômicos, `--json`/`--report`,
  flags git ignoradas avisadas, nomes desconhecidos → exit 2, falhas → 1.
- **hosts/MCP sem clone** — `forge-cli mcp <forja>` resolve o argv MCP
  (forge.json do clone ou template `mcp` do catálogo + receipt:
  `{bin}` = bin da venv, `{binDir}/x` = script irmão); `--verify` roda
  `--version` como handshake. `hosts plan|register|validate|rollback`
  usam o mesmo descritor — `hosts register` grava `mcpServers` apontando
  para o binário da venv registry.
- **portal** — `GET /api/v1/registry/state` no forge-portal projeta
  `~/.forge-cli/forges/state.json` (contrato
  `docs/registry-state-contract.md`).

## Matriz registry (PyPI)

| Forja             | Dist PyPI           | Piso Python | MCP (venv)                   | Nativo `--native`           |
| ----------------- | ------------------- | ----------- | ---------------------------- | --------------------------- |
| the-forge         | `theforge-core`     | >=3.11      | — (sem mcp_command)          | `theforge install apply`    |
| api-forge         | `apiforge-af`       | >=3.12      | `apiforge-mcp`               | `apiforge install`          |
| platform-forge    | `platformforge`     | >=3.10      | `platformforge-mcp`          | `platformforge install`     |
| spark-forge-aws   | `sparkforge-aws`    | >=3.10      | `sparkforge-aws mcp serve`   | `sparkforge-aws install`    |
| spark-forge-azure | `sparkforge-azure`  | >=3.10      | `sparkforge-azure mcp serve` | `sparkforge-azure install`  |
| forge-doctor-data | `forge-doctor-data` | >=3.11      | `forge-doctor-data mcp`      | `forge-doctor-data install` |
| forge-doctor-api  | `forge-doctor-api`  | >=3.11      | `forge-doctor-api mcp`       | **não** (script de repo)    |

`requires_python` publicado no PyPI é autoritativo por release; o piso da
tabela compõe com ele (o mais restritivo vence).

## Modelo de instalação em duas fases

1. **Bootstrap** — `setup.sh` / `setup.ps1` (todas as Forjas Python) chamam
   `scripts/forge_bootstrap.py`. Aceita apenas: `--dry-run --editable
--extras --install-dir --no-deps --no-launcher --python --quiet --repo
--upgrade --version --allow-download` (`--persist-env` em api-forge).
   **Não** aceita perfil, escopo ou componentes.
2. **Instalador nativo do produto** — CLI da própria Forja, após o bootstrap:
   `<cli> install [--scope project|workspace|user] [--profile
minimal|recommended|full] [--components ...] [--host claude|devin|codex|copilot|all]
[--gateway-profile economy|balanced|deep] [--dry-run] [--yes]`, além de
   `install doctor`.

O forge-cli executa a fase 1 por padrão (comportamento histórico). A fase 2 só
roda quando o usuário passa `--profile`, `--scope` ou `--components`, e sempre
com `--dry-run`, a menos que `--yes` seja informado.

## Matriz

| Capacidade                      | the-forge                | spark-forge-aws                 | spark-forge-azure          | api-forge                  | platform-forge          | forge-doctor-api                                     | forge-doctor-data           | forge-portal |
| ------------------------------- | ------------------------ | ------------------------------- | -------------------------- | -------------------------- | ----------------------- | ---------------------------------------------------- | --------------------------- | ------------ |
| Clone Git                       | sim                      | sim                             | sim                        | sim                        | sim                     | sim                                                  | sim                         | sim          |
| Bootstrap Windows               | `setup.ps1`              | `setup.ps1`                     | `setup.ps1`                | `setup.ps1`, `install.ps1` | `setup.ps1`             | `setup.ps1`                                          | `setup.ps1`                 | — (npm)      |
| Bootstrap Linux/macOS           | `setup.sh`               | `setup.sh`                      | `setup.sh`                 | `setup.sh`, `install.sh`   | `setup.sh`              | `setup.sh`                                           | `setup.sh`                  | — (npm)      |
| Instalador nativo (CLI)         | `theforge install apply` | `sparkforge-aws install`        | `sparkforge-azure install` | `apiforge install`         | `platformforge install` | `scripts/forge_install.py install` (script, não CLI) | `forge-doctor-data install` | não          |
| `--profile`                     | sim                      | sim                             | sim                        | sim                        | sim                     | sim (script)                                         | sim                         | não          |
| `--scope`                       | sim                      | sim                             | sim                        | sim                        | sim                     | sim (script)                                         | sim                         | não          |
| `--components`                  | sim                      | sim                             | sim                        | sim                        | sim                     | sim (script)                                         | sim                         | não          |
| Skills / agents / MCP           | via instalador nativo    | via instalador nativo           | via instalador nativo      | via instalador nativo      | via instalador nativo   | via `theforge install auto`                          | via instalador nativo       | não          |
| Perfis minimal/recommended/full | sim                      | sim                             | sim                        | sim                        | sim                     | **não verificado**                                   | sim                         | não          |
| Escopo workspace/user           | sim                      | sim                             | sim                        | sim                        | sim                     | **não verificado**                                   | sim                         | não          |
| Doctor                          | `theforge doctor`        | `sparkforge-aws install doctor` | **não verificado**         | `apiforge doctor`          | `platformforge doctor`  | **não verificado**                                   | **não verificado**          | não          |
| Atualização nativa              | **não verificado**       | **não verificado**              | **não verificado**         | `--upgrade` (bootstrap)    | **não verificado**      | **não verificado**                                   | **não verificado**          | `npm`        |
| Desinstalação nativa            | **não verificado**       | **não verificado**              | **não verificado**         | **não verificado**         | **não verificado**      | **não verificado**                                   | **não verificado**          | não          |

## Operações nativas de ciclo de vida (confirmadas no código)

Segunda inspeção (leitura do parser de cada instalador). Todas aceitam
`--dry-run`; **nenhuma** das operações abaixo aceita `--yes` (aplicam quando
`--dry-run` está ausente). O forge-cli só as aciona com `--native`.

| Forja             | update                             | uninstall                             |
| ----------------- | ---------------------------------- | ------------------------------------- |
| the-forge         | `theforge install update`          | `theforge install uninstall`          |
| spark-forge-aws   | `sparkforge-aws update`            | `sparkforge-aws uninstall`            |
| spark-forge-azure | `sparkforge-azure install update`  | `sparkforge-azure install uninstall`  |
| api-forge         | `apiforge install update`          | `apiforge install uninstall`          |
| platform-forge    | `platformforge upgrade`            | `platformforge uninstall`             |
| forge-doctor-data | `forge-doctor-data install update` | `forge-doctor-data install uninstall` |
| forge-doctor-api  | não verificado                     | não verificado                        |
| forge-portal      | —                                  | —                                     |

Regras do forge-cli: sem `--yes`, `update --native` roda a operação com
`--dry-run`; `uninstall --native --yes` executa a desinstalação nativa
**antes** de remover o clone e preserva o clone se ela falhar.

## Flags adicionais do instalador nativo

| Forja             | `--host`       | `--gateway-profile` |
| ----------------- | -------------- | ------------------- |
| the-forge         | sim            | não verificado      |
| spark-forge-aws   | sim            | sim                 |
| spark-forge-azure | sim            | sim                 |
| api-forge         | sim            | sim                 |
| platform-forge    | não verificado | não verificado      |
| forge-doctor-data | não verificado | sim                 |

`forge-doctor-api` passou a usar o script documentado
`python scripts/forge_install.py install` (interpretador resolvido entre
`python3`, `python` e `py -3`).

Notas:

- A presença de `--scope`/`--profile`/`--components` foi confirmada no código
  do parser de cada instalador (`install/service.py`, `cmd_install.py`,
  `cli_install.py`, `install/cli.py`, `portable_cli.py`, `install_cmd.py`,
  `scripts/forge_install.py`). Os valores aceitos vieram de `choices=` no
  código.
- `forge-doctor-api` não expõe `install` como subcomando da CLI instalada na
  documentação inspecionada; o fluxo documentado é `python scripts/forge_install.py
install` ou `theforge install auto --scope workspace`. Por isso o catálogo
  **não** declara instalador nativo para ela (o forge-cli não simula suporte).
- `forge-portal` é Angular/Node: sem `setup.*`; o forge-cli usa `npm ci`/`npm
install` conforme a presença de `package-lock.json`.
- Atualização e desinstalação nativas não foram confirmadas; o forge-cli
  atualiza o checkout Git (`update`) e remove clones limpos com backup
  (`uninstall`), sem executar desinstaladores de terceiros.
- Cada repositório já possui `forge.json` (id, CLI, comando MCP). Pode ser
  consumido opcionalmente no futuro, nunca como requisito.
