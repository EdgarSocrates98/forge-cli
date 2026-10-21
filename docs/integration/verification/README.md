# Verification runs — lf-0033

All commands executed 2026-10-21 against the repositories' own `.venv`
interpreters. Logs: `*.log` next to this file. Exact command per repo:

```bash
# python repos (each in its own checkout)
.venv/bin/python -m pytest -k "deleg or integr or orchestr" -o addopts="" --tb=short -q

# forge-cli
npx vitest run -t integration
```

## Results

| Repo                | Result                                                | Duration | Log                              |
| ------------------- | ----------------------------------------------------- | -------- | -------------------------------- |
| spark-forge-aws     | 236 passed, 7 skipped, 14798 deselected               | 450 s    | `spark-forge-aws-pytest.log`     |
| spark-forge-azure   | 68 passed, 1 skipped, 3067 deselected                 | 49 s     | `spark-forge-azure-pytest.log`   |
| api-forge           | 122 passed, 1 skipped, 1871 deselected                | 279 s    | `api-forge-pytest.log`           |
| data-sentinel-forge | 66 passed, 979 deselected                             | 76 s     | `data-sentinel-forge-pytest.log` |
| forge-doctor-data   | 84 passed, 2616 deselected                            | 186 s    | `forge-doctor-data-pytest.log`   |
| forge-doctor-api    | 18 passed, 1962 deselected                            | 21 s     | `forge-doctor-api-pytest.log`    |
| forge-cli           | vitest: 10 passed (2 files), 1184 skipped             | 27 s     | `forge-cli-vitest.log`           |
| the-forge           | **4 failed**, 2809 passed, 54 skipped (2867/5425 selected) | 8,718 s  | `the-forge-pytest.log`           |

### the-forge failures (reported, not hidden)

All four are in `tests/test_browser_real_adapter.py` — the real
portal/browser adapter suite, where serving-adapter operations exceed
`run_with_timeout` and return HTTP 504 to the test client:

- `test_specialists_federation_real`
- `test_capabilities_real`
- `test_install_plan_preview_only`
- `test_no_console_errors_on_routes`

Reproduced in isolation on this machine (same 4 of 9 fail with
`TimeoutError` inside `_forge_portal.py:run_with_timeout`), so they are
a repeatable environment/dependency issue in the portal real-adapter
path — **not** a delegation/orchestration regression: the cycle-relevant
files were run separately and are fully green:

```bash
python -m pytest tests/test_delegation_governance.py \
  tests/test_specialist_delegation.py tests/test_delegation_router.py \
  tests/test_orchestrate.py -q
# → 80 passed in 6.91s
```

A standalone probe of `tests/test_reality_collect.py` (outside this
subset) also showed `test_snapshot_info_counts_lists_and_dicts` failing
on a pytest `tmp_path`-outside-repo assumption — environmental harness
issue, recorded for the parent.
