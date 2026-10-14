import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostAdapters } from '../src/hosts/index.js';
import {
  answerDiscovery,
  answerRecommendation,
  answerRepair,
  type IntelOptions,
} from '../src/intel/engine.js';
import type { IntelAnswer } from '../src/intel/contracts.js';
import type { ForgeRepo } from '../src/types.js';
import { commandOutput, commandWorks, resolvePython } from '../src/utils/system.js';

/**
 * §6.1/§6.2 — deterministic three-domain intelligence engine.
 * system.js is mocked so every probe is hermetic; the clock is injected.
 */

vi.mock('../src/utils/system.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils/system.js')>();
  return {
    ...mod,
    commandWorks: vi.fn(async () => false),
    commandOutput: vi.fn(async () => null),
    resolvePython: vi.fn(async () => null),
  };
});

const NOW = '2026-02-03T04:05:06.000Z';

let dir: string;
let home: string;

const opts = (): IntelOptions => ({
  now: () => NOW,
  home,
  adapters: hostAdapters({ output: async () => null }),
});

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-intel-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-home-'));
  vi.mocked(commandWorks).mockResolvedValue(false);
  vi.mocked(commandOutput).mockResolvedValue(null);
  vi.mocked(resolvePython).mockResolvedValue(null);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const write = (rel: string, content: string) => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};

const repo = (name: string, kind: 'python' | 'node' = 'python'): ForgeRepo => ({
  name,
  url: `https://local.test/${name}`,
  description: name,
  kind,
});

const CONFIDENCES = ['high', 'medium', 'low', 'unknown'];

function assertAnswerShape(answers: IntelAnswer[]) {
  for (const a of answers) {
    expect(a.question.length).toBeGreaterThan(0);
    expect(a.answer.length).toBeGreaterThan(0);
    expect(CONFIDENCES).toContain(a.confidence);
    expect(Array.isArray(a.evidence)).toBe(true);
    expect(a.evidence.length).toBeGreaterThan(0);
    for (const e of a.evidence) {
      expect(e.source.length).toBeGreaterThan(0);
      expect(e.fact.length).toBeGreaterThan(0);
    }
    expect(a.explanation.length).toBeGreaterThan(0);
    expect(Array.isArray(a.limitations)).toBe(true);
  }
}

describe('§6.1 — answerDiscovery', () => {
  it('answers every discovery question with evidence', async () => {
    write('the-forge/.git/HEAD', 'ref: refs/heads/main');
    write('the-forge/forge.json', JSON.stringify({ forge_id: 'the-forge' }));
    write('package.json', JSON.stringify({ name: 'x', dependencies: { express: '*' } }));
    write('.env', 'DUMMY=1');

    const answers = await answerDiscovery(dir, [], opts());
    assertAnswerShape(answers);
    expect(answers.length).toBeGreaterThanOrEqual(4);

    const forjas = answers.find((a) => a.question.includes('estão presentes'));
    expect(forjas?.answer).toContain('the-forge');
    expect(
      forjas?.evidence.some((e) => e.source.includes('the-forge') || e.fact.includes('the-forge')),
    ).toBe(true);

    const stack = answers.find((a) => a.question.includes('stack'));
    expect(stack?.answer).toContain('node-app');
    expect(stack?.evidence.some((e) => e.fact.includes('package.json'))).toBe(true);

    const env = answers.find((a) => a.question.includes('.env'));
    expect(env?.answer).toContain('.env');
  });

  it('reports an empty workspace honestly instead of guessing', async () => {
    const answers = await answerDiscovery(dir, [], opts());
    assertAnswerShape(answers);
    const forjas = answers.find((a) => a.question.includes('estão presentes'));
    expect(forjas?.answer).toBe('nenhuma evidência local de Forja');
    expect(forjas?.confidence).toBe('medium');
    const stack = answers.find((a) => a.question.includes('stack'));
    expect(stack?.answer).toContain('nenhum sinal');
  });

  it('is deterministic — two runs deep-equal', async () => {
    write('the-forge/.git/HEAD', 'ref: refs/heads/main');
    const a = await answerDiscovery(dir, [repo('the-forge')], opts());
    const b = await answerDiscovery(dir, [repo('the-forge')], opts());
    expect(a).toEqual(b);
    const sorted = [...a].map((x) => x.question).sort();
    expect(a.map((x) => x.question)).toEqual(sorted);
  });
});

