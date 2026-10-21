# Case G — Security battery

**Mode: mixed — REAL CLI attempts + TEST-BACKED (deterministic fixtures)**
for the cells where a fresh real trigger would need unsafe or
infrastructure conditions.

## Coverage matrix

| Threat                                        | Mode | Evidence                                                                                                                                                                                 |
| --------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command injection                             | REAL | `evidence-injection.json` — target `x; touch /tmp/PWNED_DELEGATION` returned a named `invalid-output` refusal; `/tmp/PWNED_DELEGATION` **not created** (argv-only execve, no shell)      |
| Path traversal                                | REAL | `evidence-traversal-refused.json` — target `../../../../etc/passwd` → `invalid-input`, "must not contain `..` segments"                                                                  |
| Timeout                                       | REAL | `evidence-timeout.json` — 1 s budget vs Sentinel → refusal `timeout`, handoff `status=failed`, `retryable=true` (persisted: `workspace/.sparkforge_aws/delegation/handoffs/dl-2e0acaf…`) |
| Unauthorized external access                  | REAL | `evidence-external-read-denied.json` — capability needing `EXTERNAL_READ`+`COST_BEARING` → `policy-refusal`, blocked before any AWS call                                                 |
| Input injection (control chars)               | TEST | spark-forge-aws suite (see below) — control-character rejection                                                                                                                          |
| Oversized output                              | TEST | spark-forge-aws suite — oversized output refused (not silently truncated); truncation flags preserved                                                                                    |
| Missing credentials                           | TEST | spark-forge-aws suite — env scrubbed of credential-shaped values (also REAL-observed: child env = 6 vars, Case H)                                                                        |
| Invalid provider manifest                     | TEST | spark-forge-aws suite — untrusted/invalid manifest → named state, never executed                                                                                                         |
| Delegation cycle / revisit / hop budget       | TEST | the-forge suite — cycle detection, visited providers, hop limit                                                                                                                          |
| Killed/interrupted process                    | TEST | the-forge suite — non-zero/signal exits → failed handoff, refusal preserved                                                                                                              |
| Evidence integrity / confidence non-promotion | TEST | both suites — sha256 integrity, redaction, `POSSIBLE` never promoted to `CONFIRMED`                                                                                                      |
| Doctor read-only mutation guard               | TEST | api-forge suite — closed argv, output cap, timeout, credential scrub                                                                                                                     |

## Test commands and results

```bash
# spark-forge-aws (curated security subset): 24 passed, 21 deselected
python -m pytest tests/test_delegation.py -k "security or injection or traversal or oversized or credential or timeout or env or output" -q
# → evidence-sparkforge-aws.txt

# the-forge (governance/handoff security): 23 passed, 22 deselected
python -m pytest -k "handoff or delegation or chain or cycle or budget" -q
# → evidence-theforge.txt

# api-forge (doctor delegation hardening): 15 passed, 35 deselected
python -m pytest -k "doctor or deleg" -q
# → evidence-apiforge.txt
```

(Exact `-k` expressions are recorded in each evidence file header.)

## Honest notes

- No cell claims a real breach attempt beyond what ran; test cells name
  the fixture/monk​eypatch basis inside the suites.
- Refusal codes, `unlock` guidance, bounded output, scrubbed env, and
  persisted-failed handoffs are all preserved rather than swallowed.
