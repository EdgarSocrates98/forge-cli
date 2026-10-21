# Case E — Specialist absent → optional state + native fallback

**Mode: REAL** (live `sparkforge-aws` with specialist paths hidden)

## Intent

When optional specialists are not installed, Spark Forge AWS must report
a named optional state, refuse delegation by name, and still offer its
native fallback — never fabricate a specialist run.

## Commands run

```bash
# sibling checkouts hidden via env-scoped PATH (no .venv dirs on PATH)
env PATH=/usr/bin:/bin ... sparkforge-aws delegate discover --repo workspace/ --json
                                                        # evidence-discover-no-path.json
sparkforge-aws delegate plan --repo workspace/ \
    --intent "analyze the spark runtime log for oom" \
    --input log:glue_oom.log --json                     # evidence-plan-absent.json
sparkforge-aws delegate run  --repo workspace/ \
    --intent "analyze the spark runtime log for oom" \
    --input log:glue_oom.log --json                     # evidence-run-absent.json

# checkout visible on disk but no executable probe
sparkforge-aws delegate discover --repo workspace/ --json \
    (with sentinel checkout present, probes disabled/absent)
                                                        # evidence-discover-checkout.json

# native fallback still works with specialists absent
sparkforge-aws analyze pyspark --repo workspace/pyproj  # evidence-native-fallback.json/.txt
```

## Result (observed)

- No executables on PATH → both peers report **`NOT_INSTALLED`**
  (`evidence-discover-no-path.json`).
- Plan → `status: unavailable`, named `provider-absent` refusals, and a
  declared fallback `native-analysis` (`evidence-plan-absent.json`).
- Run → `status: refused`, refusal `provider-absent`, zero findings,
  **no handoff created** (`evidence-run-absent.json`) — nothing faked.
- Checkout present but unverifiable → **`DISCOVERED`, not `VERIFIED`**
  (`evidence-discover-checkout.json`): merely seeing the source tree
  does not authorize execution; only a live successful probe verifies.
- Native fallback ran fine without specialists: 11 native facts
  including `pyspark.driver_collect` (`evidence-native-fallback.*`).
