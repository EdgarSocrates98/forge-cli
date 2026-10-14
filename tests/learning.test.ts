import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  disableLearning,
  enableLearning,
  learningFile,
  learningReport,
  learningStatus,
  recordObservation,
} from '../src/intel/learning.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-learn-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = '2026-10-14T00:00:00.000Z';

describe('learning consent gate', () => {
  it('starts disabled and reports the store path', () => {
    const status = learningStatus(dir);
    expect(status.enabled).toBe(false);
    expect(status.observations).toBe(0);
    expect(status.path).toBe(learningFile(dir));
  });

  it('refuses to record while disabled — the consent gate', () => {
    expect(
      recordObservation(dir, { kind: 'op-outcome', subject: 'install', detail: 'failed' }),
    ).toEqual({ ok: false, reason: 'disabled' });
    expect(existsSync(learningFile(dir))).toBe(false);
  });

  it('records only after explicit opt-in; disabling stops recording again', () => {
    enableLearning(dir);
    expect(learningStatus(dir).enabled).toBe(true);
    expect(
      recordObservation(
        dir,
        { kind: 'op-outcome', subject: 'install', detail: 'failed' },
        { now: NOW },
      ),
    ).toEqual({ ok: true });
    expect(learningStatus(dir).observations).toBe(1);

    disableLearning(dir);
    expect(
      recordObservation(dir, { kind: 'op-outcome', subject: 'install', detail: 'again' }),
    ).toEqual({ ok: false, reason: 'disabled' });
    // Disabling stops recording but never deletes stored observations.
    expect(learningStatus(dir).observations).toBe(1);
  });
});

describe('recordObservation', () => {
  it('persists a redacted, bounded observation with the injected clock', () => {
    enableLearning(dir);
    recordObservation(
      dir,
      {
        kind: 'recurring-problem',
        subject: 'doctor',
        detail: 'saw API_TOKEN=supersecret in log',
      },
      { now: NOW },
    );
    const store = JSON.parse(readFileSync(learningFile(dir), 'utf8'));
    expect(store.observations[0]).toEqual({
      kind: 'recurring-problem',
      subject: 'doctor',
      detail: 'saw API_TOKEN=*** in log',
      at: NOW,
    });
    expect(store.enabled).toBe(true);
  });

  it('survives a malformed store file (treated as disabled+empty)', () => {
    const file = learningFile(dir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'not json');
    expect(learningStatus(dir)).toMatchObject({ enabled: false, observations: 0 });
    expect(recordObservation(dir, { kind: 'op-outcome', subject: 's', detail: 'd' })).toEqual({
      ok: false,
      reason: 'disabled',
    });
    writeFileSync(file, '{"schema":"other"}');
    expect(learningStatus(dir).enabled).toBe(false);
  });
});

describe('learningReport', () => {
  it('aggregates by kind and ranks subjects deterministically', () => {
    enableLearning(dir);
    const obs = [
      { kind: 'op-outcome' as const, subject: 'install', detail: 'a' },
      { kind: 'recurring-problem' as const, subject: 'doctor', detail: 'b' },
      { kind: 'op-outcome' as const, subject: 'install', detail: 'c' },
      { kind: 'refused-recommendation' as const, subject: 'alpha', detail: 'd' },
      { kind: 'refused-recommendation' as const, subject: 'beta', detail: 'e' },
    ];
    for (const o of obs) recordObservation(dir, o, { now: NOW });

    const before = readFileSync(learningFile(dir), 'utf8');
    const report = learningReport(dir);
    expect(report.observations).toBe(5);
    expect(report.byKind).toEqual({
      'refused-recommendation': 2,
      'op-outcome': 2,
      'recurring-problem': 1,
    });
    expect(report.topSubjects).toEqual([
      { subject: 'install', count: 2 },
      { subject: 'alpha', count: 1 },
      { subject: 'beta', count: 1 },
      { subject: 'doctor', count: 1 },
    ]);
    // Read-only: the store is byte-identical after a report.
    expect(readFileSync(learningFile(dir), 'utf8')).toBe(before);
  });

  it('reports an empty store without observations', () => {
    const report = learningReport(dir);
    expect(report.observations).toBe(0);
    expect(report.topSubjects).toEqual([]);
  });
});
