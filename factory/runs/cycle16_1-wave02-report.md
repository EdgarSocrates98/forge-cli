# Run — cycle16_1 wave-02 (forge-cli onboarding, detection, offline/gitless install, health checks)

Spec: `factory/specs/inbox/cycle16_1-wave02-forge-cli.md` (factory repo).
Branch: `cycle16_1/wave02` off `main` @ `4e100e4`.
Escopo: apenas `forge-cli`. Contratos `forge/*` inalterados (sem bump).

## Entregue

### 1. Onboarding runtime × workspace (UX/docs)

- `src/cmd/registry.ts`, `src/cmd/local.ts`: após instalação bem-sucedida
  (registry **ou** fonte local) uma nota `Runtime × workspace` explica
  que o que foi adquirido é o RUNTIME (venv + receipt em
  `~/.forge-cli/forges`, launcher em `~/.forge-cli/bin`) e que a
  ativação de capacidades é do `theforge install plan|apply` no
  workspace — ledger separado (`~/.forge/installations`). Só modo
  humano; `--json` segue limpo (`emitJson` sai antes).
- `src/ui/strings.ts`: `S.runtimeVsWorkspaceNote`/`Title` + linha na
  ajuda global (Extras).
- `src/cli-args.ts`: bloco contextual de `install --help` documenta
  skipped + a fronteira runtime × workspace.
