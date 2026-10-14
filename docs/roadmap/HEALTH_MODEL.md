# forge-health/v1 — health score model (spec C5/§5.1)

Doctor 2.0 emits a health score only under a transparent, documented model.
A partial observation must never render as 100%: when evidence is
insufficient, `score.value` is `null` and surfaces render **NÃO VERIFICADO**.

## Report contract

`runDoctor2(root, opts)` → `forge/DoctorReport/v1`:

- `checks: DoctorCheck[]` — every check carries `id`, `domain`, `result`,
  `severity`, `diagnosis`, real `evidence[]` (paths probed, values seen),
  optional `correctiveAction`, `reversible`, and a `timestamp` from the
  injected clock (`opts.now`, default `Date.toISOString`).
- `truncated: true` when any bounded scan hit its cap (report receipts,
  ledger entries, evidence lists).
- `score: HealthScore` — computed by `computeHealthScore` in
  `src/doctor2/model.ts`; this document is the model reference.

## Domains and weights

Five domains, weighted by operational blast radius (total 100):

| domain         | weight | what it covers                                                         |
| -------------- | ------ | ---------------------------------------------------------------------- |
| `system`       | 15     | node >= 18, platform, workspace r/w probe, required dirs, offline      |
| `installation` | 25     | `.forge-cli`, `forge.json`, lockfile+drift, ledger, checkouts, backups |
| `environment`  | 20     | `.env` presence, missing keys vs schema, hygiene, port conflicts       |
| `hosts`        | 15     | per-adapter detection; auth `unknown` is honest `unverified`           |
| `operations`   | 25     | receipts scan, recurring failures, interrupted recovery                |

## Formula

```
deduction = Σ over checks:
  fail: SEVERITY_DEDUCTION[severity] × (weight[domain] / 25)
  warn: (SEVERITY_DEDUCTION[severity] / 2) × (weight[domain] / 25)
value = max(0, round(100 − deduction))
```

Severity deductions (raw points before the domain-weight scale):

| severity   | deduction |
| ---------- | --------- |
| `info`     | 0         |
| `low`      | 3         |
| `medium`   | 8         |
| `high`     | 15        |
| `critical` | 30        |

The `weight / 25` normalizer makes deductions proportional to how much the
domain matters: a `medium` fail in `installation` (weight 25) costs 8
points, while the same fail in `system` (weight 15) costs 4.8. `skip`,
`unverified` and `pass` never deduct.

## Sufficiency gate

`observed` counts checks with `evidence.length > 0` and `result !==
'unverified'` (a check that could not run is not evidence).

- `observed >= 8` (`HEALTH_MIN_CHECKS`) → `sufficient = true`, `value` is
  the computed 0–100 score.
- `observed < 8` → `sufficient = false`, `value = null`. Renderers show
  NÃO VERIFICADO plus the `observed/required` ratio — never an
  interpolated percentage.

`score.sufficiency` and `score.domains` (per-domain check/fail/warn counts)
are emitted with the score so consumers can audit why a number exists —
or why it does not.

## Pinned check ids

The heal registry (`src/heal/`) keys on check ids. These are contract:

- `installation.forge-dir.absent` — `.forge-cli` missing → `fail`/`low`,
  corrective `create .forge-cli state dir`, `reversible: true`.
- `environment.env.missing-key` — schema-declared keys absent from `.env`
  → `warn`/`medium`, evidence lists key **names** (never values),
  corrective `restore missing keys`, `reversible: true`; `unverified`
  when no schema exists to compare against.
- `installation.lockfile.drift` — lockfile digest ≠ recomputed →
  `warn`/`medium`, corrective `regenerate lockfile`, `reversible: true`;
  `unverified` when there is no lockfile or it covers no forges.
- `installation.backup.present` — `pass` when a restorable backup exists,
  else `skip`.

## Model versioning

`model: 'forge-health/v1'`. Any change to weights, deductions or the
sufficiency gate bumps the version and updates this document — scores from
different versions are not comparable.
