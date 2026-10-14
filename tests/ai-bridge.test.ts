import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runAiBridge,
  type AiBridgeDeps,
  type AiSpawnFn,
  type AiSpawnResult,
} from '../src/ai/bridge.js';
import { AI_PROPOSAL_SCHEMA, type AiBridgeConfig, type AiRequest } from '../src/ai/types.js';
import type { ForgeContext } from '../src/intel/contracts.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-ai-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const CONTEXT: ForgeContext = {
  schema: 'forge/ForgeContext/v1',
  generatedAt: '2026-10-14T00:00:00Z',
  stack: { detected: ['node'], runtimes: { node: '20.0.0' } },
  capabilities: { 'api-forge': 'installed' },
  forjas: [{ name: 'api-forge', state: 'installed', version: '1.0.0' }],
  hosts: [{ id: 'claude-code', state: 'ok', auth: 'true' }],
  config: { region: 'us-east-1' },
  diagnostics: [{ id: 'env-check', result: 'ok', severity: 'info' }],
  plans: [],
  budget: { bytes: 128, truncated: false },
};

const REQUEST: AiRequest = { task: 'suggest-tasks', context: CONTEXT };
const CATALOG = { forjas: ['api-forge'], hosts: ['claude-code'], verbs: ['doctor'] };

const cfg = (over: Partial<AiBridgeConfig> = {}): AiBridgeConfig => ({
  enabled: true,
  command: ['fake-bridge', '--input', '{context}'],
  maxContextBytes: 65536,
  timeoutMs: 5000,
  cacheTtlMs: 0,
  ...over,
});

const proposalJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: AI_PROPOSAL_SCHEMA,
    task: 'suggest-tasks',
    summary: 'do the thing',
    items: [{ title: 't', detail: 'd', ref: 'api-forge' }],
    ...over,
  });

/** Fake spawn that records every argv — tests never start a real process. */
function fakeSpawn(
  result: AiSpawnResult | ((argv: readonly string[]) => AiSpawnResult),
  calls: string[][],
): AiSpawnFn {
  return async (argv) => {
    calls.push([...argv]);
    return typeof result === 'function' ? result(argv) : result;
  };
}

const deps = (over: Partial<AiBridgeDeps> = {}): AiBridgeDeps => ({
  catalog: CATALOG,
  rootDir: tmp,
  ...over,
});

describe('opt-in gate', () => {
  it('disabled config never spawns anything', async () => {
    const calls: string[][] = [];
    const res = await runAiBridge(
      REQUEST,
      cfg({ enabled: false }),
      deps({ spawnFn: fakeSpawn({ stdout: proposalJson(), exitCode: 0 }, calls) }),
    );
    expect(res).toEqual({ ok: false, reason: 'disabled' });
    expect(calls).toEqual([]);
  });

  it('missing command resolves to no-bridge — never hardcoded', async () => {
    const calls: string[][] = [];
    const res = await runAiBridge(
      REQUEST,
      cfg({ command: [] }),
      deps({ spawnFn: fakeSpawn({ stdout: proposalJson(), exitCode: 0 }, calls) }),
    );
    expect(res).toEqual({ ok: false, reason: 'no-bridge' });
    expect(calls).toEqual([]);
  });
});

