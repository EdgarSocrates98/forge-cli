# Cycle 12.1 — Python Discovery Audit

Every Python discovery path in installers and forge-cli; what happens when
python is off-PATH. Audit date: 2026-10-20.

## Discovery implementations found

### 1. forge_bootstrap.py (all 7 Python forges, canonical in the-forge)

Priority pipeline (`forge_bootstrap.py:190-249`):

1. `--python` explicit flag → validated against `forge.json` python spec
   (`:190-197`)
2. PATH scan via `command -v`/`shutil.which` equivalents:
   - Windows: `py -3.9` … `py -3.14`, then `python`, `python3`
     (`:199-233`)
   - POSIX: `python3.9` … `python3.14`, `python3`, `python`
3. `sys.executable` re-query so the `py` launcher pin isn't lost (`:230`)
4. `uv python install` — only under `--allow-download` (`:236-249`)

Validation: **version spec check executed** against the spec string in
`forge.json` (`python: ">=3.10"`, `">=3.11"`, `">=3.12"` per forge).
`sys.executable` is **not** an interpreter _source_ — it only pins the
version the launcher resolved to.

### 2. install.sh (all 7 forges)

```bash
# install.sh:25-35 — simple presence loop:
for c in python3 python py; do command -v $c && …
# py → invoked as `py -3`
```

No version floor check at the shell level — delegates to bootstrap.
Works under MSYS (MSYSTEM-detected at `:16-19`) because `command -v`
behaves the same.

### 3. install.ps1 / setup.ps1 (all 7 forges)

`Get-Command python3, python, py` (install.ps1:12-22, setup.ps1:5-10) —
`py` invoked with `-3`. Same delegates-to-bootstrap model.

### 4. setup.sh (all 7 forges)

`command -v python3 || python || py` (setup.sh:5-10) — 10-line wrapper.

### 5. forge-cli preflight (`src/preflight.ts`)

```ts
// :19-35 — candidates by platform:
win32 → ['py','-3.14']…['py','-3.10'], 'python', 'python3', 'py'
POSIX → 'python3.14'…'python3.10', 'python3', 'python'
```

- `pythonVersion` = first candidate printing `--version` (`:43-57`) —
  **executed probe**, not string parse.
- Toolchain probe: pipx → uv → `python -m pip` → pip3 → pip (`:74-86`).
- `probePythons` (`cmd/registry.ts:54-71`): probes ALL candidates, dedups
  by parsed version, newest-first; `selectInterpreter`
  (`registry/install.ts:533-575`) filters by `requires_python` +
  `minPython` floor.
- `resolvePython()` (`utils/system.ts:96-101`) — `python3`, `python`,
  `py -3` — used for `{python}` placeholders in native ops.

### 6. data-sentinel-forge

No installer — `uv sync`/`pip install .` documented; `.python-version`
pins `3.12` (`pyproject.toml:6-7`).

## What's NOT discovered today

| Source                                | forge-cli                            | bootstrap                 | Notes                             |
| ------------------------------------- | ------------------------------------ | ------------------------- | --------------------------------- |
| `FORGE_PYTHON` env var                | ✗                                    | ✗                         | proposed contract                 |
| `--python` CLI flag                   | ✗ (registry path selects internally) | ✓                         | flag exists in bootstrap only     |
| `py` launcher with `-X.Y`             | ✓ (win32)                            | ✓                         | both probe `-3.N` pins            |
| PATH `python3/python`                 | ✓                                    | ✓                         |                                   |
| Active venv (`VIRTUAL_ENV`, `.venv/`) | ✗                                    | ✗                         | no env detection                  |
| pyenv / uv / conda / asdf shims       | ✗ (except uv toolchain probe)        | ✗ (uv only for _install_) | manager dirs not enumerated       |
| `~/AppData/Local/Programs/Python/*`   | ✗                                    | ✗                         | corporate default location missed |
| `/usr/local/bin`, `/opt/*/bin`, brew  | ✗ (PATH only)                        | ✗                         | non-PATH dirs unenumerated        |
| Windows registry uninstall keys       | ✗                                    | ✗                         | never read                        |
| Conventional dirs near repo           | ✗                                    | ✗                         |                                   |

## Confirmed failure modes (python off-PATH)

1. **Corporate python in AppData** (not on PATH): bootstrap PATH scan
   misses it → falls to `uv python install` only with `--allow-download`;
   without flag → hard failure. forge-cli preflight reports `python` not
   found → git-method flow warns/blocks.
2. **Windows Store stub** (`python.exe` in WindowsApps): `command -v`
   finds it, `--version` probe returns exit 0 with stub text or opens
   Store — **neither implementation distinguishes it**; forge-cli's
   `--version` probe may capture stub output as a "version" (string
   parse, not semantic validation).
3. **Broken/shim-loop python**: `command -v` succeeds, `--version` probe
   in forge-cli returns !ok → candidate skipped (good); bootstrap's spec
   check would also fail it (good) — but error message is generic, no
   FORGE-PYTHON-UNEXECUTABLE taxonomy.
4. **Multiple pythons**: forge-cli dedups by version, picks newest
   compatible (deterministic); bootstrap picks first match in scan order
   (`3.14`→`3.9` = newest-first, deterministic).

## Gaps vs FASE 4

- No `FORGE_PYTHON`/`--python` override in forge-cli (bootstrap has flag).
- No off-PATH enumeration (registry keys, manager dirs, AppData).
- No Store-stub detection (WindowsApps path + probe-behavior check).
- Error taxonomy: `FORGE-PYTHON-NOT-FOUND`, `-INCOMPATIBLE`,
  `-UNEXECUTABLE` don't exist — current messages are ad-hoc.
- Receipt: bootstrap writes `platform{python}` string only; no
  `python{source,version,executable,selection_reason}` object.

## Existing tests

- `tests/preflight.test.ts:61-73` — candidate ordering assertions.
- `tests/preflight-fail.test.ts:22-32` — execa rejection → `!ok` verdict.
- `tests/registry-install.test.ts` — `selectInterpreter` floor/cap
  filtering with injected probes.
- the-forge `tests/test_installkit_bootstrap.py` — semver/spec checks,
  `--python` override path.
- **No test** exercises AppData/registry/pyenv/shim discovery or Store stubs.
