# Acceptance report — ciclo 12.1 (lf-0019)

Mapa dos dez cenários do `prompt_evo_install.md` §OBJETIVO para o estado
real de cobertura. Convenção de honestidade (grill gate): `verified` =
exercitado de verdade pela suíte/CI citada; `simulated` = comportamento
provado por injeção/simulação em runner real, sem hardware equivalente;
`blocked` = não executável neste ambiente.

## Tabela de cenários

| #   | Cenário                                    | Status        | Evidência                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Instalação via PyPI                        | **verified**  | Fluxo registry coberto por `tests/registry-install.test.ts`, `tests/install.test.ts`, `tests/independence.test.ts` (venv isolada, pin de versão, receipts `install.json`/`state.json`, verify do bin). Download PyPI real não roda na suíte por desenho offline — recusa honesta quando o artefato não está no wheelhouse é testada.                                                                                                |
| 2   | Instalação via `git clone`                 | **verified**  | Fluxo git coberto por `tests/e2e-cli.test.ts` (processo real, `git init`/`commit` em fixtures locais) e `tests/lifecycle-matrix.test.ts` (clone→pull→update→rollback→uninstall contra bare repos reais).                                                                                                                                                                                                                            |
| 3   | ZIP do GitHub                              | **verified**  | ZIP extraído é, por definição, diretório sem `.git` — mesmo caminho do E2E `tests/e2e-gitless.test.ts` (`acme-forge-1.0.0/` nomeado como extração GitHub). `install`→receipt→status→doctor→update→repair→uninstall passa em processo real. O download do ZIP em si não é exercitado (fs trivial).                                                                                                                                   |
| 4   | Pasta copiada manualmente                  | **verified**  | `cp -r`/`xcopy` produz o mesmo estado filesystem: `install <dir>` cobre (`tests/e2e-gitless.test.ts`, `tests/local-source.test.ts`).                                                                                                                                                                                                                                                                                                |
| 5   | Diretório existente sem `.git`             | **verified**  | `GITLESS_VALID_FORGE`/`GITLESS_PARTIAL_FORGE` instaláveis; recusas `UNKNOWN_DIRECTORY`/`INVALID_MANIFEST`/`CONFLICTING_IDENTITY`/`UNTRUSTED_SOURCE` cobertas em `tests/source-detect.test.ts` e `tests/local-source-negative.test.ts` (21 testes de recusa).                                                                                                                                                                        |
| 6   | Windows + PowerShell                       | **simulated** | Rota `powershell.exe`→`.ps1` verificada por injeção de `winShells` em `tests/env-discover.test.ts` (630+); na perna `windows-latest` da matriz a descoberta real encontra `powershell.exe` e seleciona a rota. Install completo de Forja real em Windows não roda em CI — vazio registrado abaixo.                                                                                                                                  |
| 7   | Windows sem PowerShell, Git Bash permitido | **simulated** | Gate CI `.github/workflows/ci.yml` "rota Git Bash com PowerShell fora do PATH (simulada)": PATH mascarado no runner `windows-latest` → `env discover --json` precisa retornar `route.selected=git_bash` e `script_chain[0]=install.windows.sh`. Unidade: `winShells={bash}`→`install.windows.sh` via bash.exe (`tests/env-discover.test.ts`); `bash -n install.windows.sh` nos 8 repos.                                             |
| 8   | Python corporativo fora do PATH            | **verified**  | Estágios explícitos do pipeline: `FORGE_PYTHON` vence `--python`, explícito inválido é recusa dura (`tests/env-python.test.ts` 76-159). `--python` chega ao install local/registry (`src/cmd/local.ts`, `src/index.ts`).                                                                                                                                                                                                            |
| 9   | Linux com vários Pythons                   | **verified**  | Seleção "maior versão compatível, nunca a primeira do PATH", estável > pré-release, piso `>=3.10`, ranges compostos, dedup por realpath, teto de 32 candidatos (`tests/env-python.test.ts` 161-341).                                                                                                                                                                                                                                |
| 10  | Rede/permissão/global restritos            | **verified**  | Fonte local = zero rede por construção (`expectNoGitOrNet` + stub `git` de PATH no E2E). `--offline` do registry testado; alvos de escrita negados → `FORGE-INSTALL-PERMISSION-DENIED` (`tests/env-discover.test.ts`, read-only real em POSIX); `.env` falhando → `FORGE-ENV-PERSISTENCE-FAILED` (`tests/local-source-negative.test.ts`). Máquina sem rede de verdade não é exercitada — o contrato é a ausência de spawn, provada. |

## Vazio registrado: E2E Windows corporativo real