describe('context handling', () => {
  it('refuses oversized context before spawning', async () => {
    const calls: string[][] = [];
    const res = await runAiBridge(
      REQUEST,
      cfg({ maxContextBytes: 64 }),
      deps({ spawnFn: fakeSpawn({ stdout: proposalJson(), exitCode: 0 }, calls) }),
    );
    expect(res).toEqual({ ok: false, reason: 'bridge-error', detail: 'context-too-large' });
    expect(calls).toEqual([]);
  });

  it('writes sanitized context to .forge-cli/ai/context-<digest>.json', async () => {
    const secret = `ghp_${'b'.repeat(36)}`;
    const dirty: ForgeContext = {
      ...CONTEXT,
      config: { apiToken: secret, note: `leak ${secret}`, plain: 'ok' },
    };
    const calls: string[][] = [];
    const res = await runAiBridge(
      { task: 'suggest-tasks', context: dirty },
      cfg(),
      deps({ spawnFn: fakeSpawn({ stdout: proposalJson(), exitCode: 0 }, calls) }),
    );
    expect(res.ok).toBe(true);
    const aiDir = path.join(tmp, '.forge-cli', 'ai');
    const files = readdirSync(aiDir).filter((f) => f.startsWith('context-'));
    expect(files).toHaveLength(1);
    const content = readFileSync(path.join(aiDir, files[0]!), 'utf8');
    expect(content).not.toContain(secret);
    expect(content).not.toContain('apiToken');
    expect(content).toContain('plain');
    // argv received the file path, never raw context or secret material
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(['fake-bridge', '--input']);
    expect(calls[0]![2]).toBe(path.join(aiDir, files[0]!));
    expect(calls[0]!.join(' ')).not.toContain(secret);
  });

  it('appends the context file when the command has no {context} placeholder', async () => {
    const calls: string[][] = [];
    const res = await runAiBridge(
      REQUEST,
      cfg({ command: ['bridge-bin'] }),
      deps({ spawnFn: fakeSpawn({ stdout: proposalJson(), exitCode: 0 }, calls) }),
    );
    expect(res.ok).toBe(true);
    expect(calls[0]![0]).toBe('bridge-bin');
    expect(calls[0]![1]).toMatch(/context-[a-f0-9]{64}\.json$/);
  });
});

