# Audit — Cross-Forge Integration Readiness (spec `lf-0026`)

**Type:** read-only source audit. No integration code was executed; no specialist was
installed or invoked. Every claim cites `path:line`. "Implemented" means the code
exists at the cited lines; it does **not** mean the path was run during this audit.

**Audited commits** (`git rev-parse HEAD`, branch `main` in all cases):

| Repo | SHA |
|---|---|
| `data-sentinel-forge` | `97d770969d03` |
| `forge-doctor-data` | `784dfe8979c2` |
| `spark-forge-aws` | `6b065fa65ae0` |
| `spark-forge-azure` | `d50fcc481327` |
| `the-forge` (reference) | `679fc4f37e94` |

**Spec:** `prompt_evo_integrations.md` — Cycle 13: intelligent specialist
discovery, optional cross-forge delegation, evidence handoff, governed execution.
End state: *"uma Forge pode conhecer, descobrir e utilizar outra sem depender
obrigatoriamente dela."*

**Status legend:** ✅ implemented · 🟡 partial · ❌ absent · ❓ unresolved (cannot
be determined from static reading).

---

## 0. Executive summary

The ecosystem already has **two working cross-forge channels**, both
*evidence-in, never instruction-in*:

1. **The Forge → specialists via Forge Protocol v1.** `the-forge` is a real
   control plane: adapters in `the-forge/adapters/{sparkforge_aws,sparkforge_azure,
   apiforge,platformforge,doctordata,doctorapi}` spawn the specialist as a
   **subprocess without a shell**, enforce per-profile timeouts with process-tree
   kill (Job Object on Windows / process group on POSIX), cap stdout/stderr, drop
   credential-shaped env vars, and answer with structured `refused`/`error`
   envelopes (`the-forge/adapters/sparkforge_aws/src/theforge_sparkforge_aws/_shell.py`,
   module docstring lines 1–41; constants at lines ~55–72).
2. **Handoff → upstream-facts translation.** The Forge adapter translates
   `theforge/Handoff/v1` items into `sparkforge_aws/upstream-facts/v1` /
   `sparkforge_azure/upstream-facts/v1` documents
   (`the-forge/adapters/sparkforge_aws/src/theforge_sparkforge_aws/handoff.py`,
   docstring lines 1–37). Both Spark forges admit these as **foreign facts** —
   namespaced `upstream:` ids and `upstream.` kinds that no native rule matches,
   `provenance.extractor == "theforge/handoff"`, forbidden imperative keys
   rejected, 256 KiB / 128-fact bounds
   (`spark-forge-aws/sparkforge_aws/adapters/upstream.py`;
   `spark-forge-azure/sparkforge_azure/adapters/upstream.py:1–36`).

A third emerging channel is **Doctor Data ↔ Data Sentinel**: Doctor exports
`handoff-bundle@1` / scan-json `3.0`; Sentinel imports `handoff-bundle@1`,
`forge-contracts/1`, `scan-json@3.0` and exports `forge-contracts/1`
(`data-sentinel-forge/src/data_sentinel/adapters/doctor/adapter.py`).

**The main gap:** none of the four audited specialists *discovers peers at
runtime*. All four declare `forge.agentic.json` manifests
(`forge/SpecialistAgenticManifest/v1`) and capability surfaces, but discovery of
*other* forges, capability negotiation between them, cycle detection for
delegation, and refusal codes for absent/incompatible peers exist **only inside
The Forge's adapter shell** — not inside the specialists themselves. Cross-forge
delegation today is orchestrated **from above** (The Forge), not **peer-to-peer**.

---

## 1. Contract inventory

