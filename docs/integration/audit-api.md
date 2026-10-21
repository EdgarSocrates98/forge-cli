# Audit — Cross-Forge Integration Surfaces, API domain (lf-0026, Phase 0)

Read-only audit for the Loop Factory spec `prompt_evo_integrations.md`
(cycle 13). Scope: `api-forge`, `forge-doctor-api`, `platform-forge` — with
the consuming surface in `the-forge/adapters/` cited where it answers a
question the specialist itself cannot. Every claim cites `file:line`.
Surfaces the spec expects that do not exist are marked **ABSENT**.

Baseline SHAs (main): api-forge `04c4748` · forge-doctor-api `65b8814` ·
platform-forge `902c231` · the-forge `679fc4f` (adapter context) ·
forge-cli `f0224a0`.

Companion document: `audit-core.md` covers `the-forge`, `forge-cli`,
`forge-portal` (provider registry, transport, lifecycle ladder).

---

## 1. api-forge — the engineering specialist

Source root `src/apiforge/` (CLI `apiforge`, MCP `apiforge-mcp`,
`pyproject.toml` scripts). State dir `.apiforge/`, refusal vocabulary
`AF-*` (cataloged in `docs/catalog-contract.md`, ~40 families tabulated).

### 1.1 What it already knows about other specialists

- Declared interop peers live in `src/apiforge/rules/forge_protocol.yaml:8`:
  `engines: [spark-forge, the-forger]` — the only two engines a handoff may
  target (`prepare_handoff` refuses anything else,
  `src/apiforge/forge/protocol.py:305-309`, `AF-FORGE-ENGINE-UNKNOWN`).
  **`forge-doctor-api` is not a declared peer.**
- Its evidence intake is designed for The Forge's handoff channel:
  `UPSTREAM_EXTRACTOR = "theforge/handoff"`
  (`src/apiforge/application/analyze.py:69`); test docstring names the
  scenario "The Forge handing Spark Forge evidence to API Forge"
  (`tests/application/test_upstream_facts.py:1-7`).
- `run_tools.py` knows generic OSS scanners only — semgrep, trivy,
  gitleaks, k6 (+import-only locust/jmeter/gatling/vegeta/wrk/wrk2/hey/
  pytest-benchmark) (`src/apiforge/run_tools.py:56-85,99-335`). **No forge
  CLI is in the runner or the registry.**
- Agent roster `agents/*.md` (26 coordinators + `agents/executors/af-*.md`
  ×5): zero references to `forge-doctor*`/`doctor-api` (grep over
  `agents/`, `docs/`, `knowledge/`, `evals/` — no hits).
- `forge.agentic.json:1-45` publishes itself as
  `forge/SpecialistAgenticManifest/v1` with two workflows
  (`analyze` DIRECT_CAPABILITY, `doctor` DIAGNOSTIC_ONLY) and empty
  `skills`/`agents`/`coordinators` arrays.

### 1.2 How it discovers installed tools

- `run list` reports each registry row with *measured* install status —
  `shutil.which(binary)` at query time, never declared
  (`src/apiforge/run_tools.py:396-408`, comment at `88-98`).
- `apiforge doctor` probes `git` and `apiforge-mcp` on PATH plus state-dir
  writability (`src/apiforge/distribution/doctor.py:54-65`). Network is
  reported `unavailable`/`unresolved`, never probed (`doctor.py:66-87`).
- **ABSENT:** any discovery of sibling forges (`forge-doctor-api`,
  spark-*, platform-forge). Nothing scans for peer CLIs or reads their
  `forge.agentic.json`.

### 1.3 How it selects a capability

- Public matrix `rules/capability_matrix.yaml` loaded and schema-checked
  by `load_capabilities()` (`src/apiforge/capabilities/registry.py:32-50`;
  `AF-CAPABILITY-MATRIX`, `AF-CAPABILITY-CONTRACT`).
- `capabilities verify` independently re-checks the matrix — duplicates,
  missing limitations/verifier/documentation, unsupported-without-evidence
  (`src/apiforge/capabilities/verify.py:14-39`).
- Agent routing is data, not judgment: `rules/catalog/routing.yaml` rows
  `(phase, dominant_area) → recommended_agent`; no route →
  `AF-ROUTING-NO-ROUTE` (`src/apiforge/application/next_step.py:58-134`).
- Forge Protocol `discover_capabilities()` projects the matrix into
  `apiforge/forge-capability-descriptor/v1` wire rows
  (`src/apiforge/forge/protocol.py:91-104`).

### 1.4 How it executes external commands

- `apiforge run tool` is the *only* verb family executing external
  binaries: closed argv-template table, `shutil.which` resolution,
  `subprocess.run(argv, capture_output=True, text=True, timeout=…)` —
  **no shell** (`src/apiforge/run_tools.py:1-8,411-467`; CLI wiring
  `src/apiforge/cli.py:2842-2873`).
- Load-generator runs (k6) are gated by `_load_target_gate`: URL literals
  inside the script decide `local_reversible` vs `sensitive`, and remote/
  unresolvable targets go through `policy.decide` → `AF-RUN-PROD-GATE`
  (`run_tools.py:341-393`).
- `_installkit.py` (vendored from the-forge) runs pip/venv subprocesses
  under a spawn gate — `FORGE-INSTALL-SPAWN-DISABLED` where subprocess is
  banned (`src/apiforge/_installkit.py:1471-1532`).