- Docs: `docs/forge-cli-vs-theforge.md` (leitura do 2º ledger pelo
  doctor), `docs/installation.md` (seções "Detecção de instalação
  existente", "Saúde por runtime", "Offline verificável"),
  `docs/registry-state-contract.md` (seção wave-02),
  `docs/troubleshooting.md` (tabela de estados honestos),
  `README.md` (bullets registry), `CHANGELOG.md` (Unreleased).

### 2. Detecção de instalação existente — `skipped` honesto

- `src/cmd/registry.ts`: `InstallError.stage === 'already-installed'`
  (venv+receipt+state coerentes via `installConsistency`) sai como
  `RegistryInstallResult.skipped = 'already-installed'` com a versão —
  **nunca falha do lote**. A checagem precede resolução/fetch/
  subprocesso (gate em `registryInstall` antes de `resolveRelease`).
  Estado divergente continua `incomplete` com o reparo nomeado.
  Resumo conta `N já instalada(s) (skipped)` separado do ok/total.
- `RegistryInstallResult.skipped?: 'already-installed'` — campo novo,
  documentado; `optional_integrations`/JSON continuam intactos.

### 3. Health checks por runtime — `forge-cli doctor`

`src/doctor2/domains.ts` (`installationChecks`), IDs estáveis:

- `installation.runtime.<forja>` — matriz por Forja registrada:
  `installConsistency` + `bin` presente no disco + **`bin` dentro da
  venv** (receipts `pypi`) + `shim` registrado existente + campo `bin`
  obrigatório em receipt `pypi` (ausência = escrita truncada).
  Divergência → `warn` + `correctiveAction`, nunca `pass`.
- `installation.runtime.orphans` — varredura de
  `~/.forge-cli/forges/`: entradas que não são `state.json`,
  `.forge-lifecycle.lock` ou Forja registrada → `warn` (cobre o que
  `installConsistency` só denunciaria por nome).
- `installation.ledger.<id>` — por `~/.forge/installations/<id>.json`
  (ledger do theforge — **lido, nunca escrito**): manifest JSON válido;
  com `venv` declarada, `python.executable` e
  `environment.variables.<FORGE>_PYTHON` (prefixo pela mesma regra de
  `install/providers.py`: `[^A-Z0-9]+→"_"`, upper, strip) devem estar
  contidos na venv — o contrato wave-01 `<FORGE>_PYTHON`→launcher da
  venv; `cli.shim` absoluto deve existir. Cap defensivo de leitura
  (256 KiB). Manifest sem `venv` → passa com evidência "não se aplica".

### 4. Bugfix de baseline (pré-existente)

- `src/ui/theme.ts`: `setColorEnabled(true)` reatribuía a instância
  detectada no import (`pc`), que já é a variante desligada quando o
  ambiente não suporta cor — `set(true)` nunca religava ANSI. Agora
  cria `createColors(on)`. Corrige a falha de baseline
  `tests/ui-polish.test.ts > styledUsage … sem perder texto`
  (1292/1293 → 1306/1306).

### 5. Testes novos (+13)

- `tests/registry-install.test.ts` (+3):
  - "offline preparado: ZERO rede" — fetch sentinel que registra URL e
    explode (qualquer tentativa de rede falha o teste); sem
    `pip download`; `pip install` com `--no-index` +
    `--find-links <wheelhouse>`; `provenance.resolvedVia =
    'offline-cache'`; receipt gravado.
  - "receipt.bin dentro da venv" — regressão do contrato
    `<FORGE>_PYTHON` (bin/shim nunca apontam para o interpretador-base).
  - shim POSIX com espaços no caminho (Git Bash).
- `tests/registry-cmd.test.ts` (+2): install sobre instalação coerente
  → `{ok:true, skipped:'already-installed'}` com zero fetch/subprocesso
  e state intacto; instalação quebrada (state sem `install.json`) →
  `ok:false`, sem `skipped`, detalhe nomeia o reparo.
- `tests/doctor2.test.ts` (+8): runtime íntegro passa; launcher ausente
  / bin fora da venv / receipt pypi sem `bin` → warn; órfão → warn;
  manifest com python na venv → pass; `python.executable` +
  `API_FORGE_PYTHON` fora da venv → warn; manifest corrompido → warn.

## NO_CHANGE_REQUIRED (evidência de cobertura pré-existente)

| Item do spec | Evidência |
| --- | --- |
| Local sources (`install <dir>`) — "verify it works" | `src/source/install.ts` + `tests/local-source*.test.ts` + `tests/e2e-gitless.test.ts` (processo real, ciclo completo). Funcionava; só adicionamos a nota de onboarding pós-install. |
| Gitless (ZIP/cópia sem `.git`) | `tests/e2e-gitless.test.ts` — stub `git` no PATH registra ZERO invocações em install→status→doctor→update→repair→uninstall; `installConsistency` trata fonte sem `.git` como saudável por definição (comentário em `install.ts:557`). |
| Windows/Git Bash portability | `src/registry/shims.ts` — `.cmd` com `@echo off` + `%*`, recusa de aspas/newline; POSIX escapa `\` `"` `$` backtick; `tests/registry-install.test.ts` launchers (shim POSIX/.cmd/uninstall) + novo teste de espaços. Sem global pip: `python -m pip`/`python -m venv` via venv (install.ts). |
| Offline-verifiable: comportamento | `install.ts` — resolução offline usa metadados+wheel cache, `--no-index --find-links`, verificação sha256, locks `--offline --lock` (o que faltava era só o teste de zero-rede — adicionado). |
| Compat. manifest wave-01 (forma) | Nenhum campo de `forge/InstallationManifest/v1` foi criado/alterado — o doctor só LÊ o ledger do theforge. `python.executable = _venv_python(venv)` confirmado em `the-forge/src/theforge/_installkit.py:1557`. |
| Sem orquestrador de contexto | Nenhum verbo novo de workspace/ativação; a nota pós-install **desvia** explicitamente para `theforge install plan|apply`. |
| Error UX (padrão PROBLEM/CAUSA/ACTION) | Já estrutural: `FORGE-*` cause/remedy (local), `stage`+detail com reparo (registry), `correctiveAction` por check (doctor). Wave só estendeu a cobertura — ver `docs/troubleshooting.md` nova tabela. |
| Health `null` quando sem evidência | Modelo `doctor2` preservado (insufficient evidence → `value: null`, nunca fabricado). |

## Gates (pós-mudança, frescos)

| Gate | Comando | Resultado |
| --- | --- | --- |
| Testes | `npm test` (vitest run) | **77 arquivos / 1306 testes — 0 falhas** (baseline: 1292/1293, 1 falha pré-existente corrigida) |
| Lint | `npm run lint` (eslint .) | limpo |
| Tipos | `npm run typecheck` (tsc --noEmit) | limpo |
| Formato | `npm run format:check` (prettier --check .) | limpo (2 arquivos formatados pelo --write: `src/doctor2/domains.ts`, `docs/troubleshooting.md`) |
| Build | `npm run build` (tsup) | `dist/index.js` 1.08 MB, success |

Baseline: `4e100e4` — 1292/1293, falha pré-existente em
`tests/ui-polish.test.ts` (cor de tema desligada pelo ambiente) —
corrigida pelo fix de `setColorEnabled` acima (in-scope: teste da
suíte quebrado).

## Arquivos alterados

- `src/cmd/registry.ts` — skipped already-installed + nota onboarding.
- `src/cmd/local.ts` — mesma nota pós-install local (+ import `S`).
- `src/cli-args.ts` — ajuda contextual de `install`.
- `src/ui/strings.ts` — `S.runtimeVsWorkspace*` + linha Extras.
- `src/ui/theme.ts` — bugfix `setColorEnabled`.
- `src/doctor2/domains.ts` — helpers (`insideDir`, `envPrefix`,
  `MANIFEST_MAX_BYTES`) + checks `installation.runtime.*`,
  `installation.runtime.orphans`, `installation.ledger.*`.
- `tests/registry-install.test.ts` (+3), `tests/registry-cmd.test.ts`
  (+2), `tests/doctor2.test.ts` (+8).
- `README.md`, `CHANGELOG.md`, `docs/installation.md`,
  `docs/troubleshooting.md`, `docs/forge-cli-vs-theforge.md`,
  `docs/registry-state-contract.md`.

## Parciais honestos / limites

- O guard `<FORGE>_PYTHON` do doctor cobre `python.executable` e a var
  `environment.variables.<PREFIX>_PYTHON` **quando presentes** — um
  manifest sem `environment` mas com `venv` passa com evidência (o
  consumidor deriva o launcher da venv sozinho — caso correto).
- Portabilidade Windows é coberta por simulação de plataforma
  (`platform: 'win32'`, `.cmd`, espaços) — não há gate de hardware
  Windows real neste ciclo (mesma convenção das waves anteriores).
- Revisão independente: pendente de revisor humano/subagente —
  commits separados por área facilitam a revisão.