| Contract | Where defined | Producer | Consumer |
|---|---|---|---|
| `forge/SpecialistAgenticManifest/v1` | each repo's `forge.agentic.json` | all 4 specialists | The Forge (install/discovery), humans |
| `forge/v1` (Forge Protocol envelope) | `the-forge/adapters/sparkforge_aws/src/theforge_sparkforge_aws/_shell.py` (`PROTOCOL = "forge/v1"`) | adapters | The Forge core |
| `theforge/Handoff/v1` | `the-forge` core + `adapters/sparkforge_aws/src/theforge_sparkforge_aws/handoff.py` | The Forge core | adapter → `translate_handoff` |
| `sparkforge_aws/upstream-facts/v1` | `spark-forge-aws/sparkforge_aws/adapters/upstream.py` (`UPSTREAM_SCHEMA`) | theforge adapter | `analyze_pyspark(upstream=…)`, case intake |
| `sparkforge_azure/upstream-facts/v1` | `spark-forge-azure/sparkforge_azure/adapters/upstream.py:44` | theforge adapter | case bundle `upstream.json` → `run_case` |
| `handoff-bundle@1` | `forge-doctor-data/src/forge_doctor_data/core/handoff.py` | Doctor Data | Sentinel doctor importer |
| `forge-contracts/1` | `data-sentinel-forge/src/data_sentinel/core/contracts/interop.py` (`FORGE_CONTRACTS_1`) | Sentinel exporter, Doctor | Sentinel doctor importer |
| `scan-json@3.0` | `forge-doctor-data/src/forge_doctor_data/output/agent_renderer.py` | Doctor `scan -f agent` | Sentinel doctor importer |
| `DiagnosticReport` | `data-sentinel-forge/src/data_sentinel/core/contracts/` | Sentinel | exporter, `report show` |
| `CapabilityDescriptor` | `data-sentinel-forge/src/data_sentinel/core/contracts/interop.py` | `data-sentinel capabilities --descriptors` | orchestrators (declared, no in-repo consumer) |
| Install receipts | `data-sentinel-forge/src/data_sentinel/installation/contracts.py`; `spark-forge-aws/sparkforge_aws/install/lifecycle.py:25–48` (`STATE_DIR`, `RECEIPTS_DIR`) | each forge | `doctor`/`status` verbs |

**Refusal codes observed (adapter shell):** `ADAPTER-OP-UNSUPPORTED`,
`ADAPTER-PROTOCOL-UNSUPPORTED`, `ADAPTER-REQUEST-INVALID`,
`ADAPTER-CAPABILITY-UNSUPPORTED`, `ADAPTER-ACTION-UNSUPPORTED`,
`ADAPTER-INTERNAL`, `ADAPTER-OUTPUT-TOO-LARGE`, `ADAPTER-NATIVE-TIMEOUT`
(`_shell.py` constants block). `execute` timeouts per profile:
`{economy: 60s, balanced: 180s, max: 600s}`; native timeout = 85% of profile;
`NATIVE_STDOUT_CAP = 64 MiB`, `NATIVE_STDERR_CAP = 1 MiB` (`_shell.py`,
`EXECUTE_TIMEOUTS` / `NATIVE_*` constants).

---

## 2. `data-sentinel-forge` — 12 answers

**Surfaces:** `forge.agentic.json` (provider `data-sentinel-forge` v0.1.0, cli
`data-sentinel`, entry `data_sentinel.cli:app`, workflows `analyze`,
`spark-explain`, `capabilities`, `read_only_default: true`, `mcp_command:
data-sentinel mcp serve`). All CLI verbs live in
`src/data_sentinel/cli/__init__.py` (Typer `app` at line 48).

1. **Knows about other specialists?** 🟡 Knows *Doctor Data's formats*, not the
   tool. The importer accepts `handoff-bundle@1`, `forge-contracts/1`,
   `scan-json@3.0` (`adapters/doctor/adapter.py`) and the tool registry ships
   `sentinel.doctor.import_bundle` (`tools/registry.py`). No manifest scanning
   of peer forges.
2. **Discovers installed tools?** ❌ No peer-forge discovery. Internal
   *analyzer* discovery is a static registry (`diagnostics/orchestrator.py`,
   `registry.all()`).
3. **Selects a capability?** Registry lookup by `capability_id`; agent routing
   is deterministic keyword-matching (`agents/specialists.py`).
4. **Executes external commands?** Guardrails *forbid* process execution for
   agent flows (`agents/guardrails.py` — remote writes, destructive actions,
   process execution denied). CLI AWS access goes through boto3 connectors
   inside the process (`cli/__init__.py:508–527`, `glue_diagnose`).