- Network reads go through injected GET-only transports
  (`src/apiforge/integrations/transport.py`; adapters in
  `integrations/external.py:41-150`); `UrllibReadOnlyTransport` uses
  `urlopen(req, timeout=10)` (`src/apiforge/integrations/github.py:55-70`).

### 1.5 How it verifies versions

- After each `run tool`, it probes `[binary, "--version"]` with a 10 s
  cap; failure leaves `tool_version: null` — "version unproven — stays
  null, never guessed" (`src/apiforge/run_tools.py:480-492`).
- Registry rows deliberately carry no version pin (`run_tools.py:91-92`).
- `--version` prints the package version for consumers.

### 1.6 How it handles timeouts

- `--timeout` on `run tool` (CLI default 300 s,
  `src/apiforge/cli.py:2851`) → `subprocess.TimeoutExpired` ⇒
  `AF-RUN-TIMEOUT` (`run_tools.py:468-469`).
- Version probe 10 s (`run_tools.py:486`); GitHub transport 10 s
  (`integrations/github.py:55`).

### 1.7 How it receives results

- `run tool` requires the report file the tool was told to write
  (`AF-RUN-NO-REPORT`, `run_tools.py:471-476`), then feeds it to the same
  offline typed reader used by `model <tool>` (`run_tools.py:494-508`),
  returning `exit_code`, `stderr_tail` (300 chars), argv and parsed
  facts/diagnostics.
- Cross-engine results enter as **files**: `--upstream
  upstream-facts.json` on `analyze` (`cli.py:898-901`) carrying
  `apiforge/upstream-facts/v1` bounded foreign facts.
- Forge Protocol `retrieve_result` maps the governed `OutcomeBrief` onto
  `ForgeTaskResult` (`ok|review|blocked|failed|unresolved`) with gaps and
  limitations preserved (`forge/protocol.py:198-235`).

### 1.8 How it validates output

- Typed readers (`apiforge.adapters.secreports.extract_*`,
  `testreports.extract_*`) parse scanner JSON into `CodeInventory`
  (facts + diagnostics), never raw passthrough (`run_tools.py:494-508`).
- Upstream intake is three-layer: bound check (≤256 KiB, ≤128 items —
  `AF-UPSTREAM-LIMIT`), schema check (`AF-UPSTREAM-INVALID`), and
  `_check_upstream` marking + anti-laundering + `_FORBIDDEN_KEYS`
  instruction-smuggling refusal (`AF-UPSTREAM-UNMARKED`,
  `AF-UPSTREAM-FORBIDDEN`) (`cli.py:468-505`;
  `application/analyze.py:79-169`).
- Evidence receipts re-hash every listed artifact
  (`AF-EVIDENCE-MISSING`/`AF-EVIDENCE-MISMATCH`,
  `src/apiforge/evidence/verify.py:13-47`).

### 1.9 How it preserves evidence

- `save_case` persists the full `CasePayload` — including upstream facts
  with provenance — so downstream verbs (`graph`, `evidence`, `brief`,
  `judge --facts`) see them but the judged model never does
  (`application/analyze.py:258-267`, docstring `221-230`).
- `retrieve_evidence` emits a content-addressed bundle: every artifact
  `path + sha256`, missing pieces named in `unresolved`
  (`forge/protocol.py:242-291`).
- Forge task store is append-only (`request.json`, `status.json`,
  `events.jsonl` + `store.append_event`,
  `forge/protocol.py:128-130,155-164,330-338`).
- Every MCP call records `payload_bytes` in the economy ledger
  (`src/apiforge/mcp/tools.py:22-39`); handoff bundles carry
  `evidence_refs` as `path#sha256:` pointers (`forge/protocol.py:321`).

### 1.10 How it prevents dangerous delegations

- Runner is allowlist-first: unknown tool → `AF-RUN-TOOL-UNKNOWN`;
  import-only entries → `AF-RUN-IMPORT-ONLY` with the manual path
  (`run_tools.py:433-448`).
- semgrep refuses `--config auto` to keep the run offline
  (`AF-RUN-CONFIG-MISSING`, `run_tools.py:29-32`).
- Policy engine `allow|gate|deny` with reason codes
  (`AF-POLICY-CLASS-UNKNOWN`/`AF-POLICY-DENY`/`AF-POLICY-GATE`,
  `src/apiforge/policy/decide.py:49-107`); gates only clear when the
  caller supplies every required field (`decide.py:95-107`).
- Tool authorization is default-deny per role:
  `rules/tool_risk.yaml` profiles + permission sets, `authorize()`
  returns `AF-TOOL-*` refusals with field + unlock — including
  `delegated_from`/`delegated_scope` checks so a delegatee can only use
  the delegated subset (`src/apiforge/trust/tools.py:54-231`;
  `delegates_to` at `tool_risk.yaml:698`).
- Forge submit gates declared risk classes — `risk_gate: [sensitive,
  external_mutation, destructive, irreversible]` requires
  `--acknowledge-risk` (`rules/forge_protocol.yaml:6`;
  `forge/protocol.py:122-127`, `AF-FORGE-RISK-GATE`).
- Evidence transport can never carry instructions: closed
  `_FORBIDDEN_KEYS` vocabulary (`command`, `prompt`, `routing`, `task`,
  `tool_call`, `workflow`, …) scanned recursively, iterative because
  "payload depth is adversary-controlled"
  (`application/analyze.py:79-130,161-169`).

### 1.11 How it prevents delegation cycles

- Role-level: `delegates_to` is an explicit declared edge — a delegator
  may only empower named delegatees, and scope narrows
  (`trust/tools.py:167-190`); the graph itself is static config, so no
  runtime traversal can loop.
