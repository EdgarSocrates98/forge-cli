# Cycle 12.1 — Corporate/Scenario Compatibility Matrix

Status of each target scenario from prompt_evo_install.md §OBJETIVO,
per repo. `confirmed` = verified in code+tests today; `broken` = code path
exists but fails; `untested` = no evidence either way. Audit 2026-10-20.

Legend: T=the-forge, A=api-forge, P=platform-forge, W=spark-forge-aws,
Z=spark-forge-azure, DA=forge-doctor-api, DD=forge-doctor-data,
C=forge-cli, PF=forge-portal, DS=data-sentinel-forge.

## Scenario matrix

| #   | Scenario                              | C           | T           | A           | P           | W           | Z           | DA          | DD          | PF  | DS       |
| --- | ------------------------------------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | --- | -------- |
| 1   | PyPI/registry install                 | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | n/a | broken*  |
| 2   | git clone → installer                 | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | n/a | n/a      |
| 3   | GitHub ZIP (gitless, intact)          | **broken**  | confirmed** | confirmed** | confirmed** | confirmed** | confirmed** | confirmed** | confirmed** | n/a | n/a      |
| 4   | Copied dir (no .git)                  | **broken**  | confirmed** | confirmed** | confirmed** | confirmed** | confirmed** | confirmed** | confirmed** | n/a | n/a      |
| 5   | Gitless, partial manifest             | broken      | untested    | untested    | untested    | untested    | untested    | untested    | untested    | n/a | n/a      |
| 6   | Windows + PowerShell                  | untested-CI | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | n/a | untested |
| 7   | Windows + Git Bash, **no PowerShell** | **broken**  | untested    | untested    | untested    | untested    | untested    | untested    | untested    | n/a | n/a      |
| 8   | Python outside PATH (corporate)       | **broken**  | broken      | broken      | broken      | broken      | broken      | broken      | broken      | n/a | untested |
| 9   | Multiple Linux pythons                | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | n/a | n/a      |
| 10  | Restricted perms / no global install  | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | confirmed   | n/a | untested |

\* data-sentinel-forge is published on neither PyPI nor npm (checked
2026-10 publication run — not in the 8 published packages).
\** bootstrap-level only: `install.sh` on a gitless dir works because
`forge.json` suffices and `git` calls are best-effort — but there is no
classification, receipt marking, or forge-cli path to it.

## Per-scenario evidence

1. **PyPI**: all 8 dists live (theforge-core 0.5.5, theforge-cli 0.2.4
   npm, apiforge-af 0.1.4, platformforge 0.1.4, sparkforge-aws 0.5.5,
   sparkforge-azure 0.1.4, forge-doctor-api 0.2.4, forge-doctor-data 1.0.4).
   forge-cli `--method registry` = default for `install`.
2. **git clone**: `syncRepo` clone/pull + `findSetupScript` →
   `.ps1`/`.sh` per platform; `install.sh`→bootstrap→wheel-first.
3. **ZIP/gitless**: forge-cli `install <dir>` exits 2 (arg not in
   registry catalog — `cmd/registry.ts:293-298`); `.sh` on a gitless dir
   works only if the user runs it manually.
4. Same as 3 — copied dirs are gitless dirs.
5. Partial manifest: `manifest.ts` validates shape; bootstrap refuses
   missing required fields — but no GITLESS_PARTIAL state; untested
   end-to-end.
6. Windows+PS: `preflight.ts` fatal-checks powershell.exe on win32;
   `.ps1` scripts selected on win32; CI green on windows-latest for
   forge-cli, api-forge, the-forge, doctors (post-2026-10-20 fixes).
7. **No-PS+GitBash**: forge-cli preflight exits before anything else;
   `.sh` never selected on win32; `install.windows.sh` doesn't exist —
   **the flagship Cycle 12.1 gap**.
8. **Python off-PATH**: all discovery is PATH-only + `py` launcher;
   AppData/registry/manager dirs unenumerated. Both forge-cli and
   bootstrap fail → the flagship gap on Linux too.
9. Multiple pythons: forge-cli `probePythons` dedups + picks newest
   compatible; bootstrap scans `3.14→3.9` newest-first. Deterministic.
10. Restricted perms: bootstrap venv installs in `<install>` user dirs;
    POSIX env.sh + guarded rc blocks; HKCU (not HKLM) on Windows;
    `FORGE-INSTALL-PERMISSION-DENIED` code doesn't exist yet — failures
    are generic.

## Confirmed limitations (explicit, for later specs)

- forge-cli local-dir install: **feature absent** — needs lf-0015.
- Shell capability report / Git Bash routing: **absent** — needs lf-0016.
- `install.windows.sh`: **does not exist anywhere** — needs lf-0018.
- Off-PATH python: **absent** — needs lf-0017.
- Real Windows corporate E2E: not reproducible on this machine —
  lf-0019 records the open question.
