# Security Boundaries — Cross-Forge Integration Audit (lf-0026, Phase 0)

Mechanisms that exist today, by boundary. "Data is not instruction" and
"evidence-in, never instruction-in" are enforced structurally at the seams
below. Refusal codes are named, never silent.

## 1. Trust-gated provider registry (the-forge)

- `providers.toml` at builtin/user/project levels; trust levels
  `builtin|trusted|local|unverified|blocked`; **project providers are forced
  `unverified`** (`registry/config.py:15-31,103-170,132-139`).
- `unverified` providers are **not executed** without `--allow-unverified`;
  `blocked` never runs (`registry/registry.py:47,207-215`;
  `registry/health.py:50-63`).
- Registry cache is hash-bound: entry digest, manifest sha256, surface
  fingerprints re-validated (`registry/registry.py:419-461`); manifest
  SemVer enforced (`registry/registry.py:250-257`).
- Agent authority gate: `UNIVERSAL_FORBIDDEN` (approve, grant-trust…)
  walled for every agent; authority ceilings (`agents.py:33-87`).

## 2. Deny-by-default remote + install approval (the-forge)

- `remote-forge` requires `verified`, `a2a-agent` requires `org-approved`;
  receipts must hash-bind the request (`remote.py:27-51`;
  `contracts/remote.py:16-17`).
- Install is approval-gated: `InstallApproval`, `planning_only=True`
  contractual (`contracts/installation.py:74-121`); forge-cli native
  installer defaults to `--dry-run` unless explicit `--yes`
  (`forge-cli/src/native-install.ts:69-71`; `cmd/registry.ts:241-248`).

## 3. Process boundary — argv, never shell

| Repo                | Mechanism                                                                                                          | Cite                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| the-forge           | Forge Protocol spawn `shell=False`, process-tree managed                                                           | `protocol/transport.py:70-113`; `protocol/proctree.py:186-263`              |
| the-forge adapters  | `run_native`: no shell, cwd-scoped, timeout=85% of profile budget                                                  | `adapters/*/src/…/_shell.py` (byte-identical, test-enforced; audit-data §6) |
| forge-cli           | execa argv arrays, `reject:false`, never shell; MCP `spawn(argv[0], args, {shell:false})`                          | `src/registry/install.ts:588-606`; `src/mcp/handshake.ts:170-194`           |
| forge-portal        | single exec boundary = closed 9-action forge-cli argv allowlist, `subprocess.run` never shell; `_SAFE_FORGE` regex | `portal_core/registry_ops.py:19-77,108-116`                                 |
| api-forge           | `run tool` closed argv-template table, `shutil.which` + `subprocess.run(argv, …)` no shell                         | `src/apiforge/run_tools.py:411-467`                                         |
| platform-forge      | `host_transport()` argv-only `subprocess.run`, never `shell=True`, rc124 timeout / rc127 missing                   | `platformforge/ops/executors/base.py:188-209`                               |
| api-forge (install) | vendored `_installkit.py` under spawn gate `FORGE-INSTALL-SPAWN-DISABLED`                                          | `src/apiforge/_installkit.py:1471-1532`                                     |

## 4. Environment scrubbing

- `safe_env()`: allowlist-only env + credential-pattern filter
  (AWS_/TOKEN/SECRET/API_KEY/proxy…) — credentials never reach a provider
  (`security/env.py:15-77`; applied `protocol/transport.py:118`).
- Adapter `_shell.py`: env = core env minus credential-shaped names
  (audit-data §6).

## 5. Anti-instruction-smuggling on evidence intake (upstream-facts family)

- Closed `_FORBIDDEN_KEYS` vocabulary (`action|command|execute|instruction|
plan|prompt|route|task|workflow`, apiforge adds `routing|tool_call`)
  scanned **recursively/iteratively** — "payload depth is
  adversary-controlled" (`spark-forge-aws/adapters/upstream.py`;
  `spark-forge-azure/adapters/upstream.py:1-36`;
  `api-forge/application/analyze.py:79-169`).
- Foreign facts enter under namespaced ids/kinds (`upstream:`/`upstream.`)
  that no native rule matches; `provenance.extractor="theforge/handoff"`;
  bounds 256 KiB / 128 facts; adapter translation can never emit imperative
  keys (`the-forge/adapters/sparkforge_aws/.../handoff.py` docstring 1-37).
- Foreign facts reach `facts` output, never `judge` input — "never
  laundered into local findings" (azure `adapters/upstream.py`; apiforge
  `analyze.py:143-149,258-267`).
- api-forge: `delegated_from`/`delegated_scope` checks — a delegatee can
  only use the delegated subset (confused-deputy guard)
  (`trust/tools.py:167-190`).

