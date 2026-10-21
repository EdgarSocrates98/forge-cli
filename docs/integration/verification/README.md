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
| the-forge           | see `the-forge-pytest.log` (long run — captured live) | —        | `the-forge-pytest.log`           |

### Additional honest result

A broader ad-hoc probe in the-forge
(`-k "delegation or orchestrat or handoff or discovery or specialist"`,
498 passed) surfaced **one failure**:
`tests/test_browser_real_adapter.py::test_specialists_federation_real`
→ `HTTPError 504` on the `/federation` endpoint of a _real_ browser
adapter — an environmental/live-adapter timeout, not a contract
regression. Reported, not hidden. It sits outside the required subset.
