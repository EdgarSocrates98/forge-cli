# Audit — Cross-Forge Integration Surfaces (lf-0026, Phase 0)

Read-only audit of the three core repos for the Loop Factory spec
`prompt_evo_integrations.md` (cycle 13). Scope: `the-forge`, `forge-cli`,
`forge-portal`. Every claim cites `file:line`. Contract names the spec asks
about that do not exist are marked **ABSENT**.

---

## 1. the-forge (control plane core — `src/theforge`, stdlib-only)

### 1.1 What it already knows about other specialists

- Data-driven specialist catalog — **never a code literal** — built from:
  `~/.forge/installations/*.json` install manifests, bundled
  `forge-knowledge/*.json` packages, workspace checkouts carrying
  `forge.json`, and the forge-cli registry `~/.forge-cli/forges/state.json`
  (`src/theforge/specialists.py:59-91` — `catalog_ids()`; forge-cli bridge
  at `specialists.py:37-56` honoring `FORGE_CLI_HOME`).
- `forge-knowledge/` ships 6 packages: `api-forge`, `forge-doctor-api`,
  `forge-doctor-data`, `platformforge`, `spark-forge-aws`,
  `spark-forge-azure` — each declares intents, technologies, install recipe,
  adapter path (e.g. `forge-knowledge/spark-forge-aws.json`).
- Per-specialist **adapter distributions** under `adapters/` (apiforge,
  doctorapi, doctordata, platformforge, sparkforge_aws, sparkforge_azure)
  — each is a Forge Protocol provider subprocess exposing
  `describe|health|execute` (e.g.
  `adapters/sparkforge_aws/src/theforge_sparkforge_aws/__main__.py:51-81,156-160`).
- **Gap:** `data-sentinel-forge` has no adapter, no knowledge package, and
  is absent from `ecosystem-compatibility.json` — it only surfaces via a
  workspace checkout's `forge.json`/`forge.agentic.json`.

### 1.2 How it discovers installed tools