- Governed runtime: recovery depth is **bounded at one** — a failed
  recovery produces a `skipped` receipt (`AF-GOV-RECOVERY-DEPTH`) instead
  of a second recovery pass (`src/apiforge/runtime/supervisor.py:866`
  docstring, seq bound `868+`).
- Cross-engine: `prepare_handoff` never performs a live call — delivery
  is a human/transport step recorded in `unresolved`
  (`forge/protocol.py:14-16,294-339`). **ABSENT:** correlation id, visited
  providers, max hops on the wire contract (`ForgeHandoff` carries
  `handoff_id`, no hop budget — `contracts/forge_protocol.py`).

### 1.12 Which tests prove these integrations

- `tests/forge/test_protocol.py` — capabilities projection, submit
  persist/refusals (`AF-FORGE-CAPABILITY-UNKNOWN`, `AF-FORGE-RISK-GATE`,
  `AF-FORGE-TASK-EXISTS`, `AF-FORGE-POLICY`), attach/inspect/result/
  evidence/handoff (`AF-FORGE-ENGINE-UNKNOWN`), health.
- `tests/test_run_tools.py` — allowlist refusal, fixed argv, dry-run,
  missing binary, timeout, run-then-read through the reader.
- `tests/application/test_upstream_facts.py` — marked intake, forbidden
  keys refused, foreign facts persisted but never judged.
- `tests/trust/test_tools.py:90-101` + `tests/runtime/test_tool_authorization.py`
  — delegation scope fail-closed, role authorization.
- `evals/corpus/forge-protocol/*.yaml` (4 cases: lifecycle, refusals,
  risk-and-unresolved, completed-run) driven by
  `src/apiforge/evals/forge_protocol.py:186`; adversarial delegation
  params in `src/apiforge/evals/security_adversarial.py:101-104`.
- **ABSENT:** any test naming `forge-doctor-api` or a doctor→apiforge
  delegation case.

---

## 2. forge-doctor-api — the deterministic diagnostics specialist

Source root `src/forge_doctor_api/` (CLI `forge-doctor-api` =
`forge_doctor_api.cli:main`; `pyproject.toml` `[project.scripts]`).
Tagline in code: "Deterministic, offline-first API architecture
intelligence" (`src/forge_doctor_api/cli/__init__.py:64`).

### 2.1 What it already knows about other specialists

- Routing contract knows its consumers: `_DOMAIN_HANDLERS = {"api":
  "api-forge", "data": "data-doctor"}` and chains
  `("doctor-api","api-forge")`, `("doctor-api","data-doctor"[, "spark-forge"])`
  for implementation-grade data work
  (`src/forge_doctor_api/handoff/routing.py:19-27,30-84`). Docstring is
  explicit: "The Doctor declares routes — The Forger executes them"
  (`routing.py:6-7`).
- `forge.agentic.json:1-47` self-describes: provider `forge-doctor-api`
  v0.2.2, workflows `scan`/`diagnose` both `DIAGNOSTIC_ONLY` +
  `read_only: true`, `mcp_command: ["{cli}","mcp"]`.
- `contracts/adapters.py` emits the shared `forge-contracts/1` wire
  vocabulary; its docstring states the boundary: "No `forge_doctor_data`
  import exists anywhere in this package: the doctors share the published
  contract, not each other's internals" (`contracts/adapters.py:1-9`).
- `_installkit.py` is vendored from the-forge
  (`src/forge_doctor_api/_installkit.py:3`); the TUI optionally imports
  `theforge.install.service` for the install flow
  (`src/forge_doctor_api/ui/wizard.py:292-303`).
- **It knows consumers by name but never calls them** — no discovery,
  no subprocess, no client for api-forge.

### 2.2 How it discovers installed tools

- Plugins only: `importlib.metadata.entry_points(group=…)`
  (`src/forge_doctor_api/plugins/registry.py:112`) — its own extension
  mechanism, not forge discovery.
- `shutil.which` checks git/hosts inside the TUI wizard
  (`ui/wizard.py:81-83`, `ui/home.py:54`).
- **ABSENT:** sibling-forge discovery — it is designed to be discovered
  (manifest + `mcp` server), not to discover.

### 2.3 How it selects a capability

- `scan` runs the full deterministic pipeline — every analyzer; there is
  no per-request capability selection
  (`cli/__init__.py:129-235`, `scan_project` at `scan.py`).
- Detected capabilities are *observed output*, not negotiated input:
  `report.capabilities: [DetectedCapability]`
  (`docs/output-contract.md` report table; `handoff/model.py:131-136` maps
  them to `ForgeCapability` = name + status + unknowns).
- Consumers select via `ForgeRequest.capabilities` / `context_refs` /
  `delta` (protocol v2 slimmed request, `handoff/protocol.py:1-14`).

### 2.4 How it executes external commands

- **It doesn't, on the scan path.** `DoctorBoundary` docstring: "no
  network, no subprocess, no dynamic import, no target-code execution"
  (`src/forge_doctor_api/handoff/boundary.py:16-24`); enforced at AST
  level by `tests/test_boundary.py:124` (`test_package_ast_purity`) and
  `:196` (`test_boundary_ast_purity`), `:220` (no dynamic imports).
- Residual subprocess use is install/TUI lifecycle only:
  `install/service.py:22,240` (venv pip, `spawn_ok` gate),
  `ui/home.py:77,140` (runs its *own* CLI argv, `timeout=120`),
  `ui/tui.py:65-68` (TimeoutExpired handled). None touches analysis.
