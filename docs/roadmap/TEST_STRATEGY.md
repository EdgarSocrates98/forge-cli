# Test strategy — F0 results → homologation ladder

Program: `prompt_evo_cli_portal.md` §14 (homologation). This document
records what ran during F0 (the regression floor) and what each cycle must
add. Everything already green today **stays green** — that's the floor.

## Regression floor (verified during F0, 2026-10-14)

| Layer | Command | Result |
|---|---|---|
| forge-cli unit/functional | `npm test` (vitest) | 296/296 across 26 files |
| forge-cli static | `typecheck`, `lint`, `format:check` | all clean |
| forge-cli package | `build` (tsup), `pack --dry-run` | 472KB bundle, 127.5kB/8-file tarball |
| forge-portal backend | `python -m pytest tests/` | 45/45 |
| forge-portal frontend | `npm test` (ng/vitest) | 11/11 across 3 spec files |
| forge-portal build | `npm run build` | 325KB initial, all lazy chunks |
| forge-portal style | `npx prettier --check "src/**/*"` | clean |
| forge-portal browser E2E | `python -m pytest e2e/` | **12/12 in real Chromium** |
| vendored parity | sha256 of `_forge_portal.py` ×7 | byte-identical |

Gaps in the floor: macOS/Linux execution unverified; no live `--yes`
install run (mutating); no multi-process concurrency test; frontend unit
coverage thin; performance never measured; `e2e/` not wired into `npm test`.

## Cycle test requirements

| Cycle | Must add (beyond floor) |
|---|---|
| C1 contracts | schema conformance suites: each contract validated + invalid-fixture rejected; per-Forja adapter emitted-shape check vs `ForgeDescriptor`/`ForgeCapability`; serialization determinism test |
| C2 CLI intelligence | discovery fixtures (fake tool dirs, fake `~/.forge`), recommendation explainability snapshots, `.env` cases (absent/partial/secret-containing/readonly/unicode/spaces), offline-bundle restore test, noninteractive parity test |
| C3 portal center | frontend unit suite for stores/client/pages; E2E additions: config-center read states, search, dashboard aggregation vs multi-forge fixture adapter |
| C4 hosts/MCP/agents/skills | per-Forja adapter conformance run (all 7), host-detection fixture matrix (absent/absent-version/logged-out/blocked), MCP mutation allowlist refusal tests, duplicate-skill differentiation test |
| C5 operations | self-healing class enforcement tests (each class refusal), execution-center receipt persistence, log redaction fuzz, session-expiry test (per ADQ-005), concurrent-op lock test, Graph Studio federation fixture |
| C6 intelligence | deterministic-core unit suite, AI-mode secret-scrub proof, opt-in default-off test |
| homologation | everything below |

## Homologation checklist (§14)

### Functional E2E scenarios — status at F0

| Scenario | Status | Notes |
|---|---|---|
| Fresh workspace install (simple flow) | **not yet executed** | needs a clean scratch dir + `--yes` dry-run→real on a low-risk Forja |
| Portal discover→inspect→read-only op | partially proven | browser e2e covers session+nav+install apply on E2EAdapter; per-Forja fidelity via adapter tests |
| Independent Forja use w/o CLI/Portal | proven by architecture | Forjas are self-contained; registry live on this machine |
| Recovery from partial failure | partially proven | retry-failed + interactive retry tested in vitest |
| Offline install from cache/bundle | **MISSING feature** — C2 builds it | |
| Differing hosts/Forjas compatibility | fixture-based today | host fixtures exist in Forja tests |
| Concurrent operations + locking | **untested** | no cross-process lock exists yet (C5) |

### Performance baselines — never measured at F0

To capture in homologation: CLI cold start, `list`/`status`, plan
generation per repo count, `.env` scan, portal server boot, bundle size,
endpoint p50/p95, catalog render, doctor full pass, SSE overhead.

### Security matrix (§8 gates) — F0 coverage

| Threat | Test exists? | Where |
|---|---|---|
| non-loopback bind refused | yes | pytest (host="0.0.0.0" → ValueError) |
| session missing/invalid | yes | pytest |
| CSRF cross-origin POST | yes | pytest |
| Content-Type enforcement | yes | pytest |
| mutating rate limit | yes | pytest |
| oversized body | yes | pytest |
| plan-token required/bound | yes | pytest |
| traversal in static | yes | pytest |
| secret scrub in responses | yes | pytest |
| unknown op refused | yes | pytest |
| handler internals never leak | yes | pytest (PORTAL-INTERNAL) |
| session expiry | **no** | needs ADQ-005 decision |
| symlink escape (CLI) | partial | safety tests cover link detection |
| symlink escape (portal static) | **unverified** | add homologation case |
| SSRF | n/a mostly | portal has no remote fetch; Forja adapters must not fetch — assert per-adapter |
| DNS rebinding (Host header) | yes | `_host_ok` + pytest |
| concurrent mutation flood | **no** | add homologation case |
| log redaction | yes (CLI tests) | extend to portal server logs |

### Coverage targets (honest, not vanity)

- forge-cli: keep vitest ≥ current; add contract + discovery + `.env` + offline suites.
- forge-portal backend: keep 45+; add conformance + security cases.
- forge-portal frontend: from 3 spec files → cover every store, the API client unwrap paths, and page-level state machines for the 5 busiest pages.
- e2e: keep 12; add one scenario per new center; wire `pytest e2e/` into CI gate docs.

## Environment/tooling limits (§14.3 — recorded, not worked around)

- Windows host only: POSIX paths are test-simulated or reviewed statically; macOS unverifiable.
- No cloud/remote infra used; all E2E is local.
- `gh` authenticated and used for PR checks.
- `nul` untracked files in both repos are pre-existing Windows redirect artifacts — not removed (not ours to delete without owner).
- `forge-cli/factory` has unrelated `lf-*` specs in `active/` — untouched.
