# Environment capabilities

`forge/EnvironmentCapabilities/v1` adapts the existing offline environment discovery into per-capability states: `AVAILABLE`, `UNAVAILABLE`, `BLOCKED`, `INCOMPATIBLE`, and `UNKNOWN`.

The resolver records Node, npm, Git, Python, shell route, network policy, and administrative restrictions. `publish` is always reported as `BLOCKED` by the local resolver because release publication is an explicit release-engineering action, never an implicit CLI install side effect.

The existing shell resolver remains authoritative for Windows PowerShell/Git Bash routing. WSL is not promoted to a native installer route.