- `forge-doctor-api mcp` serves over stdio and requires the `mcp` extra
  (`cli/__init__.py:1364-1387`; `pyproject.toml:33` `mcp = ["mcp>=2.0,<3"]`).

### 2.5 How it verifies versions

- `--version` eager flag prints `forge-doctor-api {__version__}`
  (`cli/__init__.py:96-99`).
- Every export carries `tool_version` + `knowledge_versions`
  (`output/writers.py:30-49,97-102`; `export_findings` §174).
- Protocol versioning is strict: `PROTOCOL_VERSION = 2`,
  `_SUPPORTED_VERSIONS = (1, 2)` — v1 payloads still parse, emission is
  always v2; anything else → `ProtocolError`
  (`handoff/protocol.py:23-24,48-51`).
- **It never probes another tool's version** — consuming engines get
  `schema_version`/`tool_version` in-band and must compare themselves.

### 2.6 How it handles timeouts

- **ABSENT by design on the analysis path** — deterministic local
  compute, nothing external is awaited (boundary purity above).
- Only operational timeouts exist: `factory/self_scan.py:39`
  (`timeout=1800` on its own dogfood scan), `ui/home.py:140`
  (`timeout=120`).
- For consumers, the MCP surface bounds *response size*, not time:
  `MCP_RESPONSE_BUDGET` with deterministic truncation recorded as
  `UnknownFact`s (`handoff/mcp_server.py:43,77-87`).

### 2.7 How it receives results

- It is the producer. `scan_project` → `ScanReport`; the five export
  surfaces (`console|json|jsonl|sarif|agent|report`) project it
  (`cli/__init__.py:214-232`).
- For the delegation surface, `DoctorBoundary` exposes four shapes over
  one scan: `handle()` → bounded `ApiHandoffBundle`; `envelope()` →
  `ForgeHandoff`; `endpoint_dict()` → `{request, handoff, capabilities,
  manifest}` (`handoff/boundary.py:45-141`).
- Incoming side: `ForgeRequest.parse` — strict, unknown fields rejected
  unless `x-*`, `ProtocolError` never silent coercion
  (`handoff/protocol.py:29-51`).

### 2.8 How it validates output

- `bundle.bounded()` — deterministic size caps per section; every
  truncation appends a `budget_exceeded` `UnknownFact`, "nothing is
  dropped silently"; V2 recomputes the content hash
  (`handoff/model.py:152-175`).
- `ForgeHandoff.parse` / model `parse_*` reject unknown fields and bad
  versions (`handoff/protocol.py:33-51`).
- SARIF emitted only for location-anchored findings — `skipped_no_location`
  counted, never fake locations (`output/writers.py:68-70,98-103`).
- Contract conformance: `tests/test_output_contract.py` enforces the
  five frozen surfaces of `docs/output-contract.md` (evolution rules:
  additive-only in v1, break ⇒ v2; ids stable namespaced check ids).

### 2.9 How it preserves evidence

- Finding schema carries `evidence[]` (`{kind, source, line?, summary}`),
  `entity_ids`, `source_location`, `evidence_kind` tier (STATIC/CONFIG/
  OBSERVED_METADATA/RUNTIME/DERIVED), `unknowns[]`
  (`docs/output-contract.md` shared types).
- V2 bundle is content-addressed: `handoff_id` = sha256 of body,
  `analysis_rev` = sha256 of source report, per-domain
  `domain_sha256`, `doctor://` context refs (`handoff/model.py:107-150`;
  `body_sha256` V1-body-only so identity survives projections).
- Incremental revalidation is native: `RequestDelta{baseline_ref,
  changed_files}` → `compute_delta(baseline, report)`; unresolvable
  baseline degrades to an explicit unknown, "never a fabricated delta"
  (`handoff/boundary.py:57-88`; `handoff/delta.py`).
- `factory/runs/` records dogfood runs; `factory/self_scan.py` is the
  self-scan shape-diff gate (baseline `factory/runs/doctor-self-scan.json`).

### 2.10 How it prevents dangerous delegations

- Structural non-goals: the boundary "contains no method that routes work
  to another component, schedules or retries anything, implements/edits/
  generates code in the target repo, calls out"
  (`handoff/boundary.py:16-24`).
- `scan` is read-only; `--fail-on` only changes the exit code — the
  report is identical (`cli/__init__.py:185-235`). Remediation is a hint
  field, "never an applied fix" (`docs/output-contract.md` Finding table).
- `mcp` tools return compact JSON, errors as data, budget-truncated with
  recorded unknowns (`handoff/mcp_server.py:3-9,43-87,132-148`).
- The `safefix` package exists separately and is not on the scan/handoff
  path — consumers cannot trigger mutation through the delegation
  surface.

### 2.11 How it prevents delegation cycles

- Trivially: it emits route *declarations* (`ForgerRoute.chain`) but
  executes none of them — cycles cannot form inside the Doctor
  (`handoff/routing.py:1-7`).
- `doctor://` context refs are bounded depth-1 graph slices
  (`handoff/context.py:206`).
- **ABSENT:** hop budget/correlation fields in `ForgeRequest` — a
  request carries `capabilities`/`context_refs`/`delta`, no visited-set.

### 2.12 Which tests prove these integrations

- `tests/test_boundary.py` — package + boundary AST purity (no
  network/subprocess/dynamic import), boundary doc exists.