Decisão do grill (2026-10-20): o E2E em hardware Windows + AD real foi
explicitamente substituído por simulação de CI + ação humana documentada.
O proxy aprovado é `windows-latest` + PATH mascarado (passo "rota Git
Bash com PowerShell fora do PATH (simulada)" em
`.github/workflows/ci.yml`) — prova a seleção de rota no runner real,
não a instalação corporativa completa.

**Ação humana pendente (reversível):** executar, numa máquina Windows
corporativa real com PowerShell bloqueado por política e Git for Windows
permitido, `forge-cli env discover --json` (deve retornar
`route.selected="git_bash"`) seguido de `forge-cli install <dir>` de uma
fonte gitless — e arquivar a saída. Um runner Windows real pode
substituir o proxy depois sem mudança de código.

## Portal (forge-portal)

Avaliado: Angular + `portal_core/` Python vendored via
`scripts/vendor.py`; **não há superfície de instalador nem doc/manifesto
declarando métodos de instalação** — `portal_core/registry_ops.py`
delega a `forge-cli <op> --method registry`, e `docs/installation/`
documenta o contrato plan→review→confirm do portal, não rotas de shell.
Nenhuma alteração foi feita (e nenhuma era requerida pelo escopo "docs/
manifest only" — não havia superfície a atualizar). `data-sentinel-forge`
intocado conforme o spec.

## Rollout (FASE 10)

| Repo                | `install.windows.sh` | `forge_bootstrap.py` sha256                      | CI `bash -n`       |
| ------------------- | -------------------- | ------------------------------------------------ | ------------------ |
| the-forge           | ✔ (3.11)             | `c9d1d583…8938fc`                                | `ci.yml` test job  |
| api-forge           | ✔ (3.12)             | `c9d1d583…8938fc`                                | `ci.yml`           |
| platform-forge      | ✔ (3.10)             | `c9d1d583…8938fc`                                | `ci.yml`           |
| spark-forge-aws     | ✔ (3.10)             | `c9d1d583…8938fc`                                | `ci.yml` os-matrix |
| spark-forge-azure   | ✔ (3.10)             | `c9d1d583…8938fc`                                | `ci.yml` full job  |
| forge-doctor-api    | ✔ (3.11)             | `c9d1d583…8938fc`                                | `quality.yml`      |
| forge-doctor-data   | ✔ (3.11)             | `c9d1d583…8938fc`                                | `ci.yml`           |
| forge-cli           | ✔ (3.11)             | — (não é Forja Python; shim vendored para teste) | `ci.yml`           |
| forge-portal        | ausente por desenho  | —                                                | —                  |
| data-sentinel-forge | **excluído**         | **excluído**                                     | **excluído**       |

As 8 cópias de `forge_bootstrap.py` (canônica `the-forge/scripts/
installkit/` + 7 vendored `scripts/`) são byte-idênticas:
`c9d1d583696f943cf31489941d0f3beeb935042d7cf77aa875506001848938fc`.
O shim `install.windows.sh` difere entre repos apenas na mensagem de
piso de Python (`>=3.10/3.11/3.12`), casada com o `requires-python` de
cada Forja — parametrização legítima, não drift.

## Verificação executada

Resultados da rodada final (2026-10-20, host Linux do desenvolvedor):

- `npx tsc --noEmit` — limpo (exit 0).
- `npm run build` — `dist/index.js` ~984.7 kB, exit 0.
- `npm test` — 1169/1170 passando; 1 falha transitória em
  `tests/git-revs.test.ts` (`ENOTEMPTY` no `afterEach` de tmpdir —
  race de cleanup, arquivo intocado por este ciclo); re-run isolado
  14/14 verde.
- `npm run lint` (eslint) — limpo.
- `npm run format:check` (prettier) — limpo após `--write` nos 7
  arquivos novos/editados.
- `npm run coverage` — exit 0, suíte completa verde (inclui os novos
  `local-source-negative` 21/21 e `e2e-gitless` 3/3 em processo real;
  stub `git` de PATH registra ZERO operação de repo em todo o ciclo
  gitless, incluindo status/doctor).
- the-forge: `.venv/bin/python -m pytest tests -k "install or env" -q`
  — 388 testes, todos verdes (exit 0).
- `bash -n install.windows.sh` — OK nos 8 arquivos (7 Forjas Python +
  shim vendored do forge-cli; forge-portal sem o arquivo por desenho).
- `sha256sum` das 8 cópias do bootstrap — 1 hash único
  (`c9d1d583…8938fc`); `_SOURCE_SHA256` dos 6 installkits vendored
  uniforme (`bc189dd2ae0028ce`).
- YAML dos 8 workflows editados — `yaml.safe_load` OK.
- Gates de CI novos (`bash -n` + simulação sem-PowerShell) só podem ser
  considerados verdes quando o GitHub Actions rodar — localmente a
  sintaxe e a lógica de probe foram verificadas, mas o runner Windows
  real é evidência pendente do primeiro push/PR.
