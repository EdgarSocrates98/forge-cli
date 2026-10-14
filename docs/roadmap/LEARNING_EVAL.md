# Learning — §6.7 implementation evaluation

## What was implemented

A **local, opt-in observation store** (`src/intel/learning.ts`), persisted at
`.forge-cli/learning.json` (`forge-cli/LearningStore/v1`):

| Function                       | Behavior                                                         |
| ------------------------------ | ---------------------------------------------------------------- |
| `learningStatus(targetDir)`    | `{ enabled, observations, path }` — read-only status             |
| `enableLearning(targetDir)`    | explicit opt-in; writes the store                                |
| `disableLearning(targetDir)`   | stops recording; **never deletes** stored observations           |
| `recordObservation(targetDir)` | consent gate — `{ ok: false, reason: 'disabled' }` until enabled |
| `learningReport(targetDir)`    | read-only aggregation: totals, `byKind`, ranked `topSubjects`    |

Observation kinds: `refused-recommendation`, `op-outcome`,
`recurring-problem`. Every record is `redactSecrets`-filtered, length-bounded,
timestamped with an injectable `now`, and the store is capped
(`LEARNING_MAX_OBSERVATIONS`, oldest entries drop first — deterministic FIFO).

## What was deliberately NOT implemented

**No auto-learning into policy, plans, rules, or configs.** The module exposes
no API that can mutate behavior: no recommendation re-ranking, no deny/allow
list changes, no plan shaping, no config writes outside its own store file.
Nothing in forge-cli reads the observation store except `learningReport`.

Why:

- **Silent policy drift is a security regression.** A recommendation engine
  that rewrites its own denylist or plan templates from accumulated local
  data creates an unreviewed, self-modifying attack surface — a compromised or
  confused upstream could train the CLI into unsafe defaults.
- **The C1–C5 contracts are deterministic.** Hashed plans, evidence-first
  reports and verified bundles all assume behavior is a pure function of
  declared inputs. Learned policy would break that assumption invisibly.
- **Consent is per-action, not blanket.** Opting into _recording_ must not
  silently opt the user into _being governed by_ those recordings.

The store is therefore observation → human review only: `learningReport`
surfaces recurring problems and refused recommendations so a human can decide
to change a spec, a catalog entry, or a rule — through the normal reviewed
change process, not through a feedback loop.

## What a future consent flow would require

If spec §6.7 is ever extended toward adaptive behavior, the minimum bar is:

1. **Separate consent scopes** — recording consent ≠ application consent; each
   toggled independently, both defaulting off.
2. **Explicit promotion, never absorption** — an observation becomes a
   candidate _proposal_ (like `forge/AiProposal/v1`: untrusted input) that a
   human reviews and approves into a real rule/config change, leaving a
   receipt.
3. **Deterministic, inspectable influence** — any learned input must appear in
   plan/report evidence, so `verifyPlan` and audit trails can see _why_ a
   recommendation changed.
4. **Rollback** — learned state needs the same backup/receipt discipline as
   managed files (C5), not an invisible mutation.
5. **Threat model sign-off** — poisoning resistance: a forged `.env`, log or
   repo file must not be able to teach the CLI to weaken its own checks.

Until all five exist, the observation store remains the honest scope of §6.7:
it records, it reports, it never acts.
