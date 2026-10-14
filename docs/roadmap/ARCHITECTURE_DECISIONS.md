# F0 Architecture Decisions — audit findings + open questions

Program: `prompt_evo_cli_portal.md`. Two kinds of entries:
**AD-OBSERVED** (decisions already implemented in `main` — documented, not
proposed) and **ADQ-OPEN** (architectural questions the audit surfaced that
need an ADR before a cycle acts on them — per §1 Gate F0, contradictory
decisions must not proceed unresolved).

## AD-OBSERVED — decisions already in code (confirmed)

### AD-001 · Vendored byte-parity server over shared package

`portal_core/forge_portal.py` is copied verbatim into every Forja
(`<pkg>/_forge_portal.py`, `forge-doctor-api` → `scripts/`). Rationale
(code comment): each Forja stays self-contained and installable without a
portal dependency. Enforced by `scripts/vendor.py --check` drift gate +
`forge/PortalAssets/1` sha256 manifest. **Consequence**: changes to the
server must re-vendor all 7 copies in lockstep.

### AD-002 · Adapter contract: Forja supplies ops, server supplies security

The server knows nothing domain-specific; `PortalAdapter.register(Operation)`
is the only extension point. `mutating`, `confirm` literal, `needs_plan_token`,
`timeout` are declared per op — mutation semantics are structural, not
conventional. This directly implements §9 "no arbitrary shell from web UI".

### AD-003 · Plan→confirm→apply bound by HMAC token

`make_plan_token` signs canonical plan JSON; `check_plan_token` requires the
same plan bytes + ≤15 min age. The token must round-trip through the client
(`_REDACT_EXEMPT`). This is the portal's equivalent of the CLI's plan mode.

### AD-004 · Loopback + random session as the entire auth boundary

Decision recorded in `docs/fase0/security-matrix.md` §Decisões: local
single-user tool — session token + loopback is the boundary (Jupyter model).
No user auth, no remote listening, no opt-in flag to widen the bind.

### AD-005 · Bootstrap vs native install is a hard, explicit split (CLI)

Default flow = clone→env→configs→prereqs→setup-script/npm→verify.
Native product install requires explicit native flags and defaults to
`--dry-run` until `--yes`. Verified in `native-install.ts`, `runner.ts:232-266`,
`constants/repos.ts`. This matches `docs/capabilities.md`.

### AD-006 · `.env` is never overwritten

`env.ts` — exists → keep; else copy `.env.example`; else stub with commented
`envKeys`. Uninstall backs it up to `.forge-cli/backups/`. §8-compliant.

### AD-007 · Untrusted content never executes unguarded

Custom repos (`forge-cli.repos.json`) pass the same name/URL validation;
their setup scripts + `forge.json` verify are skipped unless interactive
trust or `--trust-custom`. Manifest verify runs **outside** the repo dir so
a local binary can't shadow PATH (runner.ts:203-213).

### AD-008 · Rollback is checkout-state-only

`lifecycle.ts:rollbackRepo` reverts to the recorded git head and documents
that external installer effects are not reversed. Honest rollback limits —
§8 gate.

### AD-009 · One Forja per portal process

`PortalServer(adapter)` serves exactly one adapter; `the-forge`'s adapter
(20 ops) federates by exposing `specialists.collect` data through ops.
There is no multi-forge portal process — by design the _frontend_ is
forja-agnostic and whichever Forja serves it decides the data scope.

### AD-010 · Honest-state presence semantics

`api.models.ts` header + `default_operations`: `null` = known-absent,
missing = unverified. `NOT_APPLICABLE` is a first-class capability state
(fase0 capability-map records doctor-* showing NA instead of dead buttons).

### AD-011 · The Forge ecosystem already has its bridge

The doc's conditional "Forge Local Bridge (only if a functional gap is
proven)" is satisfied by the vendored portal + adapter + `_installkit.py` +
`~/.forge/installations/` registry + `_graphstudio.py`. **Do not build a
second bridge.** (See ADQ-001.)

### AD-012 · CLI state is workspace-local, not global

`.forge-cli/` lives inside the target dir (state/logs/reports/backups) —
workspaces are independent; no global registry write from the CLI.
Global state that exists (`~/.forge/installations/`) is written by the
Forjas' installkit, not by forge-cli.

## ADQ-OPEN — questions needing ADRs before implementation cycles

### ADQ-001 · Where does the C1 canonical contract set live?

Option A: evolve `forge/PortalApi/1` + `forge/InstallEnvironment/v1` +
`forge/InstallationManifest/v1` + `theforge/<Name>/v1` into the named set
(`ForgeDescriptor`…`ForgeHealthReport`) as standalone schemas, with
PortalApi referencing them. Option B: keep PortalApi self-contained and add
a parallel contract package. **Risk if unresolved**: C1 either duplicates
working contracts (violates §0.2 "no duplicate engines") or rewrites a
vendored, byte-parity-locked surface (huge blast radius).
**Recommendation**: A, additive — extract sub-schemas, keep `forge/PortalApi/1`
as the envelope. Owner decision needed.

### ADQ-002 · Multi-forge aggregation: federator or discovery?

360° dashboard across Forjas can be (A) served by the-forge's adapter (its
`specialists.collect` already sees all installed Forjas — federation page
already works this way), or (B) a discovery layer that fans out to N local
portal processes. A = zero new infra, single-source-of-truth stays in
the-forge; B = independent of the-forge but adds process orchestration +
a security question (portal talking to portals). §0.2's "the-forge stays
orchestrator" favors A. **Owner decision needed before C3.**

### ADQ-003 · forge-cli's role vs installkit