5. **Verifies versions?** 🟡 Bundle formats are versioned (`@1`, `3.0`) and
   rejected on mismatch; `CapabilityDescriptor` carries versions. No
   peer-binary version probing.
6. **Timeouts?** `AnalysisLimits` carries `timeout_ms` + a cancellation flag
   (`diagnostics/orchestrator.py`) — cooperative, not process-level.
7. **Receives results?** `DiagnosticReport` + `Evidence` objects; import adapter
   returns interop findings.
8. **Validates output?** Schema validation of findings/evidence; malformed
   tool output becomes an explicit `limitation` (`agents/investigator.py`);
   importer caps: 20 MiB file, 10 000 findings (`adapters/doctor/adapter.py`).
9. **Preserves evidence?** `InteropEvidence` with content hashes + declared
   provenance; exporter stamps SHA-256 `IntegrityMetadata`
   (`core/contracts/interop.py`, `adapters/doctor/exporter.py`). Imported
   findings are **never** auto-`CONFIRMED`.
10. **Dangerous delegations?** `tools/registry.py` blocks registering tools
    with cloud-write/destructive permissions; `MAX_OUTPUT_CHARS = 200_000`;
    `core/security/paths.py` enforces allowed roots, regular-file checks, size
    caps, binary/UTF-8 rejection; MCP is stdio-only and root-scoped
    (`mcp_server.py`, `DATA_SENTINEL_MCP_ROOTS`).
11. **Delegation cycles?** ❌ None — Sentinel never delegates to another forge.
12. **Tests?** `tests/contract/test_interop_contracts.py`,
    `tests/e2e/test_e2e_interop.py`, `tests/integration/test_mcp_stdio.py`,
    `tests/security/` (prompt-injection, cycle/security tests),
    `tests/contract/test_cli_groups.py`.

### 2.1 Sentinel CLI verb inventory (real, from `cli/__init__.py`)

| Verb | Lines | Signature (key options) |
|---|---|---|
| `version` | 102–103 | — |
| `analyze` | 215–264 | `--file/-f` XOR `--sql`, `--platform/-p`, `--profile`, `--dialect`, `--json`, `--no-persist`, `--output/-o` |
| `config show` | 267–289 | `--json` (redacted) |
| `capabilities` | 292–315 | `--json`, `--descriptors` → `CapabilityDescriptor` JSON (interop §5) |
| `doctor` | 326–381 | environment checks |
| `glue inspect` | 420–456 | `--job` (required), `--profile`, `--region`, `--json`, `--quiet` — read-only AWS |
| `glue runs` | 457–487 | `--job`, `--limit 10`, `--profile`, `--region`, `--json` |
| `glue diagnose` | 488–575 | `--job`, `--run-id`, `--log-group`, `--profile`, `--region`, `--dry-run`, `--no-persist`, `--json`, `--output` |
| `spark explain` / `spark optimize` | 576–634 | plan analysis/optimization |
| `sql analyze` | 635–663 | static SQL |
| `report show` / `report export` | 723–747 / 1060–1084 | persisted `DiagnosticReport` |
| `lakehouse metadata|access|policy|operation|compat` | 775–886 | Iceberg/access/policy/ops |
| `import doctor-bundle` | 887–929 | path → interop findings (formats above) |
| `quality validate` / `quality import` | 937–999 | data-quality contracts |
| `lineage ingest` / `lineage impact` | 1000–1059 | OpenLineage |
| `mcp serve` | 1088–1089 | stdio |
| `investigate run` | ~1144 | `{tool_id: path}` explicit inputs |
| `agents` / `tools` | ~1176 / ~1184 | roster listings |
| `emr analyze|compare|cost` | ~1191+ | EMR surfaces |
| `serve` | ~1255 | HTTP API extra |

---

## 3. `forge-doctor-data` — 12 answers

**Surfaces:** `forge.agentic.json` (provider `forge-doctor-data` v`1.0.0rc1`,
cli `forge-doctor-data`, entry `forge_doctor_data.cli:app`; workflows `scan`
DIAGNOSTIC_ONLY, `doctor` = `install doctor`; `mcp_command: forge-doctor-data
mcp`; `read_only_default: true`). `forge.json` carries `timeout_s: 300`.