- `specialists.collect()` composes an honest lifecycle per forge from real
  sources, highest first: installations registry → forge-cli state →
  workspace checkout → nothing; states UNKNOWN/DISCOVERED/NOT_INSTALLED/
  INSTALLABLE/INSTALLED/CONFIGURED/REGISTERED/DEGRADED
  (`specialists.py:151-268`; docstring `specialists.py:1-17` — "Never
  infers HEALTHY from file presence alone").
- `forge.agentic.json` (`forge/SpecialistAgenticManifest/v1`) loaded from
  the checkout root (`specialists.py:123-134`).
- Provider entries from `providers.toml` at builtin/user/project levels
  with trust levels `builtin|trusted|local|unverified|blocked`
  (`registry/config.py:15-31,103-170`; project providers are forced
  `unverified` at `config.py:132-139`).
- Remote discovery by `CapabilityRequirement`: local negotiation first,
  enabled registry sources consulted only per profile
  (`registry/discovery.py:1-9,282-351`; `registry/sources.py`);
  `McpRegistryDocument` sources for MCP tooling (`registry/mcp.py`,
  `discovery.py:355-436`).

### 1.3 How it selects a capability

- Deterministic router: explicit `requested_capability` path and
  declared-signal path (deps/file-globs/keywords, ≥2 discriminating signal
  types, non-discriminating shared signals removed); ambiguity → literal
  `"ambiguous"`, never a guess (`routing/router.py:1-14,45-78,234-319,476-518`).
- Requirement fit via `negotiate_all` — hard gates (protocol, policy,
  operation class, runtime, evidence, features) →
  FULL/PARTIAL/UNSUPPORTED/INCOMPATIBLE/UNRESOLVED; undeclared dimensions
  degrade to PARTIAL, never silently satisfied (`negotiation.py:1-15`;
  `contracts/manifest.py:96-144` `Capability`).
- Workflow pick inside an agentic manifest: `select_workflow` — exact id,
  then token-overlap score, tie/zero → `"ambiguous"`
  (`specialists.py:410-438`).

### 1.4 How it executes external commands

- **Forge Protocol v1**: `<argv> <op>` subprocess, canonical JSON request
  on stdin, `Response` on stdout (`protocol/transport.py:1,70-113`);
  spawn is `shell=False`, process-tree managed (`protocol/proctree.py:186-263`).
- **Delegation channel**: the specialist's own CLI argv — real
  `subprocess.run` of manifest-declared command templates
  (`delegation.py:1-12,68-121`; template resolution `{cli}`/`{python}`/
  `{checkout}`/`{target}` at `specialists.py:296-337`).
- **Governed install delegation**: `install auto` runs each registered
  forge's own CLI `<cli> install ...` (`install/service.py:445-492,589-641`).

### 1.5 How it verifies versions

- Runnable `--version` probe promotes INSTALLED→CONFIGURED
  (`specialists.py:99,113-120,184-200`).
- Manifest version must be SemVer 2.0.0 (`registry/registry.py:250-257`);
  adapter health checks the specialist version against a supported window
  (`adapters/sparkforge_aws/.../health.py`, `backend.py:33-45` — `find_spec`
  only, never imports the specialist).
- Registry cache entries are hash-bound and re-validated (entry digest,
  manifest sha256, surface fingerprints — `registry/registry.py:419-461`).

### 1.6 How it handles timeouts

- `DESCRIBE_TIMEOUT = 10.0` (`registry/registry.py:46`);
  `HEALTH_TIMEOUT = 10.0` (`registry/health.py:13`);
  version probe `15s` (`specialists.py:99`);
  delegation `_DEFAULT_TIMEOUT_S = 600` (`delegation.py:27`);
  transport poll deadline → `PROTO_TIMEOUT` + guaranteed tree kill
  (`protocol/transport.py:163-192`);
  `install auto` subprocess `timeout=600` (`install/service.py:624-626`);
  per-execute `wall_time_s` in `RunBudget` (`contracts/budget.py:30`;
  `economy.py:104`).

### 1.7 How it receives results

- Forge Protocol `Response` envelope; `request_id` echo and `op` echo are
  checked (`protocol/transport.py:95-112`).
- `forge/SpecialistDelegationResult/v1` with honest stage
  PREPARED/SUBMITTED/RUNNING/COMPLETED/FAILED/BLOCKED
  (`contracts/specialist.py:68-75,190-213`; produced at
  `delegation.py:110-121`).
- `theforge/ExecutionResult/v1` — findings, evidence, artifacts, metrics,
  limitations, unknowns, provider_economy, native_trace, provider_receipt
  (`contracts/result.py:139-168`).

### 1.8 How it validates output

- Contract validation on every boundary: stdout must be JSON → `Response`
  schema → producer identity (`check_producer`) → manifest SemVer +
  taxonomy + limits (`registry/registry.py:206-280`;
  `contracts/integrity.py`).
- `DelegationResult` refuses `COMPLETED` without `exit_code` evidence
  (`contracts/specialist.py:211-213`).
- Receipts validated against on-disk artifact hashes before write
  (`runs/store.py:227-268`).

### 1.9 How it preserves evidence

- `RunStore`: one `.forge/runs/<id>/` dir per run, ~28 typed artifacts
  (task, routing, plan, handoff, context, result, receipt, budget,
  telemetry…), redacted + atomic writes + sha256 on disk
  (`runs/store.py:56-120,227-288`).
- `theforge/ExecutionReceipt/v1` binds input/provider/result/plan hashes,
  surface fingerprints, kind run|plan, parent_run/plan_node linkage
  (`contracts/receipt.py:94-144`).
- `theforge/Handoff/v1` — the plan-node evidence bus (typed items:
  evidence/finding/artifact/decision/constraint/assumption/verification
  with origin, epistemic status, provenance; content dedup; no file
  content) (`contracts/handoff.py:1-98`).
- Delegation results persisted to `.forge/delegations/<task-id>.json`
  (`cli/commands.py:1802-1810`).

### 1.10 How it prevents dangerous delegations

- Trust gate: `unverified` providers are **not executed** without
  `--allow-unverified`; `blocked` never runs
  (`registry/registry.py:47,207-215`; `registry/health.py:50-63`).
- `safe_env()`: allowlist-only environment + credential-pattern filter
  (AWS_/TOKEN/SECRET/API_KEY/proxy…) — credentials never reach a provider
  (`security/env.py:15-77`; used at `protocol/transport.py:118`).
- Agent authority gate: `UNIVERSAL_FORBIDDEN` (approve, grant-trust…)
  walled for every agent; authority ceilings (`agents.py:33-87`).
- Remote execution: deny-by-default policy; `remote-forge` needs
  `verified`, `a2a-agent` needs `org-approved`; receipts must hash-bind the
  request (`remote.py:27-51`; `contracts/remote.py`).
- Install is approval-gated (`InstallApproval`, `planning_only=True`
  contractual — `contracts/installation.py:74-121`).
- `DelegationRequest` carries `constraints`/`permissions` fields but the
  executor only honors execution_mode/command — **no risk-class
  enforcement** (LOCAL_READ/DESTRUCTIVE) beyond trust gates (gap).

### 1.11 How it prevents delegation cycles

- Plan DAG: `topological_order` raises on dependency cycles — "a cyclic
  plan is never executed" (`planning/order.py:12-38`); decompose reports
  cycles as evidence (`planning/decompose.py:307-351`).
- Fan-out cap `max_parallel=4` (`delegation.py:124-148`),
  `MAX_PARALLEL_NODES=4` (`contracts/types.py:60`).
- `correlation_id` exists for telemetry (`contracts/telemetry.py:182-185`;
  `forger/plan_executor.py:319`) — but **no** visited-providers list,
  delegation depth, or hop budget for specialist→specialist chains (gap;
  currently only the-forge→specialist exists, so no runtime chain exists).

### 1.12 Tests that prove these integrations

- `tests/test_execution_modes.py` — delegate/parallel/debate plan
  execution end-to-end.
- `tests/test_agentic_manifests.py` — cross-repo `forge.agentic.json`
  validation: schema, `cli_entry` importability, workflow verbs vs real
  CLI tables.
- `tests/test_agentic_security.py` — injection/authority-escalation/fake-
  provider threat classes.
- `tests/test_control_plane.py`, `test_control_plane_e2e.py`,
  `test_install_orchestration.py` — specialists lifecycle + install auto.
- `tests/test_registry*.py`, `test_router*.py`, `test_protocol*.py`,
  `test_negotiation.py`, `test_remote_discovery.py` — registry/routing/
  transport/negotiation.
- `tests/test_adapter_*.py`, `test_adapters_core.py`,
  `test_cross_forge_*.py`, `test_delta_handoff.py` — adapter + handoff
  conformance.
- `tests/test_mcp_awareness.py` — MCP discovery/dependency surface.

---

## 2. forge-cli (npm CLI installer/manager)

### 2.1 What it already knows about other specialists

- `FORGE_REPOS`: 8 repos (the-forge, spark-forge-aws, spark-forge-azure,
  platform-forge, api-forge, forge-doctor-api, forge-doctor-data,
  forge-portal) with verify argv and `nativeInstall` command/flags/ops
  declared per forge (`src/constants/repos.ts:3-119`).
- `REGISTRY_PACKAGES`: 7 PyPI dists with `bin`, `minPython`, `mcp` argv
  template, `mcp_safe_tools` allowlist, `extras`
  (`src/registry/catalog.ts:7-117`).
- **Gap:** `data-sentinel-forge` is in **neither** catalog — it cannot be
  installed, verified, or MCP-probed via forge-cli today.
- No knowledge of _capabilities_ a specialist offers beyond install/MCP
  metadata; no `forge.agentic.json` consumer (only `forge.json` —
  `src/manifest.ts`).

### 2.2 How it discovers installed tools

- Own registry: `~/.forge-cli/forges/state.json` + per-forge
  `install.json` receipts (`src/registry/install.ts:200-245`).
- `forge/EnvReport/v1` bounded environment scan: workspace markers,
  `forge.json`/`forge.agentic.json` presence, tool probes, host CLI probes
  (`src/discovery.ts:19-53,86-135,488-552`).
- Python interpreter pipeline: 8 deterministic stages, every candidate
  verified by executed `--version` (`src/env/python.ts:1-33`);
  `forge/EnvironmentDiscovery/v1` aggregate (`src/env/discover.ts:1-22`).
- `forge.json` read as untrusted optional manifest, fail-closed on schema
  mismatch (`src/manifest.ts:14-46`).

### 2.3 How it selects a capability

- `negotiateCapabilities(requested, offered)` over
  `forge/ForgeCapability/v1` → `granted|granted_unverified|refused|
unknown` per request, `ok`/`complete` flags
  (`src/contracts/negotiate.ts:20-60`).
- `resolveDiscovery`: precedence `manifest > forja-discovery > catalog >
remote-registry > fallback`; 7 `DiscoveryState` values never flattened
  (`src/contracts/negotiate.ts:67-114`; doctrine in
  `contracts/CONTRACTS.md`).

### 2.4 How it executes external commands

- `execa` argv arrays, `reject:false`, never shell (`src/registry/install.ts:588-606`;
  `src/utils/system.ts` commandOutput/commandProbe).
- `delegateNative`: runs the forge's _verified venv bin_ with documented
  flags; `{python} scripts/...` argv honestly skipped under registry
  method (`src/cmd/registry.ts:237-294`).
- Git/setup execution via `runner.ts`/`processPool` (`src/cmd/run.ts`,
  `src/utils/system.ts:runStreamed`).
- MCP stdio handshake via `spawn(argv[0], args, {shell:false})`
  (`src/mcp/handshake.ts:170-194`).

### 2.5 How it verifies versions

- PyPI release resolution + `requires_python` satisfaction +
  interpreter selection (`src/registry/pypi.ts`,
  `src/registry/install.ts:681-723`; `src/registry/versions.ts`).
- Post-install verify: `<venv>/bin/<cli> --help` exit code recorded in the
  receipt (`src/registry/install.ts:1055-1056,1142-1144`; the same pattern
  as `verify:` fields at `install.ts:98`).
- `commandProbe` distinguishes timeout from absent
  (`src/utils/system.ts:110-183`).

### 2.6 How it handles timeouts

- `execaRun` default `timeoutMs = 300_000` with preserved stderr
  (`src/registry/install.ts:580-606`).
- Probe timeout `FORGE_CLI_PROBE_TIMEOUT_MS` default 15s
  (`src/utils/system.ts:110-127`).
- MCP per-step 8s + guaranteed SIGTERM→SIGKILL (`src/mcp/handshake.ts:44,
213-229`).
- Discovery global budget 2000ms via `raced()` (`src/discovery.ts:38,
344-349`).
- Lifecycle lock: 5min acquire deadline, 10min stale break, pid-liveness
  check (`src/registry/install.ts:341-466`).

### 2.7 How it receives results

- `RunResult {exitCode, stdout, stderr}` (`src/registry/install.ts:575-579`).
- `RegistryInstallReceipt`/`LocalInstallReceipt` persisted to
  `install.json` + `state.json` (`src/registry/install.ts:80-198`).
- MCP `McpProbeResult` with cumulative levels
  INSTALLED→EXECUTABLE→INITIALIZED→TOOLS_DISCOVERED→SAFE_TOOL_CALLED
  (`src/mcp/handshake.ts:13-41`).

### 2.8 How it validates output

- Embedded draft-07 subset validator with byte-parity to canonical
  `contracts/schemas/*.json` (`src/contracts/validator.ts`,
  `src/contracts/schemas.ts:1-5`; parity tested by `tests/contracts.test.ts`).
- sha256 of downloaded dist artifacts vs PyPI metadata; mismatches
  quarantined to `.rejected` (`src/registry/install.ts:725-763,994-1012`).
- `installConsistency`: state↔receipt↔venv coherence — a crashed install
  can never present healthy (`src/registry/install.ts:475-573`).
- MCP: `tools/list` shape + `tools/call` result checks incl.
  `isError:true` (`src/mcp/handshake.ts:347-433`).

### 2.9 How it preserves evidence

- Receipts (`install.json`, `state.json`) via `writeFileAtomic` +
  `.corrupt` quarantine on overwrite of malformed state
  (`src/safety.ts:74-95`; `src/registry/install.ts:269-302`).
- `--report` JSON output redacted (`src/cmd/registry.ts:316-320`).
- Receipt carries provenance (PyPI url, resolvedVia), verifiedHash,
  python interpreter provenance object, native delegation record
  (`src/registry/install.ts:80-126`).
- Heal flow receipts: Diagnose→Fix→Plan→Risk→Confirm→Apply→Verify→Receipt
  (`src/heal/flow.ts:1-40`).

### 2.10 How it prevents dangerous delegations

- `isSafeRepoName`/`isSafeRepoUrl`/`resolveInside` — traversal refused
  (`src/safety.ts:13-43`; used before destructive ops at
  `install.ts:1169-1181`).
- `redactSecrets` on all stderr/report paths (`src/safety.ts:54-66`).
- Native installer runs `--dry-run` unless explicit `--yes`
  (`src/native-install.ts:69-71`; `cmd/registry.ts:241-248`).
- `mcp_safe_tools` is an explicit maintainer allowlist — "safety is never
  inferred from the tool name" (`src/mcp/handshake.ts:148-154,367-379`;
  `src/registry/catalog.ts:24-28`).
