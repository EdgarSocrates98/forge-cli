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
