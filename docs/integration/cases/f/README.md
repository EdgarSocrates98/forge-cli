# Case F — Incompatible specialist → blocked with explicit diagnostic

**Mode: TEST-BACKED (SIMULATED fixtures)** — deterministic unit tests plus
one real discovery attempt that is honestly _not_ accepted as proof.

## Intent

A specialist whose manifest/descriptor version drifts out of the
compatible range must surface `INCOMPATIBLE`, refuse with an explicit
diagnostic, and never execute.

## Evidence

1. **Real attempt (not accepted as incompatible proof)** —
   `evidence-discover.json`: a forged Sentinel descriptor
   (`cases/f/data-sentinel-forge/forge*.json`, version `99.0.0`) was
   offered via checkout source. Discovery reported `VERIFIED` v99.0.0
   because the _installed distribution_ metadata did not conflict with
   it — the descriptor pin does not by itself trigger INCOMPATIBLE.
   Kept as honest negative evidence of where the check actually lives.
2. **Authoritative tests** — `evidence-test-incompatible.txt`:
   ```
   .venv/bin/python -m pytest tests/test_delegation.py \
       -k "incompatible" --tb=short -q
   → 3 passed, 42 deselected
   ```
   - `test_incompatible_requires_python` — python-requires mismatch
     marks the peer `INCOMPATIBLE`.
   - `test_incompatible_manifest_major_drift` — manifest major-version
     drift marks `INCOMPATIBLE`.
   - `test_delegate_incompatible_blocked` — plan/run refuse with the
     `version-incompatible` refusal code **before** any subprocess is
     spawned.

## Result

INCOMPATIBLE is a named discovery state that maps to a named refusal
(`version-incompatible`) in `delegation/run.py`; execution is blocked
upstream of argv construction. The real CLI path only reaches
INCOMPATIBLE through descriptor/manifest checks that actually fail —
a spoofed version string in an uninstalled checkout does not, which is
itself documented behavior (trust comes from the live probe of the
installed provider, not from repo text).