- Custom repos need `askTrustCustom` (`src/cmd/run.ts:24-48`).
- Revview-required heal repairs gated (`src/heal/flow.ts:20-32`).

### 2.11 How it prevents delegation cycles

- forge-cli never chains specialists — it only delegates install/update
  to each forge's own installer; no specialist→specialist path exists.
  Concurrency safety is the lifecycle `mkdir` lock (`install.ts:341-466`).
  **No cycle contract needed yet; none exists.**

### 2.12 Tests that prove these integrations

- `tests/registry-install.test.ts`, `registry-lifecycle`,
  `registry-lock`, `registry-pypi`, `registry-versions` — install
  pipeline, hash quarantine, lock semantics.
- `tests/mcp-verify.test.ts` — real stdio MCP fixtures
  (`tests/fixtures/mcp/*`), full level chain.
- `tests/discovery.test.ts`, `env-discover.test.ts`, `env-python.test.ts`
  — environment/interpreter discovery.
- `tests/doctor2.test.ts`, `heal.test.ts` — doctor domains + self-heal.
- `tests/native-install.test.ts`, `lifecycle-matrix.test.ts`,
  `local-source*.test.ts`, `fault-injection.test.ts`,
  `plan-purity.test.ts`, `contracts.test.ts` — delegation defaults,
  crash consistency, plan purity, schema parity.