describe('§6.1 — answerRecommendation', () => {
  it('recommends from workspace signals with rule ids in explanation', async () => {
    write('requirements.txt', 'pyspark\nboto3\n');
    write('main.tf', 'resource "aws_s3_bucket" "b" {}');

    const answers = await answerRecommendation(dir, [repo('spark-forge-aws')], opts());
    assertAnswerShape(answers);

    const top = answers.find((a) => a.question.includes('recomenda instalar'));
    expect(top?.answer).toContain('spark-forge-aws');
    expect(top?.explanation.some((e) => e.startsWith('rule:spark-forge-aws'))).toBe(true);
    expect(top?.evidence.some((e) => e.fact.includes('requirements.txt'))).toBe(true);

    const prereqs = answers.find((a) => a.question.includes('pré-requisitos'));
    expect(prereqs?.answer).toContain('instalar python');
  });

  it('says "no recommendation" when no signal applies', async () => {
    const answers = await answerRecommendation(dir, [repo('spark-forge-aws')], opts());
    assertAnswerShape(answers);
    const top = answers.find((a) => a.question.includes('recomenda instalar'));
    expect(top?.answer).toContain('nenhuma recomendação');
    expect(top?.confidence).toBe('unknown');
    expect(top?.limitations.length).toBeGreaterThan(0);
  });

  it('never re-recommends a Forja already present', async () => {
    write('requirements.txt', 'pyspark\nboto3\n');
    write('main.tf', '# tf');
    write('spark-forge-aws/.git/HEAD', 'ref: refs/heads/main');
    write('spark-forge-aws/forge.json', JSON.stringify({ forge_id: 'spark-forge-aws' }));
    // state.json says installed → discovery resolves 'configured' (present state).
    write(
      '.forge-cli/state.json',
      JSON.stringify({
        version: 1,
        repos: {
          'spark-forge-aws': { status: 'ok', detail: 'installed', at: NOW, phase: 'installed' },
        },
      }),
    );

    const answers = await answerRecommendation(dir, [repo('spark-forge-aws')], opts());
    const top = answers.find((a) => a.question.includes('recomenda instalar'));
    expect(top?.answer).not.toContain('spark-forge-aws (');
    const present = answers.find((a) => a.question.includes('já estão presentes'));
    expect(present?.answer).toContain('spark-forge-aws');
  });

  it('is deterministic — two runs deep-equal', async () => {
    write('requirements.txt', 'pyspark\nboto3\n');
    const a = await answerRecommendation(dir, [repo('spark-forge-aws')], opts());
    const b = await answerRecommendation(dir, [repo('spark-forge-aws')], opts());
    expect(a).toEqual(b);
  });
});

describe('§6.1 — answerRepair', () => {
  it('maps doctor2 findings to classified repair risk', async () => {
    // repo-a declared but absent on disk → doctor records a finding.
    const answers = await answerRepair(dir, [repo('repo-a')], opts());
    assertAnswerShape(answers);

    const findings = answers.find((a) => a.question.includes('quebrado'));
    expect(findings).toBeTruthy();
    expect(findings?.evidence.some((e) => e.source === 'doctor2/report')).toBe(true);

    const plan = answers.find((a) => a.question.includes('reparado'));
    expect(plan?.explanation).toContain('heal/classifyFindings');
    expect(plan?.explanation).toContain('heal/risk-classes');
  });

  it('reports the health score with its model', async () => {
    const answers = await answerRepair(dir, [], opts());
    const score = answers.find((a) => a.question.includes('score'));
    expect(score).toBeTruthy();
    expect(score?.evidence.some((e) => e.source === 'score:sufficiency')).toBe(true);
    if (score?.confidence === 'high') expect(score.answer).toMatch(/\d+\/100/);
    else expect(score?.confidence).toBe('unknown');
  });

  it('is deterministic — two runs deep-equal', async () => {
    const a = await answerRepair(dir, [repo('repo-a')], opts());
    const b = await answerRepair(dir, [repo('repo-a')], opts());
    expect(a).toEqual(b);
  });
});
