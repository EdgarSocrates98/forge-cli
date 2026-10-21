# Case B — PySpark project → Forge Doctor Data scan via delegated run

**Mode: REAL** (live CLIs, live subprocess delegation)

## Intent

A PySpark project with planted anti-patterns is scanned by Forge Doctor Data
through Spark Forge AWS delegation (`doctor.scan-project`, LOCAL_READ).
Expected: structured findings, zero mutations to the project tree.

## Fixture

`workspace/project/etl_job.py` plants three anti-patterns:
`df.collect()` (driver collect), `repartition(1)` (single partition),
and an unconditioned cross join.

## Commands run

```bash
sparkforge-aws delegate plan --repo workspace/ \
    --intent "scan the pyspark project for problems" \
    --input project:project --json                      # evidence-plan.json
sparkforge-aws delegate run  --repo workspace/ \
    --intent "scan the pyspark project for problems" \
    --input project:project --json                      # evidence-run.json
sha256sum workspace/project/etl_job.py                  # input-sha256.txt
find workspace/project -type f                          # mutation check (below)
```

## Result (observed)

- Plan selected `forge-doctor-data / doctor.scan-project` (LOCAL_READ).
- Run: `completed`, exit 0, `elapsed_ms=4769`; **3 findings**:
  `SPARK001` (collect), `SPARK003` (repartition(1)), `SPARK009`
  (cartesian/unconditioned join).
- Handoff persisted:
  `workspace/.sparkforge_aws/delegation/handoffs/dl-a9da797097d48e85-doctor.scan-project-9583103e6285.json`
  — copy: `handoff-persisted.json`.
- **Zero Doctor mutations**: `find workspace/project -type f` returns only
  `etl_job.py`, sha256 unchanged (`input-sha256.txt`). The only new files
  under `workspace/` are the delegation ledger (`.sparkforge_aws/`).

## Evidence files

| File                     | What                                     |
| ------------------------ | ---------------------------------------- |
| `evidence-plan.json`     | plan → `doctor.scan-project`             |
| `evidence-run.json`      | completed run, 3 findings, handoff ref   |
| `handoff-persisted.json` | EvidenceHandoff copy                     |
| `input-sha256.txt`       | pre/post file hash (unchanged)           |
| `workspace/`             | fixture project + delegation persistence |