---

## 3. forge-portal (Angular portal + vendored stdlib server)

### 3.1 What it already knows about other specialists

- Whatever the serving adapter reports: `GET /api/v1/federation` →
  `FederationSnapshot {specialists[], installed_forges[]}`
  (`src/app/core/api/api.models.ts:360-384`); the the-forge adapter fills
  it from `specialists.collect()` (`the-forge/src/theforge/
portal_adapter.py:458-493`).
- Explorer renders serving forge + specialists + registry-only rows —
  never invents entries (`src/app/pages/explorer/forges.data.ts:97-158`).
- Federation Graph Studio overlay: `forge→capability`, `agent→skill`,
  `mcp→host`, `task→forge`, `entity→entity` (observed via PortalEvent) —
  declared vs observed edges distinguished
  (`src/app/core/graph/federated.ts:1-40`).

### 3.2 How it discovers installed tools

- Portal self-presence only: `FORGE_PORTAL_HOME`,
  `~/.forge/installations/forge-portal.json`, `~/.forge/installs/`
  (`portal_core/forge_portal.py:331-372`).
- Reads forge-cli registry `~/.forge-cli/forges/state.json` read-only —
  "forge-cli is the only writer" (`portal_core/forge_portal.py:375-417`).
- All other discovery is delegated to the serving adapter via ops.

