# Cycle 12.1 — Windows Shell / Capability Audit

How installers and forge-cli detect OS and shell today; where PowerShell
is assumed; what Git Bash / WSL handling exists. Audit date: 2026-10-20.

## Per-repo shell assumptions

| Repo                | OS/shell detection                                                                                        | PowerShell assumed?                                                                                                                                                                | Git Bash handling                                                                                                                                                                                                                   | Windows CI                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| forge-cli           | `process.platform` branches; execa direct-spawn (no `shell:true`)                                         | **yes, at 4 sites** — `install.ts:86` (user PATH r/w), `preflight.ts:127-138` (**fatal** check `$PSVersionTable`), `discovery.ts:397-398`, `system.ts:37-47` (setup.ps1 selection) | **none** — `.sh` files ignored on win32 (`tests/system.test.ts:91-95`), `install.windows.sh` doesn't exist                                                                                                                          | GHA windows-latest in ci.yml                 |
| 7 Python forges     | `install.sh`: `${MSYSTEM:-}:${OSTYPE:-}` matches `*MSYS*\|*MINGW*\|*UCRT*\|*CYGWIN*` (`install.sh:16-19`) | `install.ps1` is PowerShell-only; `setup.ps1` likewise                                                                                                                             | **partial** — `install.sh` detects MSYS env and runs; bootstrap `_is_git_bash` (`forge_bootstrap.py:471-486`) writes **both** env.sh (POSIX style) and HKCU user env (`:597-608`, `winreg :505-535`, `cygpath` fallback `:489-502`) | ci matrix per repo                           |
| forge-portal        | n/a                                                                                                       | `scripts/check_i18n.py:29` mentions powershell (non-blocking)                                                                                                                      | n/a                                                                                                                                                                                                                                 | yes                                          |
| data-sentinel-forge | n/a — no installers                                                                                       | none found in src/                                                                                                                                                                 | n/a                                                                                                                                                                                                                                 | Linux/Windows/macOS CI (installation.md:5-6) |

## forge-cli PowerShell usage detail

```ts
// src/preflight.ts:127-138 — fatal on win32 for git-method flow:
execa('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion | Out-Null']); // !ok → block before mutation
```

```ts
// src/utils/system.ts:37-47 — win32 setup script candidates:
const WIN_SETUP_CANDIDATES = ['setup.ps1', 'install.ps1'];
// executed as: powershell.exe -NoProfile -ExecutionPolicy Bypass -File <file>
```

- `install.ts:86` PATH get/set via `[Environment]::SetEnvironmentVariable`
  — `psRun` returns null on failure → PATH add silently degrades to
  `false` (user gets manual guidance).
- `discovery.ts:397-398` probes `powershell.exe` for version display.
- **No `pwsh` distinction** anywhere — `powershell.exe` only; PowerShell 7
  (`pwsh.exe`) is never probed.
- **No cmd fallback**: `.cmd` shims are _emitted_ (`shims.ts:46-57`) but
  no installer logic runs through cmd.

## What exists for Git Bash today

- `install.sh` already runs under MINGW/MSYS and calls
  `forge_bootstrap.py --persist-env --allow-download`.
- Bootstrap handles Git-Bash env persistence: HKCU + `env.sh` + PATH
  guidance (`forge_bootstrap.py:597-608`), `_is_git_bash` detection.
- forge-cli **does not route** to `.sh` on Windows — the mechanism is
  there but unreachable from the CLI (`system.ts:17-18` hard-wires
  win32→.ps1 only).
- No detection of `bash.exe`/`git-bash` presence; no probe evidence.

## WSL / Cygwin / MSYS2

- `MSYSTEM` detection in `install.sh` covers MSYS|MINGW|UCRT|CYGWIN —
  one bucket, no distinction between Git Bash and other MSYS2 shells.
- WSL is never detected anywhere. `wsl.exe`/`WSL_DISTRO_NAME` unchecked.
- No test distinguishes Git Bash from MSYS2-from-other-origins.

## Gaps vs FASE 2 requirements

| Requirement                                                                    | Today                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Shell capability report {powershell, pwsh, bash, git_bash, wsl, cygwin, msys2} | **absent** — only powershell.exe probe at preflight                             |
| Windows route = PS → ps1, else Git Bash → install.windows.sh                   | routing hard-coded to .ps1; `install.windows.sh` **does not exist** in any repo |
| FORGE-SHELL-NOT-FOUND / -UNAVAILABLE                                           | no codes exist                                                                  |
| Probe evidence per capability                                                  | single boolean `powershell ok`                                                  |
| pwsh vs powershell                                                             | not distinguished                                                               |

## Existing Windows tests

- `tests/system.test.ts:62-124` — win32 script selection asserts `.ps1`
  chosen, `.sh` ignored on win32.
- `tests/preflight.test.ts:27-51` + `preflight-fail.test.ts:22-32` —
  powershell check fatal/warn severity, mocked execa.
- `tests/install.test.ts:157-201` — Windows PATH add/remove through
  mocked `powershell.exe`.
- `tests/registry-install.test.ts` — POSIX shim mode-bits conditioned on
  host `process.platform !== 'win32'`.
- the-forge `tests/test_install_orchestration.py` — `_fake_venv_python()`
  creates `Scripts/python.exe` on win32 hosts.
- **No test** simulates "PowerShell absent, Git Bash present".
