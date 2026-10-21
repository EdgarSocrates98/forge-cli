# Case H — Context / token economy of delegation

**Mode: REAL measurements; tokens unresolved** (no host/agent transcript
token accounting was available — per rules, no token number is invented).

## What was measured

All numbers in `evidence-measurements.txt`; raw captures in
`evidence-bytes-sentinel.txt` and `workspace/sentinel-descriptors.json`,
`workspace/sentinel-raw.json`.

### Routing context surfaces (bytes)

| Surface                                    | Bytes        |
| ------------------------------------------ | ------------ |
| `data-sentinel capabilities --descriptors` | 10,008       |
| `forge.agentic.json`                       | 1,357        |
| `forge.json`                               | 397          |
| **Descriptor surface total**               | **≈11.8 KB** |
| Sentinel docs corpus (129 `.md`)           | 323,982      |
| Sentinel AGENTS+README+CLAUDE              | 7,944        |

Routing needs only descriptors+manifests (≈11.8 KB); the full doc corpus
is ~28× that. Bytes ≠ tokens — the ratio, not a token figure, is the
claim.

### Delegated payload sizes (bytes)

- `delegate discover` output: 2,210 · `delegate plan`: 1,064 ·
  `delegate run` result: 3,272 → whole discover→plan→run→evidence loop
  ≈ 6.5 KB of JSON through the agent.
- Sentinel raw `--json` report: 1,779; persisted EvidenceHandoff: 1,701
  (bounded, redacted, integrity-hashed).
- Doctor `scan.agent.txt`: 1,556 (baseline) / 1,185 (current).
- API Forge economy ledger (`legacy`): **5 calls, 8,375 payload bytes**
  (`cases/c/workspace/.apiforge/economy.jsonl`); its stats report
  `observed_tokens: "unresolved"`.

### Subprocess calls (strace-measured)

`delegate discover` with 2 peers: **3 governed `execve` spawns**
(sentinel `--version`, sentinel `capabilities --descriptors`,
doctor `--version`) — no shell, each with a **6-variable scrubbed env**.

### Latency (REAL, wall/exec)

- `delegate discover` (2 peers, live probes): ~15 s wall.
- delegated Sentinel exec: 3,686 ms; delegated Doctor exec: 4,769 ms.
- direct `data-sentinel analyze` same log: 3.7 s (delegation overhead ≈
  process+handoff bookkeeping, seconds-scale, acceptable for batch runs).
- `orchestrate plan` (narrowed): ~7 s; `task run` pyspark exec: 5,681 ms.

## Honest gaps

- **observed_tokens: unresolved** — no host transcript; not inferred
  from bytes (Bytes ≠ Tokens invariant).
- Effective token _savings_ therefore unresolved; the evidenced claim is
  bounded byte surfaces + exact call counts + measured latency.
- No redundant-operation counter exists today beyond call counts;
  recorded as P2 gap.
