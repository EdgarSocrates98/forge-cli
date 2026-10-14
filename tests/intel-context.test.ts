import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostAdapters } from '../src/hosts/index.js';
import { FORGE_CONTEXT_SCHEMA } from '../src/intel/contracts.js';
import { buildForgeContext } from '../src/intel/context.js';
import { buildPlan } from '../src/planner.js';
import type { ForgeRepo } from '../src/types.js';
import { commandOutput, commandWorks, resolvePython } from '../src/utils/system.js';

/**
 * §6.4 — bounded structured context.
 * Hermetic (system.js mocked), injected clock, secrets provably absent.
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

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-ctx-'));
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

const base = () => ({ now: NOW, home, skipHosts: true });

describe('§6.4 — buildForgeContext', () => {
  it('assembles stack, forjas, capabilities, diagnostics and plans', async () => {
    write('pyproject.toml', '[project]\nname = "x"\n');
    write(
      'repo-a/forge.json',
      JSON.stringify({
        forge_id: 'repo-a',
        version: '1.2.3',
        capabilities: { 'mcp.serve': 'supported', deploy: false },
      }),
    );
    const live = buildPlan({ forges: [], now: new Date('2026-02-03T04:00:00Z') });
    const dead = buildPlan({
      forges: [],
      now: new Date('2026-02-03T01:00:00Z'),
      ttlMs: 60_000,
    });
    write('.forge-cli/plans/live.json', JSON.stringify(live));
    write('.forge-cli/plans/expired.json', JSON.stringify(dead));

    const ctx = await buildForgeContext(dir, [repo('repo-a')], { ...base(), maxDiagnostics: 5 });

    expect(ctx.schema).toBe(FORGE_CONTEXT_SCHEMA);
    expect(ctx.generatedAt).toBe(NOW);
    expect(ctx.stack.detected).toContain('python-app');
    expect(ctx.forjas).toEqual([{ name: 'repo-a', state: 'declared', version: '1.2.3' }]);
    expect(ctx.capabilities['repo-a.mcp.serve']).toBe('supported');
    expect(ctx.capabilities['repo-a.deploy']).toBe('false');
    expect(ctx.diagnostics.length).toBeLessThanOrEqual(5);
    for (const d of ctx.diagnostics) {
      expect(d.id.length).toBeGreaterThan(0);
      expect(['pass', 'warn', 'fail', 'skip', 'unverified']).toContain(d.result);
      expect(typeof d.severity).toBe('string');
    }
    expect(ctx.plans).toEqual([{ id: live.plan_id, kind: 'cli' }]);
    expect(ctx.budget.truncated).toBe(false);
    expect(ctx.budget.bytes).toBeLessThanOrEqual(8192);
  });

  it('keeps hosts as tri-state records, never tokens', async () => {
    const adapters = hostAdapters({
      output: async (cmd) => (cmd === 'claude' ? 'claude 1.5.0' : null),
    });
    const ctx = await buildForgeContext(dir, [], { ...base(), skipHosts: false, adapters });
    const claude = ctx.hosts.find((h) => h.id === 'claude');
    expect(claude?.state).not.toBe('absent');
    expect(['true', 'false', 'unknown']).toContain(claude?.auth);
    expect(ctx.hosts.every((h) => Object.keys(h).sort().join(',') === 'auth,id,state')).toBe(true);
  });

  it('drops denylisted keys and secret-shaped values — provably absent', async () => {
    write(
      'forge-cli.config.json',
      JSON.stringify({
        dir: '.',
        api_token: 'sk-live-abc123',
        db_password: 'hunter2',
        private_thing: 'p',
        credentials: 'x',
        // Secret-looking values under innocuous key names:
        note: 'ghp_abcdefghij0123456789abcd',
        comment: 'sk-proj-abcdef123456',
        nested: { secret: 'hidden' },
        plain: 'ok',
      }),
    );
    write('.env', 'SUPERSECRET=topsecret-value-123\n');
    write(
      'repo-a/forge.json',
      JSON.stringify({
        forge_id: 'repo-a',
        version: 'sk-live-abc123',
        capabilities: { 'leak.API_KEY': 'supported', good: 'supported' },
      }),
    );

    const ctx = await buildForgeContext(dir, [repo('repo-a')], base());
    const serialized = JSON.stringify(ctx);

    for (const secret of [
      'sk-live-abc123',
      'hunter2',
      'ghp_abcdefghij0123456789abcd',
      'sk-proj-abcdef123456',
      'topsecret-value-123',
      'hidden',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // Denylisted key names never appear as context keys either.
    for (const key of ['api_token', 'db_password', 'private_thing', 'credentials']) {
      expect(Object.keys(ctx.config)).not.toContain(key);
    }
    expect(ctx.config.plain).toBe('ok');
    // 'note'/'comment' survived the denylist but their values are secret-shaped → dropped.
    expect(ctx.config.note).toBeUndefined();
    expect(ctx.config.comment).toBeUndefined();
    // Non-scalar config values never reach the context.
    expect(ctx.config.nested).toBeUndefined();
    // Untrusted manifest version/capability keys go through the same filter.
    expect(ctx.forjas[0]?.version).toBeNull();
    expect(ctx.capabilities['repo-a.leak.API_KEY']).toBeUndefined();
    expect(ctx.capabilities['repo-a.good']).toBe('supported');
  });

  it('enforces the byte budget by dropping low-priority sections first', async () => {
    write('pyproject.toml', '[project]\nname = "x"\n');
    write(
      'repo-a/forge.json',
      JSON.stringify({ forge_id: 'repo-a', capabilities: { a: true, b: true } }),
    );
    write(
      'forge-cli.config.json',
      JSON.stringify({ plain: 'x'.repeat(400), other: 'y'.repeat(200) }),
    );

    const full = await buildForgeContext(dir, [repo('repo-a')], base());
    expect(full.budget.truncated).toBe(false);

    // Cap just below full: config (lowest priority) drops first, identity stays.
    const cap = full.budget.bytes - 40;
    const capped = await buildForgeContext(dir, [repo('repo-a')], { ...base(), maxBytes: cap });
    expect(capped.budget.truncated).toBe(true);
    expect(capped.budget.bytes).toBeLessThanOrEqual(cap);
    expect(capped.config).toEqual({});
    expect(capped.forjas.length).toBe(1);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(cap + 512);
  });

  it('empties sections down to the skeleton under a tiny cap', async () => {
    write('repo-a/forge.json', JSON.stringify({ forge_id: 'repo-a' }));
    const ctx = await buildForgeContext(dir, [repo('repo-a')], { ...base(), maxBytes: 300 });
    expect(ctx.budget.truncated).toBe(true);
    expect(ctx.budget.bytes).toBeLessThanOrEqual(300);
    expect(ctx.schema).toBe(FORGE_CONTEXT_SCHEMA);
    expect(ctx.generatedAt).toBe(NOW);
  });

  it('is deterministic — two builds deep-equal', async () => {
    write('pyproject.toml', '[project]\nname = "x"\n');
    write('repo-a/forge.json', JSON.stringify({ forge_id: 'repo-a', version: '1.0.0' }));
    const a = await buildForgeContext(dir, [repo('repo-a')], base());
    const b = await buildForgeContext(dir, [repo('repo-a')], base());
    expect(a).toEqual(b);
  });
});