The CLI orchestrates checkout+bootstrap+native-argv. The real install
engine is `_installkit.py`/`forge_install.py` per Forja. Cycle 2's
"advanced install planner" must decide: plan across repos then delegate
per-Forja `install` argv (current boundary — recommended, no new engine),
or re-implement planning inside the CLI (violates "don't duplicate
install engines"). **Needs ADR confirmation before C2.**

### ADQ-004 · Contract schema source-of-truth format

Portal contracts live as Python dict shapes + `api.models.ts` mirror +
prose in `docs/fase0/contracts.md`. No JSON Schema files. §2 wants
"versioned, independent canonical contracts" — decide: JSON Schema per
contract (enables codegen + CI validation) vs doc-typed contracts (status
quo). **Needs ADR before C1.**

### ADQ-005 · Session expiry on the portal

Today: per-process token, no idle expiry. §7 security list asks for session
expiration testing — decide whether expiry is a feature (rotate/TTL tokens)
or a test-only concern. **ADR before C5.**

### ADQ-006 · forge-cli's `forge.json` vs `ForgeDescriptor`

`manifest.ts` reads 3 fields today. If C1 defines `ForgeDescriptor`, decide
whether `forge.json` becomes its on-disk form (one file per Forja, additive)
or a new file name is introduced (migration cost). **ADR before C1.**

## Cycle 1 decisions (recorded 2026-10-14)

### ADR-C1-001 · Canonical contract home = `forge-cli/contracts/` (resolves ADQ-001, ADQ-002)

The eight `forge/<Name>/v1` contracts live as JSON-Schema files in
`forge-cli/contracts/schemas/`, with a stdlib-only Python validator
(`contracts/forge_contracts.py`) and a TypeScript mirror validator
(`src/contracts/`). Alternatives considered:

- **Portal repo as home** — rejected: the Portal is an optional consumer
  like the CLI; making contracts depend on it would invert the
  optionality rule (§0.3). The Portal may vendor the same files.
- **New `forge-contracts` repo** — rejected for C1: adds a 9th repo to
  vendor/govern for files that are pure data; revisit if Forjas ever need
  to _push_ contract changes upstream (ADR-C1-003).
- **Shared vendored copy in every repo** — kept as the distribution
  mechanism (same byte-parity model as `_forge_portal.py` /
  `_installkit.py`), but with forge-cli as the canonical _edit_ location
  because the CLI is the primary contract consumer/validator today.

Forja-side consumption requires zero new runtime deps: the Python module
is stdlib-only and vendorizable; Forjas that prefer can read the JSON
schemas directly (they are plain draft-07 documents).

### ADR-C1-002 · `forge.json` is the on-disk form of `ForgeDescriptor` (resolves ADQ-006)

Decision: **extend `forge.json` additively** — no new file name. The
existing 3-field manifests (`forge_id`, `cli`, `mcp_command`) already
satisfy `ForgeDescriptor/v1` unchanged; new fields (`schema`, `name`,
`version`, `kind`, `capabilities`, `install`, `environment`) are optional
and tolerated by older readers (unknown-field tolerance is a hard rule of
the family). `forge.agentic.json` (`forge/SpecialistAgenticManifest/v1`,
present in 6 of 7 Forjas) contributes `mcp_command`, `host_adapters` and
`workflows` into the derived descriptor view — derivation is one-way
(agentic manifest → descriptor view), the file is not rewritten.

`manifest.ts` is fail-closed on version: a manifest that _declares_ a
`schema` it doesn't satisfy is discarded entirely rather than partially
trusted; schema-less manifests keep legacy behavior.

### ADR-C1-003 · Contract format = JSON Schema draft-07 subset (resolves ADQ-004)

Machine-checkable JSON Schema per contract, restricted to the subset both
validators implement (type/required/properties/enum/const/pattern/items/
$ref/lengths). Chosen over doc-typed contracts because C5/C6 need
programmatic validation of plans/receipts and Forjas need zero-dep
verification offline. Internal `$ref` only (`forge/<Name>/vN`); external
refs refused — keeps validators dependency-free and offline.

### ADR-C1-004 · Discovery model: five origins, seven states (§1.3)

`resolveDiscovery()` orders evidence: verified local manifests > existing
Forja discovery services > trusted local catalog/cache > optional remote
registry > explicit fallback. Each observation carries one of seven
`DiscoveryState`s (`integrated|validated|configured|declared|detected|
degraded|unknown`) plus an evidence string; UI/CLI must render the state
verbatim — collapsing `declared` into `integrated` is a contract
violation, covered by tests.

## Gate F0 checklist (§1) — answered line by line

- [x] Both `main` SHAs identified: forge-cli `f893bb0308f2c4016e024d7e21a2e9e79f09c64a`, forge-portal `2b2debc4b5cff460ccb7407b27471a41bce8229e`.
- [x] Inventory complete: §1.2 file list walked individually; §1.3 portal surface walked (routes, stores, client, backend, adapters, vendoring, tests, docs).
- [x] Test results registered verbatim: CLI 296/296 vitest + typecheck/lint/format/build/pack; Portal 45/45 pytest + 11/11 ng + 12/12 browser-e2e + prettier + build.
- [x] Gaps prioritized: CAPABILITY_GAP_MATRIX §5.
- [x] Plan preserves existing functionality: IMPLEMENTATION_PLAN marks every existing feature `keep`; no cycle proposes replacement of the vendored portal, installkit, graph studio, or adapter contract.
- [~] Contradictory architectural decisions → ADR: none found _between_ implementations (the repos agree with each other). The ADQ-OPEN items above are **forward-looking** decisions where the master doc's intent could conflict with existing architecture — they are flagged for owner decision, not silently resolved.
- [x] Open PRs checked: none in either repo.
- [x] No code changes on `main`: audit produced documents only, left uncommitted.