- `tests/test_handoff.py` — bundle compact+versioned, unknowns present,
  redaction, external-reference-is-reference-only,
  `test_forger_routes_api_domain` (`:148`),
  `test_forger_routes_data_dependency` (`:154`),
  `test_forger_unknown_domain_declared` (`:166`), MCP-local surface.
- `tests/test_handoff_v2.py`, `tests/test_protocol.py`,
  `tests/test_delta.py` — v2 identity, strict parsing, incremental delta.
- `tests/test_mcp_boundary.py` — real JSON-RPC over in-memory streams:
  handshake, method-not-found, param errors, deterministic truncation
  with `UnknownFact`s, no Python exception text on the wire.
- `tests/test_determinism.py`, `tests/test_output_contract.py`,
  `tests/test_scan.py`, `tests/test_cli_contract.py` — byte-identical
  outputs, frozen surfaces, exit codes.
- `factory/self_scan.py` + `factory/mcp_smoke.py` — dogfood gates: real
  CLI `scan . --format report` shape-diffed vs recorded baseline; raw-
  garbage stdio MCP smoke.

---

## 3. platform-forge — platform intelligence (complementary fit)

Source root `platformforge/` (CLI `platformforge`, MCP
`platformforge-mcp`). Evaluated for complementary integration only — per
the spec, no specialist fit forced.

### 3.1 What it already knows about other specialists

- `KNOWN_FORGES` — a hard-coded sibling table:
  `api-forge` → `apiforge capability manifest`,
  `spark-forge-aws` → `sparkforge-aws capability manifest`,
  `platform-forge` → `platformforge forge manifest`
  (`platformforge/forge/collect.py:15-21`). **`forge-doctor-api`,
  `forge-doctor-data`, `data-sentinel`, `spark-forge-azure` are not
  known.**
- Its cross-forge contract is declared in-band:
  `delegation_contract()` lists `accepts` (change-intent,
  runbook-request, observation-request, policy-eval-request,
  fleet-summary-request, analytics-report-request,
  optimization-list-request) and `refuses` (direct-execution,
  approval-minting, shell-command, generic-provider-call,
  full-fleet-dump, credential-transfer) with
  `PF-OPS-CROSSFORGE-REFUSED` (`platformforge/ops/registry.py:63-77`,
  `validate_delegate_request` :78-110).
- `forge.agentic.json:1-45` self-describes (provider `platform-forge`,
  workflows `analyze`/`doctor`, `mcp_command: platformforge-mcp`).

### 3.2 How it discovers installed tools

- `forge discover` scans sibling checkouts by pyproject name marker
  (`platformforge/forge/collect.py:24-41`).
- `forge collect` probes the sibling's CLI via `shutil.which`, else
  refuses `platform.forge.cli_missing` with `pip install -e <root>` as
  unlock; unrecognized roots → `platform.forge.unknown` with "extend
  KNOWN_FORGES" as unlock (`collect.py:44-76`).
- `platformforge hosts` observes AI host binaries — read-only; launching
  stays a CLI+TTY human boundary (`mcp/registry.py:305-312`;
  `distribution/hostflow.py:65-99`).

### 3.3 How it selects a capability

- `CAPABILITIES` registry (38 tools) — every tool declares
  `input_schema`, `risk` (read|simulate|guarded), `offline`, `mutable`,
  `evidence_required`, `cost_class`, `agent_requirements`, output
  `bounds` (`platformforge/mcp/registry.py:11-45,107-374`).
- `platformforge capability list|describe|check|manifest` projects the
  same registry the MCP adapter reads — "Parity is tested, not assumed"
  (`CAPABILITIES.md`; `cli/main.py:1707-1770`).
- `capability check` is the §139 negotiation verb: "can you analyze X at
  version Y?" → `supported` + matching contracts + `version_note`;
  absent → `platform.capability.unresolved` (`cli/main.py:1727-1766`).

### 3.4 How it executes external commands

- `host_transport()` — the single host boundary: argv-only
  `subprocess.run`, **never `shell=True`**, `timeout=300` default,
  rc 124 on timeout, 127 on missing binary
  (`platformforge/ops/executors/base.py:188-209`). Executors build argv;
  transports are injected into the engine.
- `forge collect` runs the sibling's own manifest verb:
  `subprocess.run([cli, *manifest_cmd, "--format","json"], timeout=30)`
  (`forge/collect.py:57-62`).
- `capability_manifest` shells `git rev-parse --short HEAD` for the
  `commit` field, `OSError → "unknown"` (`forge/manifest.py:22-26`).

### 3.5 How it verifies versions

- `_supported_versions()` — only versions the knowledge
  `SourceRegistry` has evidence for; "Absence … means 'unresolved', not
  'unsupported'" (`forge/manifest.py:94-106`).
- `capability check --version` returns `known_sources` with per-source
  `freshness()` plus the caveat "version support is evidence-bound —
  unknown versions degrade to unresolved, not assumed"
  (`cli/main.py:1753-1765`).

### 3.6 How it handles timeouts

- Host transport `timeout_s` per action spec, 300 s fallback
  (`ops/executors/base.py:163,197-209`; timeout → rc 124).
- Sibling manifest collection `timeout=30`
  (`forge/collect.py:45,59-62`).
- Host-launch flow catches `subprocess.TimeoutExpired`
  (`distribution/hostflow.py:99`).

### 3.7 How it receives results

- Sibling manifests: subprocess stdout → `json.loads`, parse failure
  degrades to `{"raw": stdout[:4000]}` (`forge/collect.py:63-70`).