### 3.3 How it selects a capability

- `PortalCapability[]` from the adapter's `capabilities()` via
  `GET /capabilities` (`src/app/core/api/api.client.ts:74-76`;
  `portal_core/forge_portal.py:227-228`).
- Client-side `match.service.ts` ranks/search-filter; nav entries may
  declare `requires_capability` (the-forge adapter example at
  `portal_adapter.py:194-197`).

### 3.4 How it executes external commands

- The vendored server **has no exec primitives by design**
  (`portal_core/registry_ops.py:1-6` — pinned by
  `tests/test_security_c5.py`).
- The single exec boundary: `forge-cli` argv arrays for the 9-action
  `_REGISTRY_ACTIONS` allowlist (`install|update|reinstall|uninstall|
rollback|pin|unpin|repair|verify`), `subprocess.run` never shell
  (`portal_core/registry_ops.py:19-77`).
- Execution is plan → confirm → execute with one-time HMAC plan tokens
  (`registry_ops.py:104-158`; `forge_portal.py:433-453,1034-1052`).

### 3.5 How it verifies versions

- Portal does not verify specialist versions itself; versions arrive as
  data in federation/health payloads (`FederationSpecialist.version`
  heuristics at `forges.data.ts:85-95`). **Gap** for spec purposes — no
  independent version probe.

### 3.6 How it handles timeouts

- Per-op `Operation.timeout` (default 30s; registry plan 90s, execute
  320s) enforced by `run_with_timeout` — timed-out handler keeps running
  on its thread, documented honestly (`portal_core/forge_portal.py:176,
769-773,784-799,1006`; `registry_ops.py:164-178`).
- forge-cli subprocess timeouts: 60s plan, 180s/300s execute
  (`registry_ops.py:129,150-153`); `CLI-TIMEOUT` named error
  (`registry_ops.py:61-62`).

### 3.7 How it receives results

- `forge/PortalApi/1` envelope `{schema, correlation_id, data|error}`
  (`forge_portal.py:553-559`); client enforces the schema before unwrap
  (`src/app/core/api/api.client.ts:55-66`).
- CLI JSON = last stdout line parsed (`registry_ops.py:65-84`).
- Per-source async slice: unavailable (404/PORTAL-NOT-FOUND) →
  UNVERIFIED, never crash (`forges.data.ts:17-56`).

