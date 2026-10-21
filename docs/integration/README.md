# Integration cycle — index (lf-0027 … lf-0033)

End-to-end evidence and documentation for the cross-forge integrations
cycle: optional, governed, evidence-preserving collaboration between
specialist repositories. Central claim: route only the appropriate
capability to a verified specialist; preserve provenance in handoffs;
degrade safely when a specialist is absent or incompatible; never
fabricate a delegation.

## Cycle artifacts

| Doc                                                | Content                                                        |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `final-report.md`                                  | Consolidated 17-section report (baselines → release readiness) |
| `baseline.md`                                      | Repo baselines + SHAs at cycle start                           |
| `existing-contracts.md`                            | Contracts catalogued before any change                         |
| `confirmed-gaps.md`                                | Gaps confirmed by audit                                        |
| `capability-matrix.md`                             | Declared capabilities per specialist                           |
| `specialist-routing.md`                            | Routing/discovery semantics (DISCOVERED ≠ VERIFIED)            |
| `security-boundaries.md`                           | Security model for delegation                                  |
| `audit-core.md` / `audit-data.md` / `audit-api.md` | Per-surface audits                                             |
| `verification/`                                    | Per-repo test-subset logs with exact commands                  |
| `cases/`                                           | E2E case evidence A–H                                          |

## E2E cases

| Case | Scenario                                                                                        | Mode                                                                | Dir        |
| ---- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| A    | Spark log → Spark Forge AWS delegates to Data Sentinel (`sentinel.log-analysis`)                | **REAL**                                                            | `cases/a/` |
| B    | PySpark project → delegated Forge Doctor Data scan, 3 findings, 0 mutations                     | **REAL**                                                            | `cases/b/` |
| C    | OpenAPI breaking change → `apiforge forge doctor` scans + compare delta                         | **REAL**                                                            | `cases/c/` |
| D    | The Forge orchestration "audit a pyspark project" → justified plan + direct task run            | **REAL** (plan prepared; consolidated handoff honestly not claimed) | `cases/d/` |
| E    | Specialist absent → `NOT_INSTALLED`/`provider-absent` + native fallback, no fake exec           | **REAL**                                                            | `cases/e/` |
| F    | Incompatible specialist → `INCOMPATIBLE` + `version-incompatible` refusal                       | **TEST-BACKED** (+ real negative attempt kept)                      | `cases/f/` |
| G    | Security battery: injection, traversal, oversized output, creds, manifest, cycle, timeout, kill | REAL CLI cells + test-backed cells                                  | `cases/g/` |
| H    | Context/token economy: descriptor bytes vs doc corpus, call counts, latency                     | REAL byte/call/latency measures; **tokens unresolved**              | `cases/h/` |

Each case dir contains a `README.md` with exact commands, persisted JSON
outputs, handoff files, and a REAL / SIMULATED / TEST-BACKED marker.

## Where the delegation surfaces live

- Spark Forge AWS → optional specialists: `delegate discover|plan|run|handoffs`
  (`spark-forge-aws/sparkforge_aws/delegation/`).
- API Forge → Forge Doctor API: `apiforge forge doctor
discover|scan|list|compare` (`api-forge/src/apiforge/forge/doctor.py`).
- The Forge → universal providers: `forge specialists`,
  `forge orchestrate plan|run`, `forge task plan|run`
  (`the-forge/src/theforge/orchestrate.py`).
- Forge CLI optional-integration classification:
  `forge-cli/src/integrations.ts` (`OPTIONAL_INTEGRATIONS`).