- Sibling facts: `ingest_facts` wraps foreign fact dicts marking
  `attrs.external_forge` and forcing `tier ≥ 3` — "we never claim their
  evidence as ours" (`forge/collect.py:79-88`).
- Inbound delegations: `verify_envelope` accept/reject on required
  fields + `platformforge/a2a-envelope/v1` schema
  (`forge/delegate.py:54-60`); `validate_delegate_request` normalizes or
  refuses (`ops/registry.py:78-110`).

### 3.8 How it validates output

- Envelope validation is schema + presence, not content trust:
  missing fields named in `missing[]`, `platform.envelope.invalid`
  (`forge/delegate.py:54-60`).
- Every governed stage emits receipts into the `OperationLedger`
  (`ops/engine.py:9`); stage refusals propagate named
  (`PF-OPS-ENVELOPE-UNGOVERNED` :132, `PF-OPS-POLICY-BLOCK` :137,
  `PF-OPS-ENVELOPE-INVALID` :161).
- `platformforge/result-receipt/v1` closes a delegation — carries
  `result`, `evidence_facts`, `unresolved`, `receipt_id`
  (`forge/delegate.py:63-77`).

### 3.9 How it preserves evidence

- `evidence_required=True` is the registry default — findings need
  evidence fact_ids (`mcp/registry.py:30`); `required_evidence` declares
  tiers 0-5 only (`forge/manifest.py:39-40`).
- Operation store: `OperationStore` + `load_ledger`/`verify` per
  operation id (`cli/main.py` ops status/history ~2374-2398).
- Economy receipts: `platformforge/economy-validation-receipt/v1`
  (`economy/doctor.py:22`), freshness bound to HEAD/HEAD~1
  (`economy/doctor.py:132-158`); plan receipts bind decision→plan hash
  (`economy/plan.py:125-126`).
- `RollbackMaterial` captured per mutating step (`ops/engine.py:309+`;
  `ops/rollback.py`, `ops/rollback_builders.py`).

### 3.10 How it prevents dangerous delegations

- The `platformforge_ops` MCP surface is **PREPARE-only by contract**:
  "Execution and approval signing are refused on this surface"
  (`mcp/registry.py:340-344`). Execution lives behind `ops run --execute`
  on the CLI with `--offline` → `PF-OPS-OFFLINE`
  (`cli/main.py:~2340`; same guard on rollback, ~2407).
- `ops approve` mints a signed, hash-bound `Approval` artifact and
  explicitly "Never executes" (`cli/main.py:2348-2366`).
- Mutating steps require an `ExpectedDelta` declaration —
  `PF-OPS-NO-DELTA`; **unknown action ⇒ treated as mutating**
  (conservative, `ops/engine.py:140-191`); `PF-OPS-UNKNOWN-ACTION` (:354).
- `platformforge_lab_chaos` is `risk: guarded`, `mutable: True`, and
  requires `agent_requirements=("allow_prod",)`
  (`mcp/registry.py:79-81,281-287`).
- Cross-forge boundary refuses direct-execution, approval-minting,
  shell-command, generic-provider-call, full-fleet-dump and
  credential-transfer outright (`ops/registry.py:63-77,78-110`).

### 3.11 How it prevents delegation cycles

- The A2A envelope carries `delegation_id` + `created_at` but **no hop
  count, visited-forge set, or correlation-depth field**
  (`forge/delegate.py:38-51`). **ABSENT:** a cycle guard on the envelope
  schema.
- Mitigating structure: inbound requests never skip the governed
  pipeline — "cross-forge requests mint ChangeIntent + enter the
  governed pipeline; they never skip stages" (`ops/registry.py:72-74`).

### 3.12 Which tests prove these integrations

- `tests/test_forge.py` — manifest generated (`capability-manifest/v*`,
  `cloud_mutation` false), envelope roundtrip + rejection
  (`platform.delegation.invalid`), result receipt shape.
- `tests/test_cli_ops.py`, `tests/test_ops_opgraph.py`,
  `tests/test_executors.py` — governed ops pipeline + host transports.
- `tests/test_agent_handoffs.py`, `tests/test_coordinators.py` — agent
  boundary handoffs.
- **ABSENT:** a test that actually invokes a sibling forge's CLI —
  `collect_manifest` is exercised only against fixtures/mocks.

---

## 4. Contract & verb inventory (paths)

