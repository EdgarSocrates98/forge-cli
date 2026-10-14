# F0 Baseline Audit — forge-cli

Program: `prompt_evo_cli_portal.md` §1 (Fase Zero). Audited on 2026-10-14 against
the real `main` checkout — not against the roadmap's assumptions.

## §1.1 — Repository identity

| Item         | Value                                                                              | Evidence                                                                                    |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Branch       | `main`                                                                             | `git branch --show-current`                                                                 |
| HEAD SHA     | `f893bb0308f2c4016e024d7e21a2e9e79f09c64a`                                         | `git rev-parse HEAD`                                                                        |
| Remote       | `https://github.com/EdgarSocrates98/forge-cli.git`                                 | `git remote -v`                                                                             |
| Package      | `forge-cli@0.1.0` (private, bin `forge`)                                           | `package.json`                                                                              |
| History      | single squashed commit `f893bb0 Tornando repositório`                              | `git log --oneline` — the repo has exactly one commit; no granular history exists on `main` |
| Open PRs     | none                                                                               | `gh pr list` (authenticated)                                                                |
| Working tree | clean except untracked `nul` file (Windows NUL-redirection artifact, pre-existing) | `git status`                                                                                |
| Runtime      | Node ≥20, TS strict, ESM bundle via tsup                                           | `package.json`, `tsup.config.ts`                                                            |

In-flight work: none on `main`. Prior Loop Factory specs `lf-0002`…`lf-0013`
exist under `factory/specs/` (several in `active/`); they are unrelated to this
program and were left untouched. Branches like `codex/e2e-homolog-tui-2026-10-12`
exist remotely but are not on `main`.

## §1.2 — Quality gate results (run verbatim)

| Command                                     | Result | Evidence                                          |
| ------------------------------------------- | ------ | ------------------------------------------------- |
| `npm ci`                                    | OK     | node_modules populated, lockfile-honoring install |
| `npm run typecheck` (tsc --noEmit)          | OK     | clean, no output                                  |
| `npm run lint` (eslint .)                   | OK     | clean, no output                                  |
| `npm run format:check` (prettier --check .) | OK     | "All matched files use Prettier code style!"      |
| `npm test` (vitest run)                     | OK     | **26 test files, 296 tests, all passing**, ~24.5s |
| `npm run build` (tsup)                      | OK     | `dist/index.js` 472 KB ESM in ~187ms              |
| `npm run pack` (npm pack --dry-run)         | OK     | tarball 127.5 kB, 8 files, unpacked 523.2 kB      |

Environment limits recorded (§14.3): Windows host, Git Bash; no sandboxed
second machine for real-install E2E; no macOS host available — macOS paths
(paths in `install.ts`, `preflight.ts`) are code-reviewed, not executed.

## §1.2 — Mandatory inventory, walked file by file

### Entry & command resolution

- `src/index.ts` — single entrypoint: `parseCliArgs` → banner → optional
  interactive menu (`shouldShowMenu`/`applyMenu`) → `resolveCommand` →
  dispatch. Query commands (`doctor|list|status|help|components|versions|update --check`)
  exit early; mutating selections end in `runInstallFlow`. SIGINT → exit 130.
  `--json` suppresses the banner for query commands (line 54).
- `src/commands.ts` — vocabulary: `run`, `install`, `clone`, `update`, `list`,
  `status`, `versions`, `pin`, `unpin`, `rollback`, `reinstall`, `doctor`,
  `help`, `components`, `self-install`, `self-update`, `self-uninstall`,
  `uninstall`. `uninstall` without names + interactive → warns and degrades to
  self-uninstall (index.ts:160-164).
- `src/cli-args.ts` — flags: `--dir`, `--only`, `--ref`, `--plan`,
  `--skip-scripts`, `--skip-verify`, `--clone`, `--check`, `--clean`,
  `--retry-failed`, `--only-changed`, `--run-after-sync-failure`, `--shallow`,
  `--offline`, `--timeout`, `--retries`, `--jobs`, `--verbose`, `--json`,
  `--report`, `--trust-custom`, `--yes`, plus native flags `--profile`,
  `--scope`, `--components`, `--host`, `--gateway-profile`, `--native`.
  `isNonInteractive` drives all selection behavior.
- `src/config.ts` — optional `forge-cli.config.json` in target dir: `only`,
  `timeout`, `json`, `jobs`, `shallow` defaults; invalid config warns, never
  hard-fails (run.ts:80-82).
- `src/menu.ts`, `src/prompts.ts` — clack-driven TUI: action menu, workspace
  picker, repo multi-select with per-repo status, trust prompts for custom
  repos, confirm gate. `applyMenu` maps menu choices back to CLI options —
  same code path as flags.

