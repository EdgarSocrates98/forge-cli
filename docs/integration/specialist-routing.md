# Specialist Routing — How It Works Today (lf-0026, Phase 0)

**Bottom line: all cross-forge delegation is top-down through the-forge.
Peer-to-peer routing inside a specialist is ABSENT everywhere** — no
specialist can discover, select, or invoke a sibling at runtime. Verified in
all three audit appendices.

## 1. the-forge — the only real router

- **Deterministic router** (`src/theforge/routing/router.py`). Two paths:
  explicit `requested_capability`, and declared-signal matching
  (deps/file-globs/keywords; ≥2 discriminating signal types; shared
  non-discriminating signals removed). Ambiguity resolves to the literal
  `"ambiguous"`, never a guess (`router.py:1-14,45-78,234-319,476-518`).
- **Requirement fit**: `negotiate_all` hard gates (protocol, policy,
  operation class, runtime, evidence, features) →
  FULL/PARTIAL/UNSUPPORTED/INCOMPATIBLE/UNRESOLVED; undeclared dimensions
  degrade to PARTIAL, never silently satisfied (`negotiation.py:1-15`;
  `contracts/manifest.py:96-144`).
- **Workflow pick inside an agentic manifest**: `select_workflow` — exact id,
  then token-overlap score, tie/zero → `"ambiguous"`
  (`specialists.py:410-438`).
- **Provider selection is trust-gated**: `unverified` providers do not
  execute without `--allow-unverified`; `blocked` never runs
  (`registry/registry.py:47,207-215`; `registry/health.py:50-63`).

## 2. Execution channels out of the-forge

- **Forge Protocol providers**: `<argv> <op>` subprocess, JSON stdin/stdout,
  `shell=False`, process-tree managed (`protocol/transport.py:70-113`;
  `protocol/proctree.py:186-263`). Six adapter distributions:
  `adapters/{apiforge,doctorapi,doctordata,platformforge,sparkforge_aws,sparkforge_azure}`.
- **Argv delegation channel**: real `subprocess.run` of manifest-declared
  command templates (`{cli}`/`{python}`/`{checkout}`/`{target}` resolved at
  `specialists.py:296-337`; executor `delegation.py:68-121`; fan-out cap
  `max_parallel=4` at `delegation.py:124-148`).
- **Install fan-out**: `install auto` runs each registered forge's own
  `<cli> install …` argv (`install/service.py:445-492,589-641`,
  `timeout=600` at :624-626).

## 3. forge-cli — install/update routing, not task routing

- `FORGE_REPOS` (8 repos, verify argv + `nativeInstall` command/flags/ops per
  forge) and `REGISTRY_PACKAGES` (7 PyPI dists, `bin`, `minPython`, `mcp`
  argv, `mcp_safe_tools`) are the only specialist knowledge
  (`src/constants/repos.ts:3-119`; `src/registry/catalog.ts:7-117`).
- `delegateNative` runs the forge's verified venv bin with documented flags;
  `{python} scripts/…` argv is honestly skipped under the registry method
  (`src/cmd/registry.ts:237-294`).
- `resolveDiscovery` precedence: `manifest > forja-discovery > catalog >
  remote-registry > fallback` (`src/contracts/negotiate.ts:67-114`).
- **data-sentinel-forge is in neither catalog** — it cannot be installed,
  verified, or MCP-probed via forge-cli (audit-core §2.1).

## 4. Routing inside specialists (all internal, none peer-aware)

- **api-forge**: `rules/catalog/routing.yaml` `(phase, dominant_area) →
  recommended_agent`; no route → `AF-ROUTING-NO-ROUTE`
  (`application/next_step.py:58-134`). `run tool` is a closed argv-template
  allowlist — no forge CLI registered (`run_tools.py:56-85,433-448`).
  `prepare_handoff` targets only declared engines `[spark-forge,
  the-forger]` → `AF-FORGE-ENGINE-UNKNOWN` otherwise
  (`rules/forge_protocol.yaml:8`; `forge/protocol.py:305-309`).
- **forge-doctor-api**: declares consumer routes — `_DOMAIN_HANDLERS =
  {"api": "api-forge", "data": "data-doctor"}` and chains
  `("doctor-api","api-forge")`, `("doctor-api","data-doctor"[,"spark-forge"])`
  — but executes none: "The Doctor declares routes — The Forger executes
  them" (`handoff/routing.py:6-7,19-84`).
- **spark-forge-aws**: `rules/catalog/routing.yaml` maps findings →
  `recommended_agent` (read by `sparkforge_aws_next_step`);
  `DISPATCHABLE_SKILLS`/`NON_DISPATCHABLE_SKILLS` whitelists
  (`integrate/render.py:189-270`).
- **spark-forge-azure**: `agents` CLI group + `analyze`/`judge`/
  `knowledge select` (`cli/cmd_agents.py:165-217`, `cmd_analyze.py:127-142`).
- **data-sentinel-forge**: internal registry lookup by `capability_id`;
  agent routing is deterministic keyword-matching
  (`agents/specialists.py`, `diagnostics/orchestrator.py`).
- **forge-doctor-data**: `capabilities list|explain|graph` provenance-aware
  catalog (`cli/capabilities.py`); no outbound routing.
- **platform-forge**: `capability check` is a negotiation verb — "can you
  analyze X at version Y?" → `supported`+contracts+`version_note`, absent →
  `platform.capability.unresolved` (`cli/main.py:1727-1766`);
  `forge collect` probes sibling CLIs from hard-coded `KNOWN_FORGES`
  (`forge/collect.py:15-76` — stale, 3 entries).

## 5. What is absent (see `confirmed-gaps.md`)

- No specialist-side peer discovery, peer capability negotiation, or
  consumer→provider delegation adapter.
- No `visited_providers`/`delegation_depth`/`max_hops`/correlation fields on
  any wire contract (`contracts/specialist.py:168-187`,
  apiforge `contracts/forge_protocol.py`,
  `platformforge/forge/delegate.py:38-51`).
- No runtime chain exists to loop today — but PHASE 3's cycle contract has
  no schema home yet.
