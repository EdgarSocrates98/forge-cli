import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Gate C6 — deterministic paths provably work with ZERO API keys present.
 * Every KEY/TOKEN/SECRET-style env var is stripped for the whole file:
 * discovery, recommendation, repair/doctor, prediction and context must
 * all produce evidence-carrying output anyway. AI mode must refuse
 * cleanly (disabled) — never silently require a key.
 */

const STRIP = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE)($|_)/i;
const savedEnv: Record<string, string | undefined> = {};

let work: string;

beforeAll(() => {
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIP.test(k)) {
      savedEnv[k] = v;
      delete process.env[k];
    }
  }
  work = mkdtempSync(path.join(tmpdir(), 'forge-keyless-'));
  mkdirSync(path.join(work, 'repo-a'), { recursive: true });
  writeFileSync(
    path.join(work, 'repo-a', 'forge.json'),
    JSON.stringify({
      schema: 'forge/ForgeDescriptor/v1',
      name: 'repo-a',
      version: '1.0.0',
      capabilities: { test: true },
    }),
  );
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
  rmSync(work, { recursive: true, force: true });
});

describe('Gate C6 — keyless deterministic operation', () => {
  it('asserts the environment really is keyless', () => {
    const leaked = Object.keys(process.env).filter((k) => STRIP.test(k));
    expect(leaked).toEqual([]);
  });

  it('discovery answers with evidence, no key needed', async () => {
    const { answerDiscovery } = await import('../src/intel/engine.js');
    const answers = await answerDiscovery(work, []);
    expect(answers.length).toBeGreaterThan(0);
    for (const a of answers) {
      expect(a.question).toBeTruthy();
      expect(a.answer).toBeTruthy();
      expect(['high', 'medium', 'low', 'unknown']).toContain(a.confidence);
      expect(Array.isArray(a.evidence)).toBe(true);
      expect(Array.isArray(a.explanation)).toBe(true);
      expect(Array.isArray(a.limitations)).toBe(true);
    }
  });

  it('recommendation domain answers deterministically', async () => {
    const { answerRecommendation } = await import('../src/intel/engine.js');
    const answers = await answerRecommendation(work, []);
    expect(answers.length).toBeGreaterThan(0);
  });

  it('repair domain answers deterministically', async () => {
    const { answerRepair } = await import('../src/intel/engine.js');
    const answers = await answerRepair(work, []);
    expect(answers.length).toBeGreaterThan(0);
  });

  it('prediction emits only evidence-carrying findings', async () => {
    const { predictCompatibility } = await import('../src/intel/predict.js');
    const preds = await predictCompatibility(work, []);
    for (const p of preds) {
      expect(p.evidence.length).toBeGreaterThan(0);
      expect(['high', 'medium', 'low']).toContain(p.certainty);
      expect(p.explanation).toBeTruthy();
    }
  });

  it('context builder excludes secrets and honors budget', async () => {
    const { buildForgeContext } = await import('../src/intel/context.js');
    writeFileSync(
      path.join(work, 'forge-cli.config.json'),
      JSON.stringify({ dir: '.', api_token: 'sk-live-abc123', plain: 'ok' }),
    );
    const ctx = await buildForgeContext(work, [], { maxBytes: 8192 });
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain('sk-live-abc123');
    expect(serialized.length).toBeLessThanOrEqual(8192 + 512);
    expect(ctx.schema).toBe('forge/ForgeContext/v1');
    expect(ctx.budget.bytes).toBeLessThanOrEqual(8192);
  });

  it('AI mode refuses cleanly when disabled — never needs a key', async () => {
    const { runAiBridge } = await import('../src/ai/bridge.js');
    const { buildForgeContext } = await import('../src/intel/context.js');
    const context = await buildForgeContext(work, [], {});
    const spawnFn = vi.fn();
    const result = await runAiBridge(
      { task: 'summarize-diagnosis', context },
      { enabled: false, command: [], maxContextBytes: 8192, timeoutMs: 1000, cacheTtlMs: 0 },
      { catalog: { forjas: [], hosts: [], verbs: [] }, spawnFn },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('disabled');
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
