# Case A — Spark log → Spark Forge AWS delegation → Data Sentinel

**Mode: REAL** (live CLIs, live subprocess delegation)

## Intent

Given a Glue/Spark runtime log showing an OOM, Spark Forge AWS should route to
Data Sentinel's `sentinel.log-analysis` capability (LOCAL_READ), run it, and
persist an EvidenceHandoff preserving provenance.

## Setup

- Fixture: `workspace/glue_oom.log` (copied from
  `data-sentinel-forge/fixtures/logs/glue_oom.log`).
- PATH used the repo venvs: `spark-forge-aws/.venv/bin`,
  `data-sentinel-forge/.venv/bin`, `forge-doctor-data/.venv/bin`
  (specialists are discovered by probe, not by checkout alone).

## Commands run

```bash
sparkforge-aws delegate discover --repo workspace/        # evidence-discover.json
sparkforge-aws delegate plan --repo workspace/ \
    --intent "analyze the spark runtime log for oom" \
    --input log:glue_oom.log --json                      # evidence-plan-log.json
sparkforge-aws delegate run  --repo workspace/ \
    --intent "analyze the spark runtime log for oom" \
    --input log:glue_oom.log --json                      # evidence-run.json
sparkforge-aws delegate handoffs --repo workspace/ --json # evidence-handoffs.json
```

## Result (observed)

- Discovery: `data-sentinel-forge` **VERIFIED** v0.1.0 and
  `forge-doctor-data` **VERIFIED** v1.0.5 (handshake PASS, health PASS;
  manifest check SKIP — descriptors fetched via live probe).
- Plan selected `data-sentinel-forge / sentinel.log-analysis`
  (risk `LOCAL_READ`, allowed by default policy). An earlier intent
  phrasing ("diagnose glue job failure") selected `sentinel.glue-diagnose`
  which requires `EXTERNAL_READ`+`COST_BEARING` and was correctly refused —
  see `evidence-plan.json`.
- Run: `completed`, exit 0, `elapsed_ms=3686`; **1 finding** —
  `CONFIRMED` high-severity `OutOfMemoryError` (Java heap space).
- Handoff persisted:
  `workspace/.sparkforge_aws/delegation/handoffs/dl-7460c06c386ac128-sentinel.log-analysis-993992756d5e.json`
  (schema `theforge/EvidenceHandoff/v1`; correlation id, idempotency key,
  sha256 integrity hash, provider/version, input refs, finding evidence
  refs, limitations, status). Copy: `handoff-persisted.json`.

## Evidence files

| File                     | What                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `evidence-discover.json` | governed discovery output (2 peers VERIFIED)               |
| `evidence-plan.json`     | earlier plan → policy-refusal for EXTERNAL_READ capability |
| `evidence-plan-log.json` | plan selecting `sentinel.log-analysis`                     |
| `evidence-run.json`      | completed delegated run, finding + handoff ref             |
| `evidence-handoffs.json` | `delegate handoffs` listing                                |
| `handoff-persisted.json` | the persisted EvidenceHandoff                              |
| `workspace/`             | fixture + `.sparkforge_aws/` persistence tree              |
