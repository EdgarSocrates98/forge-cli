# forge/<Name>/v1 — canonical contract family (C1)

Single source of truth for the eight canonical contracts of the
evo-cli-portal program. Everything else derives from these files.

## Layout

```
contracts/
  schemas/*.v1.json        canonical JSON-Schema (draft-07 subset)
  forge_contracts.py       vendored stdlib validator (Forja-side, zero deps)
  fixtures/                golden + hostile fixtures used by both test suites
  CONTRACTS.md             this file — semantics, precedence, compat rules
src/contracts/
  validator.ts             draft-07 subset validator (no deps)
  schemas.ts               embedded copies (byte-parity enforced by tests)
  negotiate.ts             capability negotiation + discovery precedence
  index.ts                 public surface
```

## The eight contracts

| Contract                          | On-disk / over-wire form                                  | Derives from                                                 |
| --------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `forge/ForgeDescriptor/v1`        | `forge.json` (extended, additive)                         | current `manifest.ts` fields + `forge.agentic.json` provides |
| `forge/ForgeCapability/v1`        | element of `PortalCapability[]`, adapter `capabilities()` | `forge/PortalApi/1`                                          |
| `forge/ForgeInstallContract/v1`   | catalog `nativeInstall` table + `forge.json:install`      | `repos.ts`, `_installkit.py` behavior                        |
| `forge/ForgeEnvironmentSchema/v1` | `forge/InstallEnvironment/v1` payload shape               | `forge_portal.detect_account_environment`                    |
| `forge/ForgeHostDescriptor/v1`    | `HostDetection` payload                                   | `forge/PortalApi/1` `HostDetection`                          |
| `forge/ForgeOperationPlan/v1`     | serializable install plan + portal plan                   | `planLines`/`executionSummary`, plan tokens                  |
| `forge/ForgeOperationReceipt/v1`  | CLI JSON reports + `InstallationReceipt`                  | `RepoResult`, adapter receipts                               |
| `forge/ForgeHealthReport/v1`      | `PortalHealth` + CLI doctor output                        | doctor.ts, adapter `health()`                                |

`forge.json` **is** the `ForgeDescriptor` on-disk form (ADR-C1-002).
Existing 3-field manifests (`forge_id`, `cli`, `mcp_command`) remain valid;
new fields are optional. A `schema` key, when present, must equal
`forge/ForgeDescriptor/v1` — never coerced.

## Compatibility rules

- `schema` declares the contract; unknown fields are tolerated at every
  level (`additionalProperties: true` by default).
- A `schema` value that does not match the requested contract is a hard
  `CONTRACT-VERSION` error — no silent downgrade/upgrade.
- Breaking change = bump to `/v2`; dual-readers may support both, emitters
  always emit the version they declare.
- The subset of draft-07 used (type/required/properties/additionalProperties/
  enum/const/pattern/items/$ref/lengths/ranges) is implemented identically
  by `validator.ts` and `forge_contracts.py` — a change to one must be
  mirrored by the other (parity covered by each repo's tests).
- `$ref` resolution is forge-internal only (`forge/<Name>/vN`); external
  refs are refused (`CONTRACT-REF`).

## Discovery precedence (§1.3)

```
verified local manifests (forge.json, install registry)
  > existing Forja discovery services
  > trusted local catalog/cache
  > optional remote registry
  > explicit fallback (nothing discovered)
```

Each source produces a `DiscoveryState` ∈ `integrated | validated |
configured | declared | detected | degraded | unknown` — seven states,
never flattened: a `declared` capability must never render as `integrated`.
`resolveDiscovery()` in `src/contracts/negotiate.ts` implements the order.

## Capability negotiation

`negotiateCapabilities(requested, offered)` answers each requested
capability with `granted | granted_unverified | refused | unknown` plus a
reason string. `ok` requires no refusals; `complete` additionally requires
zero unverified — used to decide when the CLI may proceed vs must ask.

## Security notes

- Validation is **shape-only** — strings are never dereferenced as paths
  or commands (path safety stays in `safety.ts:resolveInside`).
- Malformed/oversized/hostile manifests produce structured error lists,
  never exceptions; `forge.json` reads stay under the existing 64 KiB cap.
- The Python module is vendored byte-parity (same model as
  `_forge_portal.py`/`_installkit.py`); `python _forge_contracts.py
--selftest` self-verifies offline.
