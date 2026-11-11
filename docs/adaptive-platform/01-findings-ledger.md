# Findings ledger

| ID       | Severity | Finding                                              | Status          | Verification                                                                           |
| -------- | -------- | ---------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------- |
| AP-13-01 | P1       | No `workspace scan/list/use/status/doctor` contract  | FIXED_IN_BRANCH | adaptive workspace tests                                                               |
| AP-14-01 | P1       | Environment report lacked per-capability states      | FIXED_IN_BRANCH | `EnvironmentCapabilities/v1` implementation                                            |
| AP-15-01 | P0       | Local lifecycle has mutation-before-validation paths | FIXED_IN_BRANCH | validation-order, source-conflict and lifecycle-lock tests                             |
| AP-16-01 | P1       | No portable distribution ZIP                         | FIXED_IN_BRANCH | pack round-trip tests                                                                  |
| AP-16-02 | P1       | No independent ZIP verifier/import safety            | FIXED_IN_BRANCH | corruption and path-safe extraction tests                                              |
| AP-17-01 | P2       | UX had no adaptive workspace view                    | FIXED_IN_BRANCH | visual workspace command                                                               |
| AP-18-01 | P1       | No federated capability matrix                       | PARTIALLY_FIXED | existing Forge catalog + new inventory; peer runtime matrix remains evidence-dependent |
| AP-18-02 | P1       | Release workflow did not verify portable artifacts   | FIXED_IN_BRANCH | CI pack verify, release ZIP and SHA256SUMS workflow gates                              |

The remaining federated peer-runtime limitation is external-evidence dependent and is not silently promoted to PASS by the local capability catalog.