### 3.8 How it validates output

- Server: body ≤1 MiB, JSON object, `confirm` literal, `plan_token`
  presence, plan/forge binding before execute (`forge_portal.py:716-758`;
  `registry_ops.py:142-149`).
- `_SAFE_FORGE` regex on forge names (`registry_ops.py:19,115-116`).
- Client: envelope schema check + `ApiError` normalization
  (`api.client.ts:55-66`; `forges.data.ts:12-20`).

### 3.9 How it preserves evidence

- `redact()` scrubs secret-shaped keys on every response/SSE frame
  (`forge_portal.py:460-473,817,856`).
- `forge/PortalEvent/1` bounded in-process event buffer: operation
  start/end/refusal with real timestamps and duration, correlation/span
  ids (`portal_core/telemetry.py`; `forge_portal.py:769-834`; opt-in
  `event_sink`).
- Plan tokens: HMAC-signed, timestamped (15min max age), one-time consume
  (`forge_portal.py:433-453`; `registry_ops.py:144-149`).

### 3.10 How it prevents dangerous delegations

- Loopback-only Host + Origin + session token (128-bit, header or
  SameSite=Strict cookie), DNS-rebinding guard (`forge_portal.py:587-622`).
- POST: `Content-Type: application/json`, mutation rate limit 10/min,
  `confirm` + `plan_token` for mutating ops (`forge_portal.py:48-50,
689-758`; `registry_ops.py:170-178`).
- CSP/XFO/Permissions-Policy/nosniff/no-store on all responses incl.
  error paths (`forge_portal.py:500-544`).
- The CLI argv allowlist is closed — unknown actions refused
  (`registry_ops.py:108-114`).

### 3.11 How it prevents delegation cycles

- N/A — the portal never chains executions; `plan_token` is one-time
  bound to the exact plan (anti-replay, not anti-cycle).

### 3.12 Tests that prove these integrations

- `tests/test_forge_portal.py` — real server, full security matrix over
  HTTP.
- `tests/test_security_c5.py` — §5.7 battery incl. "no exec primitives"
  regression pin.
- `tests/test_telemetry.py` — event recording at real boundaries.
- `tests/test_independence.py`, `test_portal_e2e_harness.py`,
  `test_compat_generations.py` — independence + compat.
- `src/app/pages/explorer/registry-ops-panel.spec.ts`, `e2e/` — UI +
  browser e2e.

---

## 4. Inventory — existing contracts & mechanisms

