# F0 → Cycle implementation plan (evidence-based)

Program: `prompt_evo_cli_portal.md` cycles 1–6 + homologation.
Derived from CAPABILITY_GAP_MATRIX — each cycle lists what exists today
(preserve), what's partial (extend), what's missing (build). **Nothing
in this plan replaces a working component.**

Invariants all cycles must honor (confirmed present): vendored byte-parity
pattern, `forge/PortalApi/1` envelope, adapter/Operation contract, plan
tokens, trust model, `.env` non-destruction, loopback-only bind, honest
`unverified`/`NOT_APPLICABLE` states, no LLM in any deterministic path.

## Cycle 1 — Foundation & contracts (gap rows: §3 contract inventory)

| Deliverable | Base | Approach |
|---|---|---|
| `ForgeDescriptor` | `forge.json` (3 fields) + adapter `descriptor()` | ADR-006 decision: make `forge.json` the on-disk descriptor, additive fields; schema extracted to `contracts/` |
| `ForgeCapability` | `PortalCapability` type | extract to standalone schema; portal continues emitting it |
| `ForgeInstallContract` | `repos.ts:nativeInstall` + `_installkit.py` behavior | formalize what installkit already accepts (scope/profile/components/host/gateway-profile + ops map) |
| `ForgeEnvironmentSchema` | `forge/InstallEnvironment/v1` | extend beyond installer vars (ADQ-001 decides schema format) |
| `ForgeHostDescriptor` | `HostDetection` + lifecycle states | extract |
| `ForgeOperationPlan` / `ForgeOperationReceipt` | `planLines`/`executionSummary` + `RepoResult` + `InstallationReceipt` | unify: plan = serializable, hashable (portal already HMACs canonical JSON — reuse that canonicalization) |
| `ForgeHealthReport` | `PortalHealth` + CLI doctor output | unify |

Constraints: additive to `forge/PortalApi/1` (breaking = v2 per
contracts.md); keep adapters working against old and new surfaces during
transition; **no central framework/registry** — contracts are files +
validators, vendored like the rest.

## Cycle 2 — CLI intelligence (gap rows: §1 P/M entries)

| Deliverable | Base | Approach |
|---|---|---|
| Environment discovery | `preflight.ts`/`prereqs.ts` probes + adapter `account_environment` | new `discover` command: OS, tools (node/npm/python/git/host CLIs), installed Forjas (`~/.forge/installations/` — already live), workspace state |
| Deterministic recommendation engine | — | rules over discovery facts; explainable output (reasons list); never guesses — low confidence asks |
| Smart wizard | `applyMenu` flow | insert recommendation step between detection and `askRepos` — same non-interactive escapes |
| `.env` intelligence | `env.ts` bootstrap | add discovery (existing keys), validation (required `envKeys` from descriptor), migration (additive, backup-first, redacted diff) — **never prints values** |
| Host intelligence | `--host` passthrough today | surface host detection results (per Forja adapter observe) into plan display — CLI stays a reporter, adapters stay the source |
| Advanced install planner | `planLines` per repo | cross-repo ordered plan (the-forge first — orchestrator invariant), serializable as `ForgeOperationPlan`, `--plan` becomes contract-emitting |
| Offline bundle | `--offline` flag | bundle = tarred clones + lockfile manifests + npm/py wheels; verify-by-hash on restore |

Preserve: bootstrap path untouched; native dry-run gate; every existing
flag keeps its meaning.

## Cycle 3 — Portal control center (gap rows: §2 P entries)

| Deliverable | Base | Approach |
|---|---|---|
| Design system consolidation | `shared/` primitives + theme store | formalize tokens/states; no rewrite |
| 360° dashboard | `dashboard.page.ts` + federation ops | ADQ-002: extend the-forge adapter aggregation (recommended) — federation data already flows |
| Forge Explorer | federation page + catalog data | richer per-Forja detail views; unverifiable states stay honest |
| Installation Center | `install.page.ts` (731) | add cross-forge plan surface when ADQ-002 lands |
| Configuration Center | `/environment` read-only + settings page | `.env` read (keys, presence, validity — never values) via new adapter ops; writes go through confirm+plan ops |
| Global search | command palette | index nav+docs+skills+agents server-side via `/docs/search` pattern |
| Frontend unit coverage | 3 spec files | cover stores, client unwrap, page-level state transitions — target meaningful, not vanity % |

