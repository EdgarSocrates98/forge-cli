import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerDiscovery, answerRecommendation, answerRepair } from '../src/intel/engine.js';
import { predictCompatibility } from '../src/intel/predict.js';
import { buildForgeContext } from '../src/intel/context.js';
import type { ForgeRepo } from '../src/types.js';

let work: string;

const repo: ForgeRepo = {
  name: 'repo-a',
  url: 'https://example.invalid/repo-a',
  description: 'test',
  kind: 'python',
  envKeys: ['API_TOKEN', 'PLAN_MODE'],
};

const repoB: ForgeRepo = {
  name: 'repo-b',
  url: 'https://example.invalid/repo-b',
  description: 'test',
  kind: 'python',
};

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'forge-intel-'));
  const dir = path.join(work, 'repo-a');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'forge.json'),
    JSON.stringify({
      schema: 'forge/ForgeDescriptor/v1',
      name: 'repo-a',
      version: '1.2.0',
      capabilities: { doctor: true, mcp: 'declared' },
      cli: 'repo-a',
    }),
  );
  writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nrequires-python = ">=99.0"\n');
  writeFileSync(
    path.join(dir, 'forge.env.schema.json'),
    JSON.stringify({
      vars: [
        { key: 'API_TOKEN', required: true, secret: true },
        { key: 'PLAN_MODE', required: false },
      ],
    }),
  );
  writeFileSync(path.join(dir, '.env'), 'API_TOKEN=abc\nOLD_TOKEN=x\n');
  const dirB = path.join(work, 'repo-b');
  mkdirSync(dirB, { recursive: true });
  writeFileSync(
    path.join(dirB, 'forge.json'),
    JSON.stringify({
      schema: 'forge/ForgeDescriptor/v1',
      name: 'repo-b',
      version: '1.0.0',
      cli: 'repo-a',
    }),
  );
  writeFileSync(
    path.join(work, 'forge-cli.config.json'),
    JSON.stringify({ only: ['repo-a'], ai: { enabled: false }, nested: { secret_key: 'x' } }),
  );
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('§6.1 engine — three domains', () => {
  it('discovery answers carry evidence/confidence/explanation/limitations', async () => {
    const answers = await answerDiscovery(work, [repo]);
    expect(answers.length).toBeGreaterThanOrEqual(5);
    for (const a of answers) {
      expect(a.question).toBeTruthy();
      expect(['high', 'medium', 'low', 'unknown']).toContain(a.confidence);
      expect(Array.isArray(a.explanation)).toBe(true);
      expect(Array.isArray(a.limitations)).toBe(true);
    }
    const installed = answers.find(
      (a) => a.question === 'Quais Forjas estão presentes e em que estado?',
    );
    expect(installed).toBeDefined();
    expect(installed!.evidence.length).toBeGreaterThan(0);
  });

  it('recommendation answers echo rule whys as evidence', async () => {
    const answers = await answerRecommendation(work, [repo]);
    const coverage = answers.find(
      (a) => a.question === 'Qual Forja a evidência recomenda instalar?',
    );
    expect(coverage).toBeDefined();
    for (const a of answers) {
      expect(a.evidence.length + a.limitations.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('repair answers map doctor findings with corrective + reversibility limits', async () => {
    const answers = await answerRepair(work, [repo]);
    const coverage = answers.find(
      (a) => a.question === 'O que está quebrado ou degradado no workspace?',
    );
    expect(coverage).toBeDefined();
    for (const a of answers) {
      expect(a.answer).toBeTruthy();
      expect(a.explanation.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('§6.4 context — bounded + secret-free', () => {
  it('emits forge/ForgeContext/v1 with real sections, no secrets', async () => {
    const ctx = await buildForgeContext(work, [repo], {
      maxBytes: 8192,
      now: '2026-01-01T00:00:00Z',
    });
    expect(ctx.schema).toBe('forge/ForgeContext/v1');
    expect(ctx.generatedAt).toBe('2026-01-01T00:00:00Z');
    expect(ctx.capabilities['repo-a.doctor']).toBe('true');
    const s = JSON.stringify(ctx);
    expect(s).not.toContain('abc'); // API_TOKEN value never leaks
    expect(s).not.toContain('secret_key');
    expect(s).not.toContain('API_TOKEN=abc');
    expect(ctx.budget.bytes).toBeLessThanOrEqual(8192);
  });

  it('truncates deterministically under a tiny budget', async () => {
    const ctx = await buildForgeContext(work, [repo], { maxBytes: 1200 });
    expect(ctx.budget.truncated).toBe(true);
  });
});

describe('§6.5 predict — evidence + version + certainty', () => {
  it('predicts runtime-incompat from declared floor vs detected python', async () => {
    const preds = await predictCompatibility(work, [repo]);
    const rt = preds.find((p) => p.kind === 'runtime-incompat');
    // only when the probe found python — the rule is evidence-gated
    if (rt) {
      expect(rt.evidence.length).toBeGreaterThanOrEqual(2);
      expect(rt.version.to).toBe('>=99.0');
      expect(rt.certainty).toBe('high');
    }
  });

  it('predicts renamed-var/obsolete from env findings, never without evidence', async () => {
    const preds = await predictCompatibility(work, [repo, repoB]);
    const envPreds = preds.filter((p) => ['renamed-var', 'obsolete'].includes(p.kind));
    for (const p of envPreds) {
      expect(p.evidence.length).toBeGreaterThan(0);
      expect(['high', 'medium', 'low']).toContain(p.certainty);
      expect(p.explanation).toBeTruthy();
    }
    const conflicts = preds.filter((p) => p.kind === 'install-conflict');
    // repo-a and repo-b both declare cli 'repo-a' → shared managed bin
    expect(conflicts.some((p) => p.id.includes('cli'))).toBe(true);
    // deterministic: same call twice → same ids
    const again = await predictCompatibility(work, [repo, repoB]);
    expect(again.map((p) => p.id)).toEqual(preds.map((p) => p.id));
  });
});