| Mechanism             | Contract / implementation                                                                                | Where                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agentic manifest      | `forge/SpecialistAgenticManifest/v1` (`forge.agentic.json`)                                              | `the-forge/src/theforge/contracts/specialist.py:13,139-165`; shipped by spark-forge-aws/azure, api-forge, platform-forge, forge-doctor-api/data, **data-sentinel-forge** |
| Specialist lifecycle  | `forge/SpecialistLifecycleState/v1` + transitions                                                        | `the-forge/src/theforge/contracts/specialist.py:12,19-57`; collector `specialists.py:151-268`                                                                            |
| Delegation req/result | `forge/SpecialistDelegationRequest                                                                       | Result/v1`                                                                                                                                                               | `contracts/specialist.py:14-15,168-213`; exec `delegation.py`                             |
| Host activation       | `forge/HostActivationPlan                                                                                | Receipt/v1`                                                                                                                                                              | `contracts/specialist.py:16-17,216-246`; `cli/commands.py:1724-1793`                      |
| Forge Protocol        | subprocess `<argv> <op>`, JSON stdio, `theforge/ForgeManifest/v1`                                        | `protocol/transport.py`, `protocol/proctree.py`, `contracts/manifest.py:16,155-209`                                                                                      |
| Provider registry     | `providers.toml` entries + trust + sha256-bound cache `theforge/RegistryCache/v2`                        | `registry/config.py`, `registry/registry.py`                                                                                                                             |
| Remote discovery      | `theforge/RegistryDocument/v1`, `ForgeRegistryEntry/v1`, `RemoteProviderCandidate/v1`                    | `contracts/registry.py`; `registry/discovery.py`, `registry/sources.py`                                                                                                  |
| Capability routing    | `RoutingDecision`, `CapabilityNegotiationResult`, signals/negotiation                                    | `routing/router.py`, `negotiation.py`, `contracts/routing.py`                                                                                                            |
| Handoff               | `theforge/Handoff/v1` (plan-node evidence bus)                                                           | `contracts/handoff.py`; `planning/handoff.py`                                                                                                                            |
| Agent orchestration   | `AgentSpec` registry + authority gate                                                                    | `agents.py`; `agentic/agents/*.toml`                                                                                                                                     |
| MCP                   | `theforge/McpServerEntry                                                                                 | RegistryDocument/v1`; `mcp_requires`; stdio probe                                                                                                                        | `contracts/mcp.py`, `registry/mcp.py`, `interop/mcp.py`; `forge-cli/src/mcp/handshake.ts` |
| Install receipts      | `install.json` + `state.json` (`forge-cli`), `~/.forge/installations/*.json` (bootstrap)                 | `forge-cli/src/registry/install.ts:80-198`; `the-forge/src/theforge/_installkit.py:1352-1408`                                                                            |
| Install plans         | `theforge/InstallationPlan/v1` + `/v2` (approval-gated, plan-only)                                       | `contracts/installation.py`; `registry/install_plan.py`                                                                                                                  |
| Skills/agents         | `agents.py` AgentSpec + host adapters list in manifests                                                  | `the-forge/src/theforge/agents.py`; `specialists.py:152-158`                                                                                                             |
| Result formats        | `theforge/ExecutionResult/v1` (findings/evidence/artifacts)                                              | `contracts/result.py`                                                                                                                                                    |
| Governed execution    | trust gates, `safe_env`, approval plans, remote policy, receipts                                         | `registry/registry.py:206-215`, `security/env.py`, `remote.py`                                                                                                           |
| Evidence contracts    | `ExecutionReceipt/v1`, `Handoff/v1`, `ProviderReceipt`, run artifacts                                    | `contracts/receipt.py`, `runs/store.py`                                                                                                                                  |
| Token economy         | `RunBudget/v1`, profiles economy/balanced/max, context broker, `ProviderEconomyReceipt`, `EconomyRollup` | `contracts/budget.py`, `economy.py`, `profiles.py`, `context/broker.py`, `contracts/economy.py`                                                                          |
| forge-cli contracts   | `forge/ForgeDescriptor                                                                                   | ForgeCapability                                                                                                                                                          | ForgeInstallContract                                                                      | ForgeEnvironmentSchema | ForgeHostDescriptor | ForgeOperationPlan | ForgeOperationReceipt | ForgeHealthReport/v1` | `forge-cli/contracts/schemas/*.json`, `contracts/CONTRACTS.md` |
| Portal API            | `forge/PortalApi/1`, `forge/PortalEvent/1`, `forge-cli/RegistryState/v1`, `forge/FederatedGraph/v1`      | `portal_core/forge_portal.py:38-47`, `telemetry.py`, `forge-portal/src/app/core/graph/federated.ts`                                                                      |
| Remote/A2A            | `RemoteExecutionRequest                                                                                  | Receipt`, A2A AgentCard bridge                                                                                                                                           | `the-forge/src/theforge/remote.py`, `interop/a2a.py`                                      |

---

## 5. Exists vs. `prompt_evo_integrations.md` — gap list