1. **Knows about other specialists?** 🟡 Emits a format Sentinel understands
   (`agent` renderer + `handoff-bundle`), but has no peer registry.
2. **Discovers installed tools?** ❌ No peer discovery; internal check/plugin
   registry.
3. **Selects a capability?** `capabilities list|explain|graph`
   (`cli/capabilities.py`) — provenance-aware capability catalog with
   entry ids, matched conditions, missing evidence, pack versions,
   verification timestamps.
4. **Executes external commands?** Read-only collectors; no specialist
   subprocess invocation found.
5. **Verifies versions?** `capabilities explain --version/--variant` and
   knowledge-pack versioning; no peer-binary probing.
6. **Timeouts?** `timeout_s: 300` declared in `forge.json`; enforcement path
   not verified in this audit (❓ where enforced).
7. **Receives results?** `DiagnosticReport`-style scan report; agent renderer
   emits compact JSON.
8. **Validates output?** `agent` format = schema `3.0` compact JSON
   (`output/agent_renderer.py`; `cli/common.py:77–78` `FORMATS`,
   `MACHINE_FORMATS`; `:370–371` dispatch to `render_agent`).
9. **Preserves evidence?** `scan --evidence-out`, fingerprints, `handoff-bundle`
   (`core/handoff.py`) — deterministic ordering, **no timestamps**;
   `agent evidence` / `agent delta --since` / `agent context --budget`
   (`cli/agent.py`).
10. **Dangerous delegations?** Read-only defaults everywhere; evidence redaction
    in bundles.
11. **Delegation cycles?** ❌ N/A — no outbound delegation.
12. **Tests?** `tests/test_install_lifecycle.py`, `tests/test_portal_adapter.py`,
    `tests/test_doc_manifest.py`, `tests/integration/`, `tests/unit/`.

### 3.1 Doctor CLI surface (relevant slice)

- `scan` — `cli/scan.py:58–110`: `path`, `--check`, `--ignore`,
  `--format text|json|html|sarif|agent` (`FormatOpt`, `cli/common.py:98–100`),
  `--quiet`, `--fail-on`, `--baseline`, `--save-baseline`, `--output`,
  `--watch`, `--new-only`, `--no-plugins`, `--files`, `--profile`, `--emit`,
  `--evidence-out`, `--evidence-compact`, `--record`, `--keep`, `--incremental`.
- `agent` — `cli/agent.py`: `manifest`, `context --budget`, `delta --since`,
  `evidence`.
- `capabilities` — `cli/capabilities.py`: `list [--json] [--provenance]`,
  `explain <platform> <capability> [--version] [--variant]`, `graph [path]`.
- Plus ~50 domain modules in `cli/` (advise, airflow, bigquery, dbt, diff,
  iceberg, lakeformation, parquet, snowflake, terraform, trino, whatif, …).

---

## 4. `spark-forge-aws` — 12 answers

**Surfaces:** `forge.agentic.json` (provider `spark-forge-aws` v0.5.0, cli
`sparkforge-aws`, entry `sparkforge_aws.adapters.cli:main`; workflows
`analyze-pyspark` DIRECT_CAPABILITY, `doctor` DIAGNOSTIC_ONLY, `playbook`
SPECIALIST_WORKFLOW; coordinator `spark-performance-architect`; MCP
`{cli} mcp serve`).

1. **Knows about other specialists?** 🟡 Defines the intake contract
   (`upstream-facts/v1`) and Forge Protocol envelopes; accepts evidence *from*
   an orchestrator but has no peer list.
2. **Discovers installed tools?** 🟡 `install/lifecycle.py` manages *its own*
   install (`install|status|doctor|repair|uninstall`), receipts under
   `.sparkforge_aws/receipts` (`install/lifecycle.py:25–48`); verifies itself
   via `mcp_verify_tool = sparkforge_aws_runtime_detect`
   (`install/lifecycle.py` `_spec()`). No peer discovery.