### Execution core

- `src/cmd/run.ts` (`runInstallFlow`) — the full pipeline:
  `checkEnvironment` → resolve target dir → catalog merge → interactive
  `askRepos` + `reviewExecution` (prints `executionSummary` per repo, asks
  trust per custom repo) → `askConfirm` → pin resolution → `--clean`
  uninstall plans (requires `--yes`, refusal list enforced) → `--plan`
  renders `planLines` and returns without executing → `processPool`/`processBatch`
  → `renderReport` → interactive retry of errors → JSON report → exit code.
  Interactive mode forces `jobs=1` (line 204).
- `src/runner.ts` (`processRepo`) — per-repo lifecycle:
  clone/pull (`syncRepo`; shallow only when no ref; offline honored) →
  `checkoutRef` on pins (dirty tree blocks ref checkout) → dirty/remote-mismatch
  notes → `ensureEnvFile` → `copyConfigExamples` → `checkRepoPrereqs` →
  setup script (`findSetupScript`: `setup.sh`/`setup.ps1` variants) →
  `npm install` when `package.json` present → verify (`repo.verify` argv, or
  `forge.json` `cli --help` only for trusted repos, run **outside** the repo
  dir so a local binary cannot shadow PATH — runner.ts:203-213) → native
  install/update argv (`{python}` resolved via `resolvePython`).
  `untrusted` = custom origin without `--trust-custom`/interactive trust →
  scripts skipped. `deniedScripts` from the trust review also skip. Scripts
  never run after sync failure unless `--run-after-sync-failure`.
- `src/cmd/batch.ts` — sequential per-repo execution with task log limit.
- `src/cmd/query.ts` — `doctor`, `list`, `status`, `versions`,
  `update --check` renderers with `--json` support.
- `src/cmd/manage.ts` — `pin`/`unpin` (state.json), `rollback` (git checkout
  to recorded `previousHead` only), `uninstall` (planUninstall →
  executeUninstall), `self-install`/`self-update`/`self-uninstall`.

### Safety & environment

- `src/safety.ts` — `isSafeRepoName` regex, `isSafeRepoUrl` (https w/o
  credentials, ssh, scp-like), `resolveInside` path-containment,
  symlink/junction detection, `redactSecrets` (gh* tokens, URL credentials,
  `*_TOKEN|SECRET|PASSWORD|API_KEY` vars, auth headers), `writeFileAtomic`.
- `src/env.ts` — `.env` policy: **never overwrites** — existing `.env` kept;
  `.env.example` copied when absent; stub with commented `envKeys` otherwise.
- `src/configs.ts` — copies `*.example`/`*.sample` config files, skipping
  targets that already exist.
- `src/prereqs.ts` — reads `pyproject.toml` `requires-python` and
  `package.json` `engines`; probes real interpreters (`pythonCandidates` per
  platform), `pip`, `venv`, `npm`; semantic spec matching (`>=`, `<=`, `!=`…).
- `src/preflight.ts` — Node ≥20 gate (`isNodeSupported`), Python discovery
  per platform (py launcher, python3, python on Windows).
- `src/manifest.ts` — optional `forge.json` (≤64 KiB): `forge_id`, `cli`,
  `mcp_command`. Strictly validated; only used when repo lacks a declared
  `verify` and is trusted.
- `src/lifecycle.ts` — `planUninstall` refuses: unsafe name, symlink/junction,
  non-git dir, remote URL mismatch, dirty tree (unless `--clean` plan
  proceeds with backup). Backs up `.env` + example-derived configs to
  `.forge-cli/backups/<ts>/`. `rollbackRepo` resets **checkout state only**
  to recorded head — does not claim to reverse external installer effects.
- `src/artifacts.ts` — `.forge-cli/` under target dir: `state.json`
  (status/detail/at/head/previousHead/phase per repo + pins), `logs/`
  (secret-redacted per-line stream), `reports/` JSON, `backups/`.
  `loadCustomRepos` merges `forge-cli.repos.json` custom entries with the same
  name/URL validation as the built-in catalog.
- `src/git-revs.ts` — ref validation, semver-ish compare, `updateCheck`,
  `localTags`/`remoteTags`, `checkoutRef` returning resolved SHA.
- `src/status.ts` — `collectStatus` merges filesystem + `state.json` into
  per-repo `InstallPhase` (cloned/prepared/installed/validated/failed…).