describe('bridge invocation results', () => {
  it('returns a validated proposal on success', async () => {
    const calls: string[][] = [];
    const res = await runAiBridge(
      REQUEST,
      cfg(),
      deps({ spawnFn: fakeSpawn({ stdout: proposalJson(), exitCode: 0 }, calls) }),
    );
    expect(res).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(1);
  });

  it('maps timeouts to the timeout reason', async () => {
    const res = await runAiBridge(
      REQUEST,
      cfg({ timeoutMs: 100 }),
      deps({
        spawnFn: fakeSpawn({ stdout: '', stderr: 'killed', exitCode: 1, timedOut: true }, []),
      }),
    );
    expect(res).toEqual({ ok: false, reason: 'timeout' });
  });

  it('maps non-zero exit to bridge-error with redacted detail', async () => {
    const secret = `ghp_${'c'.repeat(36)}`;
    const res = await runAiBridge(
      REQUEST,
      cfg(),
      deps({
        spawnFn: fakeSpawn({ stdout: '', stderr: `boom ${secret}`, exitCode: 2 }, []),
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('bridge-error');
    expect(res.detail).not.toContain(secret);
  });

  it('maps spawn exceptions to bridge-error', async () => {
    const res = await runAiBridge(
      REQUEST,
      cfg(),
      deps({
        spawnFn: async () => {
          throw new Error('spawn ENOENT');
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'bridge-error' });
  });

  it('rejects garbage stdout as invalid-output', async () => {
    const res = await runAiBridge(
      REQUEST,
      cfg(),
      deps({ spawnFn: fakeSpawn({ stdout: 'sure, here is a plan!', exitCode: 0 }, []) }),
    );
    expect(res).toEqual({ ok: false, reason: 'invalid-output', detail: 'invalid-json' });
  });

  it('rejects schema violations and unknown refs deterministically', async () => {
    const calls: string[][] = [];
    const badSchema = await runAiBridge(
      REQUEST,
      cfg(),
      deps({ spawnFn: fakeSpawn({ stdout: '{"schema":"x"}', exitCode: 0 }, calls) }),
    );
    expect(badSchema).toEqual({ ok: false, reason: 'invalid-output', detail: 'bad-schema' });

    const badRef = await runAiBridge(
      REQUEST,
      cfg(),
      deps({
        spawnFn: fakeSpawn(
          {
            stdout: proposalJson({ items: [{ title: 't', detail: 'd', ref: 'forja:ghost' }] }),
            exitCode: 0,
          },
          calls,
        ),
      }),
    );
    expect(badRef).toMatchObject({ ok: false, reason: 'invalid-output' });
    if (!badRef.ok) expect(badRef.detail).toContain('unknown ref "forja:ghost"');
  });

  it('rejects proposals that still leak secret-looking content', async () => {
    const res = await runAiBridge(
      REQUEST,
      cfg(),
      deps({
        spawnFn: fakeSpawn(
          {
            stdout: proposalJson({
              items: [{ title: 't', detail: `try this token ghp_${'d'.repeat(36)}` }],
            }),
            exitCode: 0,
          },
          [],
        ),
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'invalid-output' });
    if (!res.ok) expect(res.detail).toContain('proposal-redacted-fields');
  });
});

describe('cache', () => {
  it('second identical call hits the cache without spawning', async () => {
    const calls: string[][] = [];
    const dep = deps({
      spawnFn: fakeSpawn({ stdout: proposalJson(), exitCode: 0 }, calls),
      now: () => 1_000,
    });
    const config = cfg({ cacheTtlMs: 60_000 });
    const first = await runAiBridge(REQUEST, config, dep);
    const second = await runAiBridge(REQUEST, config, dep);
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(calls).toHaveLength(1);
  });

  it('expires entries after the ttl (injected clock)', async () => {
    const calls: string[][] = [];
    let clock = 1_000;
    const dep = deps({
      spawnFn: fakeSpawn({ stdout: proposalJson(), exitCode: 0 }, calls),
      now: () => clock,
    });
    const config = cfg({ cacheTtlMs: 60_000 });
    await runAiBridge(REQUEST, config, dep);
    clock += 61_000;
    const res = await runAiBridge(REQUEST, config, dep);
    expect(res).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(2);
  });

  it('cacheTtlMs=0 disables caching entirely', async () => {
    const calls: string[][] = [];
    const dep = deps({ spawnFn: fakeSpawn({ stdout: proposalJson(), exitCode: 0 }, calls) });
    await runAiBridge(REQUEST, cfg({ cacheTtlMs: 0 }), dep);
    const res = await runAiBridge(REQUEST, cfg({ cacheTtlMs: 0 }), dep);
    expect(res).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(2);
  });

  it('stores only sanitized proposals under .forge-cli/ai/cache/', async () => {
    await runAiBridge(
      REQUEST,
      cfg({ cacheTtlMs: 60_000 }),
      deps({ spawnFn: fakeSpawn({ stdout: proposalJson(), exitCode: 0 }, []), now: () => 1 }),
    );
    const cacheDir = path.join(tmp, '.forge-cli', 'ai', 'cache');
    expect(existsSync(cacheDir)).toBe(true);
    const files = readdirSync(cacheDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  });
});

describe('never executes proposal content', () => {
  it('spawn argv contains only the configured command + context file', async () => {
    const calls: string[][] = [];
    const sentinel = 'INJECTED-SHELL-MARKER';
    const res = await runAiBridge(
      REQUEST,
      cfg(),
      deps({
        spawnFn: fakeSpawn(
          {
            stdout: proposalJson({
              items: [{ title: sentinel, detail: `run ${sentinel} now`, ref: 'api-forge' }],
            }),
            exitCode: 0,
          },
          calls,
        ),
      }),
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    for (const arg of calls[0]!) {
      expect(arg).not.toContain(sentinel);
    }
    // argv is exactly the configured command with {context} substituted
    expect(calls[0]![0]).toBe('fake-bridge');
    expect(calls[0]![1]).toBe('--input');
    expect(calls[0]![2]).toMatch(/\.forge-cli[/\\]ai[/\\]context-[a-f0-9]{64}\.json$/);
    expect(calls[0]).toHaveLength(3);
  });

  it('bridge module only spawns the resolved cfg.command argv', () => {
    const src = readFileSync(new URL('../src/ai/bridge.ts', import.meta.url), 'utf8');
    // single spawn site, fed by argv derived from cfg.command only
    const spawnCalls = src.match(/await spawn\(/g) ?? [];
    expect(spawnCalls).toHaveLength(1);
    expect(src).toContain('deps.spawnFn ?? execaSpawn');
  });
});
