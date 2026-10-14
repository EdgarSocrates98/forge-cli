# Compatibility matrix — verified at F0

Program: `prompt_evo_cli_portal.md`. Rows are evidence-based; `U` =
unverifiable in this environment (recorded honestly, §14.3).

## 1. Run environments

| Environment | forge-cli | forge-portal backend | Angular build | Evidence |
|---|---|---|---|---|
| Windows 11 + Node ≥20 + Git Bash | ✅ verified | ✅ verified | ✅ verified | all F0 commands ran here |
| Windows + PowerShell | ✅ (setup.ps1 path exists; self-install registry PATH covered) | ✅ (stdlib) | ✅ | code + install tests |
| Linux + bash | ✅ (setup.sh + POSIX shims + `~/.bashrc` guards) | ✅ | ✅ | code + install tests; not executed here |
| macOS | U — code paths exist (`darwin` branches in `preflight.ts`, `install.ts`) | U — stdlib, expected | U | **not executable in this env** |
| Node <20 | ❌ gated | — | — | `isNodeSupported` preflight fails fast |
| Python <3.10 (portal server) | — | ❌ (uses `dict\|None` union syntax) | — | type hints require 3.10+ |
| No-TTY / CI | ✅ `isNonInteractive` paths throughout | ✅ (serve_in_thread) | ✅ | tests |

## 2. forge-cli ↔ Forja catalog (repos.ts `nativeInstall` vs reality)

| Forja | verify argv | native install argv | ops declared | Real surface found | Match |
|---|---|---|---|---|---|
| the-forge | `theforge --help` | `theforge install apply` (scope/profile/components/host) | `install update`, `install uninstall` | `cmd_install_plan`, `cmd_install_lifecycle`, `cmd_install_wizard`, `cmd_portal`, `cmd_doctor` in `cli/commands.py` | ✅ |
| spark-forge-aws | `sparkforge-aws --help` | `sparkforge-aws install` (+gateway-profile) | `update`, `uninstall` | `sparkforge_aws/install/cli.py` present | ✅ |
| spark-forge-azure | `sparkforge-azure --help` | `sparkforge-azure install` (+gateway-profile) | `install update`, `install uninstall` | install cli present | ✅ |
| platform-forge | `platformforge --help` | `platformforge install` | `upgrade`, `uninstall` | `platformforge/__main__.py` + install surface | ✅ |
| api-forge | `apiforge --help` | `apiforge install` (+host, gateway-profile) | `install update`, `install uninstall` | `cli.py` commands + `cli_portal.py` + `cli_install_pretty.py`; envKeys declared | ✅ |
| forge-doctor-data | `forge-doctor-data --help` | `forge-doctor-data install` (+gateway-profile, **no host flag** — correctly absent) | `install update`, `install uninstall` | install surface present | ✅ |
| forge-doctor-api | `forge-doctor-api --help` | `{python} scripts/forge_install.py install` (resolved Python) | `update`, `uninstall` via same script | `scripts/forge_install.py` exists — scripts-level by design (RC + no-network src rule) | ✅ |
| forge-portal | `npx --no-install ng version` | none (bootstrap-only, `kind: node`) | — | correct: portal is cloned + `npm install`, not product-installed | ✅ |

`gateway-profile` support (economy/balanced/deep): declared for the-forge,
spark-aws/azure, api-forge, doctor-data; **absent for platform-forge and
doctor-api** — flag table reflects that correctly.

## 3. forge-portal ↔ Forja adapters

| Forja | `_forge_portal.py` parity | adapter ops | adapter file | assets location |
|---|---|---|---|---|
| the-forge | ✅ sha256 701cfe13… | 20 | `src/theforge/portal_adapter.py` | `portal/assets/` |
| api-forge | ✅ | 17 | `src/apiforge/portal_adapter.py` | `portal/assets/` → packaged as `apiforge/portal_assets` (pyproject) |
| spark-forge-aws | ✅ | 17 | `sparkforge_aws/portal_adapter.py` | `portal/assets/` (installed copy in `.venv`) |
| spark-forge-azure | ✅ | 17 | `sparkforge_azure/portal_adapter.py` | `portal/assets/` |
| platform-forge | ✅ | 17 | `platformforge/portal_adapter.py` | `portal/assets/` |
| forge-doctor-data | ✅ | 17 | `src/forge_doctor_data/portal_adapter.py` | `src/forge_doctor_data/portal_assets` (inside package — poetry wheel) |
| forge-doctor-api | ✅ | 17 | `scripts/forge_portal_adapter.py` | checkout-level (`scripts/` — respects RC + no-network-src) |

`forge/PortalApi/1` client (Angular) ↔ adapter op surface: method set
consistent; adapter ops are a superset of `default_operations` — frontend
renders `unverified`/`NOT_APPLICABLE` when an op is absent (honest-state
contract). Extra adapter ops the frontend doesn't call yet are forward
surface, not drift.

## 4. Contracts already live and versioned

| Contract | Where | Consumers |
|---|---|---|
| `forge/PortalApi/1` | envelope in server + `api.models.ts` | all 7 adapters + SPA |
| `forge/InstallEnvironment/v1` | `detect_account_environment` | SPA environment page, all adapters |
| `forge/PortalAssets/1` | `manifest.json` per Forja | each Forja's `portal` command verifies |
| `forge/InstallationManifest/v1` | `~/.forge/installations/*.json` | portal detection + federation ops |
| `theforge/<Name>/v1` | the-forge contracts dir | the-forge core+providers (out of scope but compatible) |

Breaking-change rule already documented (contracts.md §Estabilidade):
additive-only; removal/rename → `PortalApi/2` + dual adapter. The C1
contract work must follow this rule.

## 5. Circular-dependency check (§0.2 invariant)

| Path | Dependency direction | Verdict |
|---|---|---|
| forge-cli → Forjas | spawns their argv; reads `forge.json`, `~/.forge/installations` | CLI depends on Forjas' CLIs — expected, one-way |
| Forjas → forge-cli | none found | ✅ no reverse dep |
| forge-portal → Forjas | none at build; at runtime each Forja serves its own vendored copy | ✅ loose, per-Forja |
| Forjas → forge-portal | vendors `portal_core` + `dist` assets at build-vendor time only | ✅ one-way vendor, not runtime dep |
| forge-cli → forge-portal | none (only catalog entry for clone) | ✅ |
| forge-portal → forge-cli | none | ✅ |
| the-forge ↔ specialists | subprocess Forge Protocol only (`theforge/<Name>/v1`), no imports | ✅ invariant held |

No mandatory dependencies on CLI/Portal from any Forja — §0.2 invariants hold.

## 6. Host agents integration (per fase0 capability-map + adapter code)

| Host | Observe | Launch surface | logged_in |
|---|---|---|---|
| Claude | `hosts observe`/`ai` per Forja | `hosts --launch` / `ai --launch` (TTY) | verifiable |
| Codex | same | same | verifiable |
| Devin | same | same | verifiable |
| Copilot | same | same | `null` — honest unverifiable (documented gap) |

Portal `/hosts/launch` returns a prepared command string, never executes —
browser≠TTY is a stated invariant (contracts.md line 66-84).