## Cycle 4 — Hosts, MCP, agents, skills (gap rows: §2 P entries)

| Deliverable | Base | Approach |
|---|---|---|
| Host Integration Center | hosts page + `HostDetection` | per-host capability matrix surface; keep "prepared command" launch (never fake TTY) |
| MCP Operations Center | mcp page + `mcp-verify` | add tool listing per server via adapter ops; mutation ops require explicit allowlist declarations in adapter |
| Agent Studio | agents page | roster view + host-mirror state (`expected_*_mirrors` already computed in adapters) |
| Skills Studio | skills page | namespace/origin/version/content comparison (duplicate ≠ same name) — adapter already emits `source` |
| Capability matching | `PortalCapability` per adapter | cross-forge coverage matrix page backed by real adapter capability lists |
| Per-Forja adapter verification | 7 adapters (17-20 ops) | run each Forja's portal adapter tests + contract-shape conformance suite against the same op surface |

**Do not build**: a second bridge (AD-011), shell execution from the web,
TTy-dependent host launch inside the page.

## Cycle 5 — Operations & observability (gap rows: §5)

| Deliverable | Base | Approach |
|---|---|---|
| Forge Doctor 2.0 | CLI `doctor` (verify+prereqs) + portal `health` | categories: system/install/env/hosts/ops; CLI doctor emits `ForgeHealthReport` |
| Self-healing risk classes | uninstall refusals + repair op | `SAFE_AUTOMATIC` (e.g. regen missing `.env` stub), `REVIEW_REQUIRED` (plan shown first), `MANUAL_ONLY` (guidance only), `UNSUPPORTED` |
| Execution Center | tasks plan/execute + SSE + receipts | unified surface: plan→confirm→execute→events→result→evidence→`ForgeOperationReceipt` persisted |
| Local observability | CLI `.forge-cli/logs` (already redacted) + portal correlation ids | `/logs` adapter op: tail+filter, redacted, bounded — no remote telemetry |
| Version manager | pin/unpin/rollback/versions | registry view across `~/.forge/installations` + compat hints |
| Federated Graph Studio | `_graphstudio` vendored + `/graphs` op | aggregate views across Forjas via adapter views[] — reuse engine, do not fork it |
| Security test expansion | 45 pytest security tests | add: session expiry (ADQ-005), symlink-escape static root, SSRF probes, malformed session cookie, concurrent mutation flood |

## Cycle 6 — Advanced intelligence (gap rows: §2 M)

| Deliverable | Base | Approach |
|---|---|---|
| Deterministic intelligence core | C2 recommender + C5 doctor history | scoring/explanation library shared by CLI+portal |
| Context & predictive compat | compat matrix + version manager | warn before upgrade conflicts using declared contracts |
| Optional AI mode | — | strictly opt-in; deterministic path unchanged; secret scrub before any payload; output carries evidence+limits |
| Learning/feedback | receipts + health history | local-only improvement of recommendation confidence |

## Homologation (final gate)

See TEST_STRATEGY.md — all quality gates green today are the regression
floor; homologation adds the missing layers (E2E scenarios, performance
baselines, security matrix, cross-repo install E2E).

## Sequencing & dependencies

```
F0 (this audit) → C1 contracts (unblocks C2/C3 contract surfaces)
C1 → C2 CLI intelligence ─┐
C1 → C3 portal center   ──┤ both consume canonical contracts
C4 adapters/hosts ────────┤ needs C1 contracts + ADQ-002 answer
C5 operations ────────────┤ needs C4 verified surface
C6 intelligence ──────────┘ needs C2+C5 data
homologation — last; requires everything above
```

ADQ-001/002/003/004/006 must be decided **before** the cycle that depends
on them starts (each is cheap to answer now, expensive to reverse later).
