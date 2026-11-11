# Compatibility matrix

| Surface                          | Linux                   | Windows                      | Gitless                 | Offline                 | Status                       |
| -------------------------------- | ----------------------- | ---------------------------- | ----------------------- | ----------------------- | ---------------------------- |
| workspace scan/list/status       | source-compatible       | source-compatible            | supported               | supported               | VERIFIED locally             |
| workspace use                    | source-compatible       | source-compatible            | supported               | supported               | VERIFIED by contract/tests   |
| pack verify                      | supported               | supported                    | supported               | supported               | VERIFIED by round-trip tests |
| pack import                      | supported               | supported                    | supported               | supported               | VERIFIED by round-trip tests |
| native install scripts           | existing route          | PowerShell/Git Bash resolver | not applicable          | blocked by policy       | PARTIALLY_VERIFIED           |
| local lifecycle staging/recovery | existing implementation | existing implementation      | existing implementation | existing implementation | VERIFIED_WITH_LIMITATION     |
| federated peer runtime           | not run                 | not run                      | n/a                     | n/a                     | NOT_TESTED                   |

Platform-specific claims require CI runs on the corresponding hosted runner; source compatibility is not a hosted execution claim.