3. **Selects a capability?** Deterministic: `rules/catalog/routing.yaml` maps
   findings → `recommended_agent`; `sparkforge_aws_next_step` reads it
   (`AGENTS.md`, routing table). `DISPATCHABLE_SKILLS` /
   `NON_DISPATCHABLE_SKILLS` whitelists with per-skill rationale
   (`integrate/render.py:189–270`) — e.g. `diagnose-lakeformation-access` is
   non-dispatchable because it hits live AWS and recommends permission changes.
4. **Executes external commands?** It *is* executed (as MCP server or CLI);
   internally, guarded `subprocess` in `_installkit.py` and a CLI executor
   callback (`adapters/cli.py`). 14 coordinators in `agents/*.md` dispatch 5
   executors (`sf-inventory`, `sf-extractor`, `sf-judge`, `sf-verifier`,
   `sf-synthesizer` in `agents/executors/*.md`), each with `## Não faz`
   boundaries and `## Pressupõe`/`## Entrega` handoff contracts.
5. **Verifies versions?** Runtime detection tool; version-gated rules in the
   catalog (`rules_lookup` exposes version guards — `agents/executors/sf-judge.md`
   step 3).
6. **Timeouts?** `agentic/budget.py` enforces token/tool-call/time/retry/cost
   budgets; registry models carry `workflow timeout defaults`
   (`registry/models.py`). Process-level kill of a *callee* exists only in The
   Forge adapter (`_shell.py`).
7. **Receives results?** `ForgeResult`/`ForgeEvidenceBundle`/`ForgeTaskStatus`
   (`accepted/running/succeeded/failed/blocked/unresolved`)
   (`protocols/forge.py`); case store persists facts/findings.
8. **Validates output?** `agentic/security.py` validates input/output/schema/
   policy/version/scope; 50 KB output cap; secret-leakage scan. Upstream
   intake: schema check, `upstream:`/`upstream.` namespaces, forbidden
   imperative keys (`action|command|execute|instruction|plan|prompt|route|task|
   workflow`), 256 KiB / 128 facts (`adapters/upstream.py`).
9. **Preserves evidence?** `Finding` requires non-empty `evidence[]` +
   `rule_id` (invalid by construction otherwise); facts keep foreign provenance
   (`provenance.extractor = "theforge/handoff"` + `artifact_sha256` stamped at
   intake); deterministic task ids; receipts.
10. **Dangerous delegations?** `agentic/handoff.py`: receiver role-plan
    admission `ALLOW|DENY|REVIEW`, authority forced `DATA_ONLY`, trust ceilings,
    taint→REVIEW, sender tool-access check (confused-deputy guard), denied
    content → named unresolved. `agentic/security.py` threat model covers
    prompt injection, tool abuse, privesc, evidence poisoning, cross-agent
    injection, secret leakage, cross-case contamination; high/critical/
    destructive/production ops can require human approval.
11. **Delegation cycles?** 🟡 Subagent→subagent dispatch is structurally
    impossible on host platforms (`AGENTS.md`: "subagents cannot spawn
    subagents"); no *forge-to-forge* cycle detection (that's The Forge's plan
    graph).
12. **Tests?** `tests/test_upstream_intake.py`, `tests/test_forge_cli_doctor.py`,
    `tests/test_adapters_mcp.py`, `tests/test_fixtures_golden_mcp_parity.py`,
    decision/runtime integration tests.

---

## 5. `spark-forge-azure` — 12 answers

**Surfaces:** `forge.agentic.json` (provider `spark-forge-azure` v0.1.0, cli
`sparkforge-azure`, entry `sparkforge_azure.cli.main:main`; workflows
`analyze` DIRECT_CAPABILITY, `doctor` DIAGNOSTIC_ONLY; **empty**
`skills`/`agents`/`coordinators` arrays; `mcp_command: {cli} mcp serve`;
`read_only_default: true`).

1. **Knows about other specialists?** 🟡 Same upstream-facts intake design as
   the AWS sibling (explicitly documented as such,
   `adapters/upstream.py:45–48`). No peer registry.
2. **Discovers installed tools?** ❌ No peer discovery found.
3. **Selects a capability?** `agents` CLI group: `list`, `inspect`,
   `runtime-inspect`, runtime status verbs (`cli/cmd_agents.py:165–217`);
   `analyze`/`judge`/`knowledge select` (`cli/cmd_analyze.py:127–142`).
