# Case D — The Forge orchestration on a PySpark audit intent

**Mode: REAL** (live `forge` CLI) — with two honestly separated results:
an orchestration _plan_ (prepared entry) and a separate direct _task run_.

## Intent

`forge orchestrate` on "audit a pyspark project" should produce a
justified plan and, where possible, a consolidated report with handoffs.

## Commands run

```bash
# discovery preludes (persisted in workspace/.forge/specialists/)
forge specialists collect --repo workspace/            # evidence-specialists-collect.json
forge specialists list --repo workspace/               # evidence-specialists-list.txt

# orchestration (two attempts — see notes)
forge orchestrate plan "audit a pyspark project" --repo workspace/ \
    --target pyproj                                    # evidence-plan*.json / .err
forge orchestrate run  "audit a pyspark project" --repo workspace/ \
    --target pyproj                                    # evidence-run.json / .err

# direct task surface (separate REAL execution proof)
forge task plan --repo workspace/ --task pyspark-audit --target pyproj \
    --provider spark-forge-aws                         # evidence-task-plan.json
forge task run  --repo workspace/ --task pyspark-audit --target pyproj \
    --provider spark-forge-aws                         # evidence-task-run.json
```

## Result (observed)

1. **Scan-budget exhaustion (first attempt)** — `evidence-plan.err`:
   the fixed 5 s discovery scan budget expired during verification,
   producing an `unavailable` plan whose six entries carry
   `"scan budget 5s exhausted: verification skipped"` limitations.
   Honest limitation, kept as evidence.
2. **Narrowed orchestration (providers.toml scoping)** — a valid report
   persisted at
   `workspace/.forge/orchestrations/orch-0cd48be22635-*.json`:
   `kind=plan`, `status=planned`, correlation `orch-0cd48be22635`,
   entry `spark-forge-aws / pyspark.static-analysis` with status
   `prepared` and `finding_class=STATIC`. The entry is prepared for the
   Forge Protocol execute surface — the provider declares the capability
   without an argv entrypoint, so no handoff exists at plan time.
   Report shape includes six unresolved entries and six recommendations.
3. **Direct task run (same intent, real execution)** —
   `evidence-task-run.json`: stage `COMPLETED`, mode
   `DIRECT_CAPABILITY`, exit 0, `elapsed_ms=5681`; the command invoked
   Spark Forge AWS (`python -m sparkforge_aws … analyze pyspark`) and
   stdout contains the planted `repartition(1)` finding. Delegation
   record persisted at `workspace/.forge/delegations/task-f14f8f425ce9.json`.

## Honest boundaries

- The orchestration _plan_ proves routing + justification + governance
  shape; it does **not** claim a consolidated multi-provider handoff.
- A vocabulary gap was found: Sentinel workflows declare `{artifact}`
  placeholders while The Forge task target substitution resolves
  `{target}` — recorded as an unresolved gap (see final-report P1).
