import { describe, expect, it } from 'vitest';
import { resultLine } from '../src/report.js';
import type { RepoResult } from '../src/types.js';
import { S } from '../src/ui/strings.js';

const base = (over: Partial<RepoResult> = {}): RepoResult => ({
  repo: {
    name: 'demo',
    url: 'https://x/demo',
    description: 'd',
    nextSteps: ['bin install --yes', 'bin doctor'],
  },
  status: 'ok',
  detail: 'Instalado via setup.ps1',
  elapsedMs: 1500,
  ...over,
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