| Artifact | Where |
|---|---|
| `forge/SpecialistAgenticManifest/v1` | `api-forge/forge.agentic.json`, `forge-doctor-api/forge.agentic.json`, `platform-forge/forge.agentic.json` (all: empty `skills`/`agents`/`coordinators`) |
| Forge Protocol façade (7 ops + health) | `api-forge/src/apiforge/forge/protocol.py`; CLI `apiforge forge capabilities|submit|attach|inspect|result|evidence|handoff|health` (`cli_forge.py:19-170`); MCP tools `forge_capabilities|forge_inspect|forge_result|forge_evidence|forge_health` (`mcp/tools.py:~3268`) |
| `apiforge/forge-capability-descriptor/v1` … `ForgeHandoff` | `api-forge/src/apiforge/contracts/forge_protocol.py` (+`docs/contracts/ForgeHandoff-v1.md`) |
| `apiforge/upstream-facts/v1` intake | `api-forge/src/apiforge/cli.py:468-505` + `application/analyze.py:69-169` (`analyze --upstream`) |
| `apiforge/forge-capability-descriptor` peers policy | `api-forge/src/apiforge/rules/forge_protocol.yaml` (engine, `forge-protocol/v1`, risk_gate, engines) |
| `apiforge/tool-risk/v1` authz | `api-forge/src/apiforge/rules/tool_risk.yaml` + `trust/tools.py` |
| Policy allow/gate/deny | `api-forge/src/apiforge/policy/decide.py` |
| Tool runner allowlist | `api-forge/src/apiforge/run_tools.py` (`TOOLS`, `TOOL_REGISTRY`) |
| `forge-doctor-api scan` verbs | `forge-doctor-api/src/forge_doctor_api/cli/__init__.py:129-235` (`--format`, `--fail-on`, `--baseline`, `--incremental`); `diagnose` :1235; `diff` :740; `fingerprint` :789; `blast-radius` :905; `mcp` :1364; `inventory` :266; `lab` :334 |
| Exit codes (doctor) | `0` pass · `1` gate failure · `2` usage (`docs/cli.md:5`; code `cli/__init__.py:196,210,232-235`) |
| `--format agent` line schema | `output/writers.py:109-132` — `id|sev|conf|subject[:line]|desc`, `UNKNOWN|subject|missing`; frozen in `docs/output-contract.md` §agent |
| Forge Protocol v2 (doctor) | `forge-doctor-api/src/forge_doctor_api/handoff/protocol.py` (`PROTOCOL_VERSION=2`, parses v1+v2); `handoff/model.py` `ApiHandoffBundle` v2 content-addressed |
| `DoctorBoundary` delegation seam | `forge-doctor-api/src/forge_doctor_api/handoff/boundary.py` (handle/envelope/endpoint_dict) |
| Forger routing contract | `forge-doctor-api/src/forge_doctor_api/handoff/routing.py` |
| `forge-contracts/1` shared vocabulary | `forge-doctor-api/src/forge_doctor_api/contracts/{models,adapters,schemas,validate}.py` |
| Doctor MCP surface | `forge-doctor-api/src/forge_doctor_api/handoff/mcp_server.py` (`doctor.scan`, `get_*`, `doctor://` resources, `MCP_RESPONSE_BUDGET`) |
| PF capability registry v2 | `platform-forge/platformforge/mcp/registry.py` (38 tools) |
| `platformforge/capability-manifest/v4` | `platform-forge/platformforge/forge/manifest.py` |
| `platformforge/a2a-envelope/v1` + `result-receipt/v1` | `platform-forge/platformforge/forge/delegate.py` |
| Sibling collect/discover | `platform-forge/platformforge/forge/collect.py` (`KNOWN_FORGES`) |
| Cross-forge delegation contract | `platform-forge/platformforge/ops/registry.py` `delegation_contract()`/`validate_delegate_request()` |
| Host execution boundary | `platform-forge/platformforge/ops/executors/base.py` `host_transport()` |
| **Consumers (the-forge)** | `the-forge/adapters/apiforge/` (api.analyze `--upstream` intake via `handoff.py`, `catalog.py:102`); `the-forge/adapters/doctorapi/` (`api.diagnose`, `api.verify`; `VERIFIES` → `api-forge/api.analyze`,`api-forge/api.change-control`, `catalog.py:90-92,130`); shared `_shell.py` Forge Protocol v1 runner (no shell, env-scrubbed, tree-kill, `ADAPTER-NATIVE-TIMEOUT`, 85% budget share, spill >4 MiB) |

---

## 5. Gap list vs `prompt_evo_integrations.md` — PHASE 7 focus

PHASE 7 wants: `API Forge Coordinator → identify validation need →
discover Doctor API → verify capability → execute read-only analysis →
collect evidence → plan/implement → run Doctor again → compare → publish
handoff` (`prompt_evo_integrations.md:483-533`).

