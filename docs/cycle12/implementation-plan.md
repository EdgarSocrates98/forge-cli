# Cycle 12.1 — Implementation Plan (audit → spec mapping)

Maps prompt_evo_install.md FASE 1–13 to concrete files/owners and the
inbox specs (`factory/specs/inbox/lf-0014..lf-0019`). Audit 2026-10-20.

## Architecture decision derived from the audit

The 7-Forge Python bootstrap (`forge_bootstrap.py`, byte-identical sha256
`dbcc32…`) already tolerates gitless dirs — `forge.json` is the identity,
`git` is a best-effort stamp. **All Cycle 12.1 classification/routing
work lands in forge-cli + the shell-script surface**; the bootstrap needs
only receipt-field extensions and an `install.windows.sh` path.

| Layer                                     | Changes needed                                                                                                                  | Spec              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| forge-cli (TS)                            | directory-state classifier, local-path install, gitless lifecycle verbs, shell env discovery, python pipeline, FORGE-* taxonomy | lf-0015/0016/0017 |
| shell surface                             | NEW `install.windows.sh` (Git Bash native); shared InstallReceipt contract; env persistence parity                              | lf-0018           |
| forge_bootstrap.py (canonical, the-forge) | receipt `python{}`/`environment{}`/`source_trust` fields; gitless stamps                                                        | lf-0018           |
| vendored copies (7 forges)                | re-vendor via `scripts/installkit/vendor.py` + `_SOURCE_SHA256` restamp                                                         | lf-0019           |
| tests + CI                                | ubuntu+windows matrix, git-bash steps, simulated no-PS E2E                                                                      | lf-0019           |
| docs                                      | install guides per scenario, FORGE-* troubleshooting, acceptance report                                                         | lf-0019           |

## FASE → spec mapping

| FASE | Content                                      | Spec    | Owner repo(s)                                   |
| ---- | -------------------------------------------- | ------- | ----------------------------------------------- |
| 0    | Audit (this doc set)                         | lf-0014 | forge-cli docs                                  |
| 1    | Gitless states, identity A/B/C, op semantics | lf-0015 | forge-cli `src/`                                |
| 2    | Shell capability discovery                   | lf-0016 | forge-cli `src/`                                |
| 3    | `install.windows.sh`                         | lf-0018 | vendored to all forges via the-forge installkit |
| 4    | Python discovery pipeline                    | lf-0017 | forge-cli + bootstrap `--python` alignment      |
| 5    | Preflight 2.0 aggregate report               | lf-0016 | forge-cli `src/preflight.ts`                    |
| 6    | Path selection matrix                        | lf-0016 | forge-cli `src/`                                |
| 7    | Shared installer contract                    | lf-0018 | installkit canonical + vendored                 |
| 8    | Env persistence + FORGE-* errors             | lf-0018 | all entry points                                |
| 9    | Positive+negative tests                      | lf-0019 | per-repo suites                                 |
| 10   | Rollout to forges                            | lf-0019 | vendor.py re-vendor                             |
| 11   | CI gates (ubuntu+windows)                    | lf-0019 | ci.yml matrices                                 |
| 12   | Docs + portal surface                        | lf-0019 | docs/ + forge-portal manifest                   |
| 13   | Acceptance                                   | lf-0019 | `docs/cycle12/acceptance-report.md`             |

## Sequencing (dependencies)

```
lf-0014 audit ──┬─► lf-0015 gitless states (forge-cli classifier)
                ├─► lf-0016 shell/env discovery + preflight 2.0
                ├─► lf-0017 python pipeline (needs lf-0016 env contract
                │              for reporting channel)
                └─► lf-0018 install.windows.sh + shared contract
                     (needs lf-0016 routing + lf-0017 interpreter select;
                      bootstrap change lands in the-forge first)
                          │
                          ▼
                lf-0019 tests/CI/rollout/docs (needs all above)
```

lf-0015, lf-0016 can proceed in parallel; lf-0017 and lf-0018 depend on
lf-0016's discovery contract shape; lf-0019 is strictly last.

## Concrete file targets (from audit)

**forge-cli new/modified:**

- `src/source/detect.ts` (new) — 8-state classifier + identity levels
- `src/env/discover.ts` (new) — `forge/EnvironmentDiscovery/v1` + shells
- `src/env/python.ts` (new) — discovery pipeline + validation
- `src/preflight.ts` — aggregate into report, keep fatal-only-in-flow
- `src/registry/install.ts` — accept `LocalSource` input; local bootstrap
- `src/lifecycle.ts`, `src/doctor*.ts`, `src/cmd/query.ts` — gitless verbs
- `src/errors.ts` (new or extend) — FORGE-* code taxonomy
- `src/receipts.ts` — `forge/InstallReceipt/v1` shared schema
- `src/utils/system.ts` — win32 script selection gains `install.windows.sh`

**the-forge (canonical, then vendored):**

- `install.windows.sh` (new template at repo root + installkit)
- `scripts/installkit/forge_bootstrap.py` — `python{}`/`environment{}`/
  `source_trust` receipt fields
- `scripts/installkit/vendor.py` — add `install.windows.sh` to the
  vendored set

**7 forges**: re-vendored `install.windows.sh` + `forge_bootstrap.py` +
`forge.json` (if fields added); own suites unaffected.

**forge-portal**: docs/manifest only (no Python install path — audited).

**data-sentinel-forge**: EXCLUDED — other CLI owns it; audit recorded.

## Open question carried to lf-0019

FASE 9.5 demands real Windows corporate E2E. This machine is Linux; GHA
`windows-latest` cannot truly remove PowerShell. Proxy = PATH/policy
simulation + `shell: bash` steps. **Owner decision needed**: accept
simulated E2E + documented manual procedure, or provide a Windows
runner. lf-0019 `grill: pending` until answered.