- `src/self.ts` + `src/install.ts` — self-install: `~/.forge-cli/bin` bundle +
  shim, PATH guard blocks in `~/.bashrc`/`zshrc`/`fish`, Windows registry
  PATH add/remove, `detectInstallMethod` (npm-global vs bundled vs dev) for
  `planSelfUpdate`.
- `src/constants/repos.ts` — catalog of 8 entries: the-forge, spark-forge-aws,
  spark-forge-azure, platform-forge, api-forge, forge-doctor-api,
  forge-doctor-data, forge-portal. Each declares `kind`, `verify` argv, and
  (all but forge-portal) `nativeInstall`: command argv + supported flags +
  update/uninstall ops. api-forge also declares `envKeys`
  (`APIFORGE_HOME`, `APIFORGE_CONFIG`, `APIFORGE_CACHE`).

### Bootstrap vs native install — the §1.2 special question, verified in code

Two distinct behaviors exist on `main`:

1. **Bootstrap (default)** — `runInstallFlow` → `processRepo` always runs the
   clone → env → configs → prereqs → `setup.sh|setup.ps1`/`npm install` →
   verify sequence. This is the historical path; it does **not** perform
   product-level native install.
2. **Native product install** — only when a native-selection flag is present
   (`--profile`, `--scope`, `--components`, `--host`, `--gateway-profile`,
   `--native`; see `hasNativeRequest` in `src/native-install.ts`). The argv
   comes from `repo.nativeInstall.command` per catalog entry, and is invoked
   with `--dry-run` appended unless `--yes` (approve) is supplied —
   verified in `buildNativeInstall` + `runNative` (runner.ts:232-266).
   `update --native` maps to `nativeInstall.ops.update`; repos without an ops
   entry degrade to a warning (`S.nativeUnsupported`), never a fabricated run.

So: **bootstrap-only unless native flags are passed; native defaults to
dry-run unless `--yes`.** This matches `docs/capabilities.md` exactly.

### Docs

- `docs/capabilities.md` — accurate and current: documents the two-phase
  model, catalog SHAs, native flag support matrix per Forja.
- `docs/arquitetura.md`, `docs/solucao-de-problemas.md` — architecture +
  troubleshooting, Portuguese, consistent with code.
- `README.md`, `CHANGELOG.md`, `LICENSE` — present; README matches flags.

## Integration points evaluated

| Surface                     | Finding                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the-forge `install` surface | `src/theforge/cli/commands.py` exposes `cmd_install_plan`, `cmd_install_lifecycle`, `cmd_install_wizard`, `cmd_portal`, `cmd_doctor` — matches `nativeInstall` argv in repos.ts:11-18 |
| api-forge                   | `apiforge install`, `apiforge doctor`, `apiforge portal` (cli_portal.py) — matches repos.ts:68-77                                                                                     |
| spark-forge-aws/azure       | `install/cli.py` + adapters/cli.py exist; `install`, `update`, `uninstall` declared — matches repos.ts:26-47                                                                          |
| platform-forge              | `platformforge install/upgrade/uninstall` — matches repos.ts:54-60                                                                                                                    |
| forge-doctor-data           | `forge-doctor-data install …` — matches repos.ts:100-109                                                                                                                              |
| forge-doctor-api            | no in-package install engine by design (RC, no-network core); CLI uses `{python} scripts/forge_install.py install                                                                     | update | uninstall`— matches repos.ts:84-92 and real`scripts/forge_install.py` |
| forge-portal                | `kind: node`, verify `npx --no-install ng version`, no nativeInstall — correct: portal is not a product-installed Forja here, it is cloned + `npm install`                            |
| `forge.json` manifest       | read strictly-bounded, only honored for trusted repos lacking `verify` — trust boundary respected                                                                                     |

## What the audit did NOT execute (recorded honestly)

- No real `--yes` native install against live Forjas (mutating; out of F0 scope).
- No macOS/Linux host run — `install.ts` Windows/POSIX paths reviewed statically.
- No `--execute` agent dispatch; CLI binary itself was not exercised end-to-end
  as an installed shim (self-install would mutate `~/.forge-cli`).

## Snapshot verdict

forge-cli on `main` is **substantially more mature than §0.4 assumed**:
plan→confirm→execute with immutable-ish plan rendering, dry-run-gated native
ops, trust model for custom repos, `.env` preservation, prereq engine,
rollback-by-recorded-head, redacted logs, JSON reports, 296 tests.
Gaps vs the program (recommendation engine, `.env` validation/migration,
cross-repo orchestration, offline bundle, self-healing classes, receipts
schema) are enumerated in `CAPABILITY_GAP_MATRIX.md`.
