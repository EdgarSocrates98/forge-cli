# Case C — OpenAPI breaking change → API Forge `forge doctor` delegation

**Mode: REAL** (live `apiforge` + `forge-doctor-api` CLIs)

## Intent

Two OpenAPI revisions where v2 introduces breaking changes. API Forge routes
API audit intents to Forge Doctor API through `apiforge forge doctor scan`
(closed, read-only adapter argv), persists delegated scans, and `forge doctor
compare` produces a derived delta between persisted runs.

## Fixtures

- `workspace/openapi-v1.yaml` — baseline (GET /orders, POST /orders,
  `OrderInput.customer_id` optional).
- `workspace/openapi-v2-breaking.yaml` — breaking revision (removes
  GET /orders, makes `customer_id` required).
- `workspace/project/openapi.yaml` — the scanned working copy (v2 content).

## Commands run

```bash
apiforge forge doctor discover --root workspace/                     # evidence-discover.txt
apiforge forge doctor scan --root workspace/ --spec openapi-v1.yaml \
    --format agent                                                   # evidence-scan-v1.txt → drun-7c3991def37797d8
apiforge forge doctor scan --root workspace/ --spec openapi.yaml \
    --fail-on breaking                                               # REFUSED AF-DELEG-USAGE → drun-b66b62a4deb05bf4
apiforge forge doctor scan --root workspace/ --spec openapi.yaml     # evidence-scan-v2.txt → drun-f90eaac628215654
apiforge forge doctor list --root workspace/                         # evidence-list.txt
apiforge forge doctor compare --root workspace/ \
    drun-7c3991def37797d8 drun-f90eaac628215654                      # evidence-compare.txt
forge-doctor-api contract compatibility \
    --base openapi-v1.yaml --head openapi-v2-breaking.yaml --json    # evidence-compat.json
```

## Result (observed)

- Doctor API discovery: VERIFIED (delegation adapter found live provider).
- Both scans persisted under
  `workspace/.apiforge/forge/delegations/drun-*/` (`record.json`,
  `scan.json`, `scan.agent.txt`, `events.jsonl`).
- `--fail-on breaking` attempt **refused `AF-DELEG-USAGE`** and persisted
  as a refusal record: the closed delegated argv has no `--baseline`
  contract slot, so the flag is rejected by the adapter rather than
  silently forwarded — an honest adapter limitation, kept as evidence.
- `forge doctor compare` produced an `apiforge-derived` delta between the
  two persisted scans (added `OAS018` Order schema; changed `APISEC011`,
  `OAS010`, `OAS020 createOrder`; removed `APISEC006`, `OAS020 listOrders`).
- Direct `forge-doctor-api contract compatibility` classified **2
  BREAKING changes**: removed `GET /orders`, and
  `OrderInput.customer_id` optional→required (`evidence-compat.json`).

Note: compare is derived from persisted scan findings (not a native
Doctor diff); the BREAKING verdict comes from Doctor's own compatibility
surface, run directly — both are REAL and kept distinct on purpose.

## Evidence files

`evidence-*.txt|json` transcripts + full `workspace/.apiforge/` persistence
tree (3 run dirs: 2 scans + 1 refusal, plus economy ledger).
