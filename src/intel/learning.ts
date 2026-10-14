import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { artifactsRoot } from '../artifacts.js';
import { redactSecrets, writeFileAtomic } from '../safety.js';

// ---------------------------------------------------------------------------
// §6.7 — local, opt-in observation store.
//
// This module records what the operator chose to keep: refused
// recommendations, operation outcomes, recurring problems. That is ALL it
// does — observations are never read back into plans, security policy,
// deny/allow lists or configs. There is deliberately no API here that could
// mutate behavior (see docs/roadmap/LEARNING_EVAL.md). Recording is a consent
// gate: `recordObservation` refuses while learning is disabled.
// ---------------------------------------------------------------------------

export const LEARNING_SCHEMA = 'forge-cli/LearningStore/v1' as const;
export const LEARNING_MAX_OBSERVATIONS = 1000;
const MAX_SUBJECT = 120;
const MAX_DETAIL = 400;

export type ObservationKind = 'refused-recommendation' | 'op-outcome' | 'recurring-problem';

export interface Observation {
  readonly kind: ObservationKind;
  readonly subject: string;
  readonly detail: string;
  readonly at: string;
}

interface LearningStore {
  schema: typeof LEARNING_SCHEMA;
  enabled: boolean;
  observations: Observation[];
}

export interface LearningStatus {
  readonly enabled: boolean;
  readonly observations: number;
  readonly path: string;
}

export type RecordResult = { ok: true } | { ok: false; reason: 'disabled' };

export interface LearningReport {
  readonly observations: number;
  readonly byKind: Record<ObservationKind, number>;
  readonly topSubjects: readonly { subject: string; count: number }[];
}

export function learningFile(targetDir: string): string {
  return path.join(artifactsRoot(targetDir), 'learning.json');
}

function readStore(targetDir: string): LearningStore {
  const file = learningFile(targetDir);
  if (!existsSync(file)) return { schema: LEARNING_SCHEMA, enabled: false, observations: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as LearningStore;
    if (parsed?.schema !== LEARNING_SCHEMA || !Array.isArray(parsed.observations)) {
      return { schema: LEARNING_SCHEMA, enabled: false, observations: [] };
    }
    return {
      schema: LEARNING_SCHEMA,
      enabled: parsed.enabled === true,
      observations: parsed.observations.filter(
        (o): o is Observation =>
          o !== null &&
          typeof o === 'object' &&
          typeof o.kind === 'string' &&
          typeof o.subject === 'string' &&
          typeof o.detail === 'string' &&
          typeof o.at === 'string',
      ),
    };
  } catch {
    return { schema: LEARNING_SCHEMA, enabled: false, observations: [] };
  }
}

function writeStore(targetDir: string, store: LearningStore): void {
  const file = learningFile(targetDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(store, null, 2));
}

export function learningStatus(targetDir: string): LearningStatus {
  const store = readStore(targetDir);
  return {
    enabled: store.enabled,
    observations: store.observations.length,
    path: learningFile(targetDir),
  };
}

export function enableLearning(targetDir: string): LearningStatus {
  const store = readStore(targetDir);
  writeStore(targetDir, { ...store, enabled: true });
  return learningStatus(targetDir);
}

/** Disabling stops recording but never deletes stored observations. */
export function disableLearning(targetDir: string): LearningStatus {
  const store = readStore(targetDir);
  writeStore(targetDir, { ...store, enabled: false });
  return learningStatus(targetDir);
}

/**
 * Consent gate: refuses to record while learning is disabled. Subject and
 * detail are redacted and bounded before they ever reach the store; the
 * store itself is capped (oldest entries drop first — deterministic FIFO).
 */
export function recordObservation(
  targetDir: string,
  obs: { kind: ObservationKind; subject: string; detail: string },
  opts?: { now?: string },
): RecordResult {
  const store = readStore(targetDir);
  if (!store.enabled) return { ok: false, reason: 'disabled' };
  const observation: Observation = {
    kind: obs.kind,
    subject: redactSecrets(obs.subject).slice(0, MAX_SUBJECT),
    detail: redactSecrets(obs.detail).slice(0, MAX_DETAIL),
    at: opts?.now ?? new Date().toISOString(),
  };
  const observations = [...store.observations, observation].slice(-LEARNING_MAX_OBSERVATIONS);
  writeStore(targetDir, { ...store, observations });
  return { ok: true };
}

/** Read-only aggregation — no write path, no feedback into policy or plans. */
export function learningReport(targetDir: string): LearningReport {
  const store = readStore(targetDir);
  const byKind: Record<ObservationKind, number> = {
    'refused-recommendation': 0,
    'op-outcome': 0,
    'recurring-problem': 0,
  };
  const subjects = new Map<string, number>();
  for (const o of store.observations) {
    if (o.kind in byKind) byKind[o.kind]++;
    subjects.set(o.subject, (subjects.get(o.subject) ?? 0) + 1);
  }
  const topSubjects = [...subjects.entries()]
    .map(([subject, count]) => ({ subject, count }))
    .sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject))
    .slice(0, 10);
  return { observations: store.observations.length, byKind, topSubjects };
}