4. **Executes external commands?** CLI is argparse-based (`cli/main.py` +
   `cmd_*.py`); read-only `collect` family (`cmd_collect.py:109–149`:
   workspace-graph, resource-graph, unity-catalog, azure-rbac, adls-meta).
5. **Verifies versions?** `doctor` command (`cli/cmd_doctor.py`);
   `knowledge select` over dated packs. No peer probing.
6. **Timeouts?** ❓ Not verified; no adapter-side timeout in this repo (lives in
   The Forge's `_shell.py`).
7. **Receives results?** `protocols/forge.py` (Forge Protocol envelopes,
   sibling parity) + case bundle outputs.
8. **Validates output?** `adapters/upstream.py:1–36`: `UpstreamError`; foreign
   facts enter `run_case` **facts output**, never the `judge` input;
   `_FORBIDDEN_KEYS` refused at any payload depth; 256 KiB / 128-fact bounds;
   errors → `CaseError` exit 2 / MCP error.
9. **Preserves evidence?** `offline-bundle build|verify` redacted evidence
   bundle (`cli/cmd_bundle.py:31–43`); `agentops runs/inspect` recorded runs
   (`cli/cmd_agentops.py:55–66`).
10. **Dangerous delegations?** `AGENTS.md` invariants: DATA_ONLY authority,
    default-deny cloud mutation, unknown risk → DENY, prompt-injection
    defenses ported from sibling.
11. **Delegation cycles?** ❌ Same as AWS — host-level impossibility only.
12. **Tests?** `tests/` tree with portability/port tests; suite not enumerated
    file-by-file in this audit (❓ inventory-level).

**CLI verbs (argparse, `cli/cmd_*.py`):** `agentops runs|inspect`, `agents
list|inspect|runtime-inspect|…`, `ai`, `analyze pyspark`, `judge`, `knowledge
select`, `offline-bundle build|verify`, `collect workspace-graph|resource-graph|
unity-catalog|azure-rbac|adls-meta`, `context`, `diagnose`, `doctor`,
`distribution`, `governance`, `graph`, `install`, `lab`, `mcp`, `migration`,
`portal`, `sdd`, `tokensave`, `workspace`.

---

## 6. The Forge — reference implementation (what already works top-down)

`the-forge/src/theforge/` contains the orchestration core: `delegation.py`,
`capability_graph.py`, `conformance.py`, `contracts/`, `environment/`,
`install/`, `interop/`, `negotiation.py`, `host_detect.py`, `planning`, …

Adapter shell guarantees (`adapters/sparkforge_aws/src/theforge_sparkforge_aws/_shell.py`,
docstring + constants — `_shell.py` is **byte-identical across all adapters**,
enforced by a test):

- Ops: `describe`, `health`, `execute` over `forge/v1`; unknown op / unsupported
  protocol / undeclared capability or action → `refused`; invalid request or
  unexpected exception → structured `error` (exception *type* only — never
  traceback or message).
- `stage_context` copies only ContextPack files inside the workspace root that
  match sha256 → else `limitation`.
- `run_native`: no shell, cwd-scoped, env = core env minus credential-shaped
  names, stdout ≤ 64 MiB / stderr ≤ 1 MiB, timeout = 85% of profile budget;
  whole **process tree** killed (Job Object / process group); overrun →
  `ADAPTER-NATIVE-TIMEOUT`.
- `INLINE_LIMIT`: oversized findings spill to artifact
  `native/full-output.json`; result marked `partial`.
- `cleanup_workdir`: post-execute cwd reduced to declared `artifacts[]`;
  symlinks removed never followed; pre-existing entries untouched; cleanup
  failures become limitations, never errors.

Health (`health.py` docstring): 4 checks — interpreter ≥ 3.10, dispatcher
importable (`find_spec`, never imported), specialist version inside
`SUPPORTED_SPECIALIST` window (`--assume-specialist-version` override),
`native_catalog.json` present → `ok` / `degraded` / `unavailable`. `--replay`
mode replays recorded scenarios (`record_execute.py`).

Handoff (`handoff.py`): `theforge/Handoff/v1` → `upstream-facts` translation;
id `upstream:<sha256[:16]>`, kind `upstream.<kind>`, extractor
`theforge/handoff`, `attrs.upstream {provider, run_id, node, item}`; scalars +
flat structures only (imperative keys can never be emitted); bounds mirrored
(128 items / 256 KiB); malformed items → limitations, overflow drops from tail.

---

## 7. Gap list vs `prompt_evo_integrations.md`

| Requirement | Status | Evidence / gap |
|---|---|---|
| Independent optional integrations | ✅ | Each forge installs/runs standalone; manifests are declarative; no forge imports another |
| Discovery before execution | 🟡 | The Forge `describe`/`health` probes exist; specialists don't discover peers |
| Real capability verification | 🟡 | `capabilities --descriptors`, `capabilities explain`, adapter `describe`; but no cross-forge negotiation inside specialists |
| Version compatibility | 🟡 | Adapter `health` enforces `SUPPORTED_SPECIALIST` window; Sentinel/Doctor version their bundle formats; specialists don't check *peer* versions |
| Typed args + safe process boundary | ✅ (adapter) / ❌ (peer) | `_shell.py run_native` is exactly this; nothing comparable inside the four repos for calling each other |
| Timeout/cancellation | 🟡 | Adapter: process-tree kill + `ADAPTER-NATIVE-TIMEOUT`; Sentinel: `AnalysisLimits.timeout_ms` cooperative only; Doctor: `timeout_s` declared, enforcement unverified; Spark: budgets, no callee kill |
| Output size/schema validation | ✅ | Adapter caps; Sentinel registry caps + path security; upstream intake bounds; agent renderer schema 3.0 |
| Evidence/provenance handoff | ✅ | upstream-facts pipeline (theforge→both Sparks); doctor-bundle→Sentinel; sha256 stamping; `upstream:`/`upstream.` namespacing |
| Permission/risk gating | ✅ | Sentinel tool permissions + guardrails; Spark role-plan admission DATA_ONLY + risk levels; Azure default-deny |
| Graceful degradation (absent specialist) | 🟡 | Adapter `health` → `unavailable`; `no_input` answers; but "specialist absent → fallback workflow" inside a specialist is absent |
| Incompatible-provider refusal | ✅ (adapter) | `ADAPTER-*` refusal codes; version window → `degraded` |
| Cycle prevention | 🟡 | Host subagent rule + orchestrated plan graph; no token/chain-id cycle detection across forges |
| Controlled retries / budgets | 🟡 | Spark `budget.py` (token/tool/time/retry); adapter has no retry of native calls (fail-fast → structured error) |
| Cross-forge E2E fixtures | 🟡 | the-forge `--replay` scenario machinery + `record_execute.py`; Sentinel `test_e2e_interop.py`; no 4-repo fixture |
| Windows/Linux, wheel-only | 🟡 | `_shell.py` handles both process-kill modes; adapters stdlib-only py≥3.10; specialists py≥3.11 (Sentinel) |
| No new mandatory inter-forge deps | ✅ | Confirmed: all channels are file/stdio contracts |

**Biggest missing pieces (architectural):**

1. **Peer discovery inside specialists** — none of the four reads another's
   `forge.agentic.json` or probes `{cli} capabilities` at runtime.
2. **A shared delegation envelope with cycle tokens** — `ForgeTask` ids are
   deterministic but no `delegation_chain`/`visited_providers` field exists.
3. **Explicit "specialist absent/incompatible → named fallback"** behavior in
   the specialists (today only the orchestrator sees `unavailable`).
4. **A 4-repo integration fixture** proving Sentinel↔Doctor and
   Forge→Spark→Sentinel chains end-to-end.

---

## 8. Caveats

- This audit is static; **no test suite was executed**. Test filenames cited
  prove the suites exist, not that they pass.
- `spark-forge-azure` received a shallower pass than its sibling; treat ❓
  items there as "not verified" rather than "absent".
- `forge-doctor-data`'s `timeout_s: 300` enforcement site and MCP server
  internals were not opened.
- Line numbers are exact where cited with `start–end`; bare filenames mean
  "contract/module lives here" and should be re-pinned before implementation.