| # | Gap | Evidence |
|---|---|---|
| G1 | **No direct api-forge → doctor delegation exists.** The only live path is *through the-forge*: `adapters/doctorapi` runs `DoctorBoundary` in the doctor's interpreter (`theforge/adapters/doctorapi/src/theforge_doctorapi/catalog.py:1-24`), and `adapters/apiforge` injects handoff items into `analyze --upstream` (`theforge/adapters/apiforge/src/theforge_apiforge/handoff.py:1-30`, `catalog.py:102`). In api-forge itself nothing can invoke `forge-doctor-api scan`. | api-forge `run_tools.py:56-85` (no doctor entry), `rules/forge_protocol.yaml:8` (no doctor engine) |
| G2 | **api-forge cannot discover the doctor.** `apiforge doctor` probes git + `apiforge-mcp` only (`distribution/doctor.py:54-65`); no `forge-doctor-api` PATH probe, no `forge.agentic.json` reader, no sibling registry. Discovery today is exclusively the-forge's job (`the-forge/src/theforge/specialists.py:151-268`, `_VERSION_TIMEOUT=15` at :99). | §1.2 |
| G3 | **No `forge-doctor-api` runner in the `run tool` allowlist.** Adding it is mechanical (a `_argv` template + reader), but today `apiforge run tool forge-doctor-api` → `AF-RUN-TOOL-UNKNOWN` (`run_tools.py:445-448`). The doctor's `--format agent` line schema (`id|sev|conf|subject|desc` + `UNKNOWN|…`) has **no parser in api-forge** — readers exist only for semgrep/trivy/gitleaks/k6 (`run_tools.py:60-83`). | §1.4, §2.7 |
| G4 | **Peer declaration mismatch.** `rules/forge_protocol.yaml:8` declares `engines: [spark-forge, the-forger]`; PHASE 7 needs `forge-doctor-api` (and the name `the-forger` vs actual `the-forge` is worth rechecking). Until declared, `apiforge forge handoff --to forge-doctor-api` → `AF-FORGE-ENGINE-UNKNOWN` (`forge/protocol.py:305-309`). | §1.1 |
| G5 | **Agent awareness absent.** No `agents/*.md` teaches when Doctor API adds value, when *not* to delegate, or how to consume `UNKNOWN|` rows — PHASE 11's explicit requirement (`prompt_evo_integrations.md:696-748`). The 5 `af-*` executors have no doctor boundary prose. | §1.1 |
| G6 | **Before/after revalidation exists on the doctor side but has no driver.** `RequestDelta{baseline_ref,changed_files}` + `compute_delta` + `scan --baseline` (`handoff/boundary.py:57-88`; `cli/__init__.py:139-142`) support the "run Doctor again, compare" step; nothing in api-forge sequences it. | §2.7-2.9 |
| G7 | **Protocol family split.** api-forge speaks `forge-protocol/v1` (`ForgeHandoff`, `forge/protocol.py`); the doctor speaks its own v2 protocol (`handoff/protocol.py:23`) and `forge-contracts/1` bundles (`contracts/adapters.py`). The-forge adapters already translate (handoff→`upstream-facts/v1`); a direct api↔doctor path needs either the same translation or a declared `forge/EvidenceHandoff/v1`. | §1.7, §2.7 |
| G8 | **No delegation-cycle contract.** Neither `ForgeHandoff` (api-forge) nor `ForgeRequest` (doctor) nor `a2a-envelope/v1` (platform-forge) carries visited-providers / hop budget / correlation id — PHASE 3's explicit list (`prompt_evo_integrations.md:321-333`). Existing guards are internal-only (api-forge `delegates_to` + recovery-depth-1; doctor never executes routes; PF envelopes are inert). | §1.11, §2.11, §3.11 |
| G9 | **platform-forge `KNOWN_FORGES` is stale vs the ecosystem** — knows api-forge, spark-forge-aws, itself only; missing `forge-doctor-api`, `forge-doctor-data`, `data-sentinel`, `spark-forge-azure` (`forge/collect.py:15-21`). Its `forge discover` marker scan would find checkouts, but `collect_manifest` refuses unknown forges (`collect.py:74-76`). Natural complementary fit: `platformforge forge collect --path <doctor repo>` would work once `forge-doctor-api` gains a `capability manifest`-style verb or KNOWN_FORGES is extended — doctor has no `capability manifest` verb today (closest: `forge.agentic.json` + `contracts` exports). | §3.1-3.2 |
| G10 | **Doctor lacks a machine-readable capability-manifest verb** for PF-style collection: it publishes `forge.agentic.json` + `mcp` tools + `contracts`, but no `<cli> capability manifest` matching the PF `KNOWN_FORGES` convention (`manifest_cmd: ["capability","manifest"]`). | §2.2, §3.2 |
| G11 | **Confidence semantics differ** — spec warns "Não transformar um finding POSSIBLE em CONFIRMED" (`prompt_evo_integrations.md:417`). Doctor `Confidence` = HIGH/MEDIUM/LOW/UNKNOWN (`docs/output-contract.md` shared types); api-forge `Severity`/`Finding` model differs (`core/models.py`). The `upstream:` namespace prevents laundering into local findings (`analyze.py:143-149`), but severity/confidence mapping needs an explicit adapter rule. | §1.8, §2.8 |
| G12 | **Eval coverage for PHASE 7 absent.** api-forge evals cover forge-protocol refusals (`evals/corpus/forge-protocol/`) but no doctor-delegation case; doctor `test_handoff.py` proves route *declaration*, not end-to-end api↔doctor flow; the only true E2E today is `the-forge/tests/test_adapter_doctorapi.py` + `test_delta_handoff.py`. Spec Caso C (`prompt_evo_integrations.md:973-983`) has no test anywhere. | §1.12, §2.12 |

### What already works (reuse, don't rebuild)

- **Doctor delegation surface is production-shaped**: `scan <target>
  --format agent`, documented exit codes, bounded outputs, AST-enforced
  determinism, content-addressed v2 handoff bundles with delta support —
  exactly what PHASE 7's "execute read-only analysis / collect evidence /
  run again / compare" needs (`forge-doctor-api` §2.4-2.9).
- **api-forge upstream intake is the handoff target**: bounded,
  provenance-marked, instruction-smuggling-proof
  (`application/analyze.py:69-169`) — the `apiforge/upstream-facts/v1`
  doc is *the* EvidenceHandoff consumer shape already in production via
  the-forge's `api.analyze` capability (`accepts_handoff`,
  `the-forge/adapters/apiforge/.../catalog.py:240`).
- **the-forge adapters prove the end-to-end loop exists**: doctorapi
  `api.diagnose` + `api.verify` (`VERIFIES` apiforge capabilities), and
  the shared `_shell.py` runner already implements timeout (85% of the
  budget profile), env credential scrubbing, process-tree kill, output
  caps and honest `ADAPTER-*` refusals — the governed delegation
  substrate the spec asks for.
- **platform-forge fit is complementary, not forced**: its cross-forge
  accepts/refuses contract (`ops/registry.py:63-77`), a2a
  envelope+receipt, and PREPARE-only ops surface are orthogonal to the
  api↔doctor lane; extending `KNOWN_FORGES` is the only change its side
  needs to *observe* doctor manifests.