## 6. Named refusal vocabularies (no silent failure)

| Family                | Codes                                                                                                                                                                                                                                                                                                              | Where                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADAPTER-*`           | `OP-UNSUPPORTED`, `PROTOCOL-UNSUPPORTED`, `REQUEST-INVALID`, `CAPABILITY-UNSUPPORTED`, `ACTION-UNSUPPORTED`, `INTERNAL`, `OUTPUT-TOO-LARGE`, `NATIVE-TIMEOUT`                                                                                                                                                      | `_shell.py` constants (audit-data §1)                                                                                                              |
| `AF-*` (~40 families) | `AF-RUN-TOOL-UNKNOWN`, `AF-RUN-IMPORT-ONLY`, `AF-RUN-TIMEOUT`, `AF-RUN-NO-REPORT`, `AF-UPSTREAM-LIMIT/INVALID/UNMARKED/FORBIDDEN`, `AF-EVIDENCE-MISSING/MISMATCH`, `AF-POLICY-*`, `AF-TOOL-*`, `AF-FORGE-ENGINE-UNKNOWN`, `AF-FORGE-RISK-GATE`, `AF-ROUTING-NO-ROUTE`, `AF-GOV-RECOVERY-DEPTH`, `AF-RUN-PROD-GATE` | `api-forge/docs/catalog-contract.md`; `run_tools.py`; `application/analyze.py`; `forge/protocol.py`; `trust/tools.py`; `runtime/supervisor.py:866` |
| `PF-OPS-*`            | `PF-OPS-CROSSFORGE-REFUSED`, `PF-OPS-ENVELOPE-UNGOVERNED`, `PF-OPS-POLICY-BLOCK`, `PF-OPS-ENVELOPE-INVALID`, `PF-OPS-NO-DELTA`, `PF-OPS-UNKNOWN-ACTION`, `PF-OPS-OFFLINE`                                                                                                                                          | `platformforge/ops/registry.py:63-110`; `ops/engine.py:132-191,354`                                                                                |
| Portal                | `CLI-TIMEOUT`, `PORTAL-NOT-FOUND`→UNVERIFIED (never crash)                                                                                                                                                                                                                                                         | `registry_ops.py:61-62`; `forges.data.ts:17-56`                                                                                                    |
| platformforge collect | `platform.forge.cli_missing` (unlock `pip install -e`), `platform.forge.unknown` (unlock "extend KNOWN_FORGES"), `platform.capability.unresolved`, `platform.envelope.invalid`                                                                                                                                     | `forge/collect.py:44-76`; `forge/delegate.py:54-60`                                                                                                |

## 7. Data-only authority

- spark-forge-aws `agentic/handoff.py`: receiver role-plan admission
  ALLOW|DENY|REVIEW; authority forced `DATA_ONLY`; trust ceilings;
  taint→REVIEW; sender tool-access check; denied content → named
  `unresolved`.
- spark-forge-azure AGENTS.md invariants: DATA_ONLY authority, default-deny
  cloud mutation, unknown risk → DENY.
- Sentinel guardrails: remote writes, destructive actions and process
  execution denied for agent flows (`agents/guardrails.py`); tool registry
  refuses cloud-write/destructive permissions (`tools/registry.py`);
  imported findings never auto-`CONFIRMED`.
- Doctor API boundary: "no network, no subprocess, no dynamic import, no
  target-code execution"; no routing/scheduling/retry method; `safefix`
  not on the scan/handoff path (`handoff/boundary.py:16-24`; AST-enforced
  `tests/test_boundary.py:124,196,220`).
- platform-forge: `platformforge_ops` MCP surface is PREPARE-only —
  "Execution and approval signing are refused on this surface"
  (`mcp/registry.py:340-344`); mutating steps need an `ExpectedDelta`
  (`PF-OPS-NO-DELTA`); **unknown action treated as mutating**
  (`ops/engine.py:140-191`); `ops approve` mints signed hash-bound
  artifacts and "Never executes" (`cli/main.py:2348-2366`).
- Portal server has **no exec primitives by design** (pinned by
  `tests/test_security_c5.py`; `registry_ops.py:1-6`).

## 8. Timeouts with guaranteed kill

- Transport poll deadline → `PROTO_TIMEOUT` + guaranteed **tree kill**
  (`protocol/transport.py:163-192`).
- Adapter `_shell.py`: `EXECUTE_TIMEOUTS {economy:60s, balanced:180s,
max:600s}`; native timeout = 85% of profile; whole process tree killed
  (Job Object on Windows / process group on POSIX); overrun →
  `ADAPTER-NATIVE-TIMEOUT`.
- `DESCRIBE_TIMEOUT=10.0` (`registry/registry.py:46`);
  `HEALTH_TIMEOUT=10.0` (`registry/health.py:13`); version probe 15s
  (`specialists.py:99`); delegation `_DEFAULT_TIMEOUT_S=600`
  (`delegation.py:27`); `install auto` `timeout=600`
  (`install/service.py:624-626`).
- forge-cli: execa `timeoutMs=300_000` (`install.ts:580-606`); probe 15s
  (`system.ts:110-127`); MCP per-step 8s + SIGTERM→SIGKILL
  (`handshake.ts:44,213-229`); discovery budget 2000ms
  (`discovery.ts:38,344-349`); lifecycle lock 5min acquire/10min stale
  (`install.ts:341-466`).
- api-forge: `--timeout`→`AF-RUN-TIMEOUT` (`run_tools.py:468-469`); version
  probe 10s (`run_tools.py:486`); GitHub transport 10s
  (`integrations/github.py:55-70`).
- platform-forge: `timeout_s` per action, 300s fallback→rc124
  (`ops/executors/base.py:163,197-209`); collect 30s (`forge/collect.py:45,59`).
- Portal: per-op `run_with_timeout` (30s default; registry plan 90s/execute
  320s); forge-cli subprocess 60s plan / 180s/300s execute → `CLI-TIMEOUT`
  (`forge_portal.py:769-799`; `registry_ops.py:129,150-178`).

## 9. Output caps and bounds

- `_shell.py`: `NATIVE_STDOUT_CAP=64 MiB`, `NATIVE_STDERR_CAP=1 MiB`;
  `INLINE_LIMIT` spill → `native/full-output.json` + `partial` marker.
- Transport 8 MiB stdout cap (`protocol/transport.py:26-31`).
- Delegation keeps only 20-line stdout/stderr tails
  (`delegation.py:83-118`).
- Sentinel `MAX_OUTPUT_CHARS=200_000`; importer caps 20 MiB / 10 000
  findings; `core/security/paths.py` allowed roots + regular-file + size +
  UTF-8 checks; MCP stdio root-scoped (`DATA_SENTINEL_MCP_ROOTS`).
- spark-forge-aws `agentic/security.py` 50 KB output cap + secret-leakage
  scan.
- Doctor API `bundle.bounded()` — every truncation appends a
  `budget_exceeded` `UnknownFact`; `MCP_RESPONSE_BUDGET` truncation recorded
  as `UnknownFact`s (`handoff/model.py:152-175`; `mcp_server.py:43,77-87`).
- Portal body ≤1 MiB; JSON object; `confirm` literal; `plan_token`
  (`forge_portal.py:716-758`).

## 10. Output validation + evidence integrity

- the-forge: stdout→JSON→`Response` schema→`check_producer`→manifest
  SemVer/taxonomy/limits (`registry/registry.py:206-280`;
  `contracts/integrity.py`); `DelegationResult` refuses COMPLETED without
  `exit_code` (`contracts/specialist.py:211-213`); receipts re-hash on-disk
  artifacts before write (`runs/store.py:227-268`).
- forge-cli: draft-07 validator byte-parity with canonical schemas;
  sha256 of dist artifacts vs PyPI metadata, mismatches quarantined
  `.rejected`; `installConsistency` — a crashed install can never present
  healthy (`contracts/validator.ts`; `install.ts:475-573,725-763,994-1012`).
- api-forge: typed readers only, never raw passthrough
  (`run_tools.py:494-508`); evidence receipts re-hash every artifact
  (`evidence/verify.py:13-47`); append-only task store
  (`forge/protocol.py:330-338`).
- forge-cli safety: `isSafeRepoName/Url`, `resolveInside` traversal refusal
  before destructive ops; `redactSecrets` on stderr/reports
  (`safety.ts:13-66`; `install.ts:1169-1181`).
- Portal: loopback-only Host + Origin + 128-bit session token,
  DNS-rebinding guard, mutation rate limit 10/min, CSP/XFO/nosniff/no-store
  on all responses, `redact()` on every response/SSE frame
  (`forge_portal.py:48-50,460-473,500-544,587-622`).

## 11. Known soft spots (→ `confirmed-gaps.md`)

- `DelegationRequest.constraints`/`permissions` exist but the executor
  honors only execution_mode/command — **no 6-level risk-class
  enforcement** (audit-core §1.10).
- Delegation argv channel: fixed 600s timeout + 20-line tails; no
  per-request timeout, cancellation, or output byte caps
  (`delegation.py:26-27,83-118`).
- No hop/depth/visited fields on any delegation wire contract — cycle
  prevention is plan-DAG + host rules only.