| Spec asks for                                                                                                                              | Status today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forge/SpecialistCapability/v1` (id, description, in/out schemas, entrypoint, permissions, network, cost, timeout, discovery+verify modes) | **ABSENT** — nearest is `Capability` inside `theforge/ForgeManifest/v1` (`contracts/manifest.py:96-144`: actions, state, operation_class, signals, relations) plus `forge/ForgeCapability/v1` (forge-cli `contracts/schemas/ForgeCapability.v1.json`: id/state/requires only). No per-capability input/output schema, entrypoint argv, cost or timeout fields.                                                                                                                                                          |
| `forge/SpecialistDelegation/v1` (consumer→provider optional intents + policy)                                                              | **ABSENT** — only the imperative pair `SpecialistDelegationRequest                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Result/v1` exists; no declarative consumer-side intent/policy contract. |
| `forge/EvidenceHandoff/v1` (correlation id, idempotency, provider versions, confidence, limitations, redaction)                            | **PARTIAL** — `theforge/Handoff/v1` is a plan-node evidence bus with provenance/epistemic/dedup (`contracts/handoff.py`), not a specialist↔specialist envelope; no correlation_id/idempotency key on `DelegationRequest` (`contracts/specialist.py:168-187`).                                                                                                                                                                                                                                                           |
| Universal discovery w/ states NOT_INSTALLED…UNTRUSTED                                                                                      | **PARTIAL** — the-forge lifecycle covers UNKNOWN/DISCOVERED/NOT_INSTALLED/INSTALLABLE/INSTALLED/CONFIGURED/REGISTERED/HEALTHY/DEGRADED/FAILED (`contracts/specialist.py:19-37`); forge-cli has 7 DiscoveryStates incl. `integrated` (`forge-cli/src/contracts/negotiate.ts:77-85`). **Missing:** `VERIFIED` as a distinct state and `UNTRUSTED` as a _discovered_ state (unverified entries exist but are never executed — `registry/registry.py:208-215`); no PyPI/pipx/entry-point probing beyond the two registries. |
| Specialist→specialist runtime delegation (Data Sentinel ↔ Spark Forge)                                                                     | **ABSENT** — only control-plane→specialist exists (`task run` fan-out, `install auto`). Specialists cannot call each other; no consumer-side delegation adapter exists in any specialist codebase (out of scope here but confirmed absent in core).                                                                                                                                                                                                                                                                     |
| Cycle prevention (depth, correlation, visited providers, max hops, cancellation)                                                           | **ABSENT for delegation** — plan DAG cycle check exists (`planning/order.py:34-38`), correlation_id exists only in telemetry (`contracts/telemetry.py:182`). No `visited_providers`/`delegation_depth`/`max_hops`/`timeout budget` fields on DelegationRequest.                                                                                                                                                                                                                                                         |
| Risk classes LOCAL_READ/LOCAL_WRITE/EXTERNAL_READ/EXTERNAL_WRITE/DESTRUCTIVE/COST_BEARING                                                  | **ABSENT as closed vocabulary** — `Capability.operation_class` exists (`contracts/types.py` OperationClass; `_MUTATING` at `negotiation.py:46`) and `DelegationEntry.read_only` (`contracts/specialist.py:136`); no six-level risk enum, no per-op authorization policy wired to it.                                                                                                                                                                                                                                    |
| Timeout/cancellation/output limits on delegated CLI calls                                                                                  | **PARTIAL** — fixed 600s timeout + 20-line stdout/stderr tail (`delegation.py:26-27,83-118`); no per-request timeout, cancellation, or output byte caps. Transport has 8 MiB stdout cap + tree kill (`protocol/transport.py:26-31,163-192`).                                                                                                                                                                                                                                                                            |
| Provider health                                                                                                                            | **EXISTS** — `health` op + `HealthReport` (`registry/health.py`); MCP level chain in forge-cli (`mcp/handshake.ts:13-19`).                                                                                                                                                                                                                                                                                                                                                                                              |
| `data-sentinel` in ecosystem                                                                                                               | **ABSENT from catalogs** — has `forge.json` + `forge.agentic.json` (checkout) but no the-forge adapter, no `forge-knowledge` package, no forge-cli `FORGE_REPOS`/`REGISTRY_PACKAGES` entry, no `ecosystem-compatibility.json` row.                                                                                                                                                                                                                                                                                      |
| Evidence preservation                                                                                                                      | **EXISTS and strong** — RunStore artifacts, ExecutionReceipt hash-binding, delegation records; forge-cli receipts w/ atomic writes + quarantine.                                                                                                                                                                                                                                                                                                                                                                        |
| Token economy                                                                                                                              | **EXISTS** — RunBudget + profiles + context broker + ProviderEconomyReceipt.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| MCP tools discovery                                                                                                                        | **EXISTS** — contract (`contracts/mcp.py`), source reads (`registry/mcp.py`), allowlisted probe (`forge-cli/src/mcp/handshake.ts`), `mcp_safe_tools` catalog field.                                                                                                                                                                                                                                                                                                                                                     |
| Install receipts                                                                                                                           | **EXISTS** — two formats: bootstrap `~/.forge/installations/<id>.json` and forge-cli `~/.forge-cli/forges/{install.json,state.json}`; the-forge already bridges both (`specialists.py:37-56`).                                                                                                                                                                                                                                                                                                                          |
| Agents/skills awareness                                                                                                                    | **PARTIAL** — AgentSpec registry + authority gate (`agents.py`); manifest declares skills/agents/coordinators + host_adapters; no per-specialist delegation guidance ("when to call X") in any coordinator doc — spec Phase 11 work.                                                                                                                                                                                                                                                                                    |
| Governed execution                                                                                                                         | **EXISTS** for protocol providers (trust, safe_env, approval, remote policy); **PARTIAL** for argv delegation (trust/approval only — no risk classes, no capability allowlist, no input-size caps).                                                                                                                                                                                                                                                                                                                     |

_Audit produced for lf-0026 Phase 0; read-only — no source files were modified._
