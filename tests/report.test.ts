import { describe, expect, it } from 'vitest';
import {
  formatElapsed,
  listLine,
  mergeResults,
  renderReport,
  resultLine,
  slowestRepo,
  statusBadge,
  totalElapsed,
} from '../src/report.js';
import type { RepoResult } from '../src/types.js';
import { S } from '../src/ui/strings.js';

const base = (over: Partial<RepoResult> = {}): RepoResult => ({
  repo: {
    name: 'demo',
    url: 'https://x/demo',
    description: 'd',
    kind: 'python',
    nextSteps: ['bin install --yes', 'bin doctor'],
  },
  status: 'ok',
  detail: 'Instalado via setup.ps1',
  elapsedMs: 1500,
  ...over,
});

const named = (name: string, status: RepoResult['status'], elapsedMs = 100): RepoResult =>
  base({
    repo: { name, url: `https://x/${name}`, description: 'd', kind: 'python' },
    status,
    elapsedMs,
  });

describe('resultLine', () => {
  it('appends next-steps line for ok repos with nextSteps', () => {
    const line = resultLine(base());
    expect(line).toContain(S.nextStepsTitle);
    expect(line).toContain('bin install --yes');
    expect(line).toContain('bin doctor');
  });

  it('omits next-steps when status is not ok', () => {
    const line = resultLine(base({ status: 'warning' }));
    expect(line).not.toContain(S.nextStepsTitle);
  });

  it('omits next-steps when repo has none', () => {
    const r = base();
    delete (r.repo as { nextSteps?: unknown }).nextSteps;
    expect(resultLine(r)).not.toContain(S.nextStepsTitle);
  });

  it('includes notes when present', () => {
    const line = resultLine(base({ notes: ['nota um'] }));
    expect(line).toContain('nota um');
  });
});

describe('statusBadge', () => {
  it('renders a distinct badge per status', () => {
    for (const status of ['ok', 'warning', 'error'] as const) {
      expect(statusBadge(status).length).toBeGreaterThan(0);
    }
    expect(statusBadge('ok')).toContain(S.labelOk);
    expect(statusBadge('warning')).toContain(S.labelWarn);
    expect(statusBadge('error')).toContain(S.labelErr);
  });
});

describe('formatElapsed', () => {
  it('formats milliseconds as seconds with one decimal', () => {
    expect(formatElapsed(1500)).toContain('1.5s');
    expect(formatElapsed(0)).toContain('0.0s');
  });
});

describe('renderReport', () => {
  it('renders totals and slowest repo without throwing', () => {
    expect(() => renderReport([named('a', 'ok', 900), named('b', 'error', 100)])).not.toThrow();
  });

  it('renders an empty run without throwing', () => {
    expect(() => renderReport([])).not.toThrow();
  });
});

describe('listLine', () => {
  it('shows never-run state when no state entry exists', () => {
    const line = listLine(base().repo);
    expect(line).toContain('demo');
    expect(line).toContain(S.listNever);
  });

  it('shows status badge and timestamp when a state entry exists', () => {
    const line = listLine(base().repo, {
      status: 'error',
      detail: 'boom',
      at: '2026-10-12T14:30:00.000Z',
    });
    expect(line).toContain(S.labelErr);
    expect(line).toContain('2026-10-12 14:30');
  });
});

describe('report helpers', () => {
  it('totalElapsed sums all durations', () => {
    expect(totalElapsed([named('a', 'ok', 1000), named('b', 'ok', 500)])).toBe(1500);
  });

  it('slowestRepo picks the max elapsedMs', () => {
    const results = [named('fast', 'ok', 100), named('slow', 'ok', 900), named('mid', 'ok', 400)];
    expect(slowestRepo(results)?.repo.name).toBe('slow');
    expect(slowestRepo([])).toBeUndefined();
  });

  it('mergeResults replaces by repo name and appends newcomers', () => {
    const prev = [named('a', 'error', 10), named('b', 'ok', 10)];
    const next = [named('a', 'ok', 20), named('c', 'ok', 5)];
    const merged = mergeResults(prev, next);
    expect(merged.map((r) => `${r.repo.name}:${r.status}`)).toEqual(['a:ok', 'b:ok', 'c:ok']);
  });
});
