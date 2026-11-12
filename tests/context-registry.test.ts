import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContextStates } from '../src/context-registry.js';
import { scanWorkspace } from '../src/adaptive/workspace.js';
import { mergeContextStates } from '../src/cmd/query.js';

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-ctxreg-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FixtureEntry {
  fid: string;
  /** Estado na entrada do registry (quando diverge, o manifesto vence). */
  regState?: string;
  state?: string;
  health?: string;
  reasons?: string[];
  scope?: string;
  kind?: string;
  /** Sobrescreve manifest.path (escape/missing tests). */
  manifestPath?: string;
}

function writeContext(root: string, entries: FixtureEntry[]): void {
  const dir = path.join(root, '.forge', 'context');
  mkdirSync(path.join(dir, 'capabilities'), { recursive: true });
  const forges = entries.map((e) => {
    if (e.state !== undefined || e.health !== undefined) {
      writeFileSync(
        path.join(dir, 'capabilities', `${e.fid}.json`),
        JSON.stringify({
          schema: 'forge/context/v1',
          forge_id: e.fid,
          state: e.state ?? 'available',
          ...(e.reasons ? { degraded_reasons: e.reasons } : {}),
          health: { status: e.health ?? 'healthy', checks: [] },
        }),
      );
    }
    return {
      forge_id: e.fid,
      owner: 'forge-cli',
      name: e.fid,
      version: '1.0.0',
      ...(e.kind ? { kind: e.kind } : {}),
      state: e.regState ?? e.state ?? 'available',
      scope: e.scope ?? 'workspace',
      profile: 'recommended',
      hosts: [],
      domains: [],
      manifest: {
        path: e.manifestPath ?? `capabilities/${e.fid}.json`,
        sha256: `sha256:${'0'.repeat(64)}`,
      },
      installed_by: { agent: 'test', version: '1.0.0' },
      installed_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
  });
  writeFileSync(
    path.join(dir, 'registry.json'),
    JSON.stringify({
      schema: 'forge/context-registry/v1',
      version: 1,
      workspace_root: root,
      forges,
      domains_index: {},
      updated_at: '2026-01-01T00:00:00Z',
    }),
  );
}

describe('loadContextStates — registry de contexto Forge', () => {
  it('workspace sem .forge/context → absent, nunca erro', () => {
    const res = loadContextStates(temp());
    expect(res.status).toBe('absent');
    expect(res.forges).toEqual({});
    expect(res.skipped).toBe(0);
  });

  it('projeta state/health/scope/kind do manifesto por Forja', () => {
    const root = temp();
    writeContext(root, [
      {
        fid: 'api-forge',
        state: 'degraded',
        health: 'broken',
        reasons: ['verify falhou'],
        scope: 'workspace',
        kind: 'specialist',
      },
      { fid: 'the-forge', state: 'available', health: 'healthy', kind: 'orchestrator' },
    ]);
    const res = loadContextStates(root);
    expect(res.status).toBe('ok');
    expect(res.forges['api-forge']).toMatchObject({
      state: 'degraded',
      health: 'broken',
      degradedReasons: ['verify falhou'],
      scope: 'workspace',
      kind: 'specialist',
      source: 'manifest',
    });
    expect(res.forges['the-forge']).toMatchObject({ state: 'available', health: 'healthy' });
  });

  it('manifesto divergente do registry: o manifesto (granular) vence', () => {
    const root = temp();
    writeContext(root, [{ fid: 'the-forge', regState: 'available', state: 'unavailable', health: 'unverified' }]);
    const res = loadContextStates(root);
    expect(res.forges['the-forge'].state).toBe('unavailable');
    expect(res.forges['the-forge'].health).toBe('unverified');
  });

  it('manifesto ausente → fallback honesto ao estado do registry (health=null)', () => {
    const root = temp();
    writeContext(root, [{ fid: 'the-forge', regState: 'degraded', manifestPath: 'capabilities/nope.json' }]);
    const res = loadContextStates(root);
    expect(res.forges['the-forge']).toMatchObject({
      state: 'degraded',
      health: null,
      source: 'registry',
    });
  });

  it('manifest.path com escape é recusado — nunca lê fora de .forge/context', () => {
    const root = temp();
    writeFileSync(path.join(root, 'evil.json'), JSON.stringify({ state: 'broken' }));
    writeContext(root, [{ fid: 'the-forge', regState: 'available', manifestPath: '../../evil.json' }]);
    const res = loadContextStates(root);
    expect(res.forges['the-forge'].source).toBe('registry');
    expect(res.forges['the-forge'].health).toBeNull();
  });

  it('registry inválido (JSON quebrado / schema errado) → invalid, não silêncio', () => {
    const root = temp();
    const dir = path.join(root, '.forge', 'context');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'registry.json'), '{oops');
    expect(loadContextStates(root).status).toBe('invalid');
    writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ schema: 'outro', forges: [] }));
    expect(loadContextStates(root).status).toBe('invalid');
  });

  it('entradas malformadas são puladas e contadas — parcial é honesto', () => {
    const root = temp();
    writeContext(root, [{ fid: 'the-forge', state: 'available', health: 'healthy' }]);
    const regFile = path.join(root, '.forge', 'context', 'registry.json');
    const doc = JSON.parse(readFileSync(regFile, 'utf8')) as { forges: unknown[] };
    doc.forges.push({ forge_id: 'sem-state' }, 'lixo', { forge_id: 'x', state: 'bogus' });
    writeFileSync(regFile, JSON.stringify(doc));
    const res = loadContextStates(root);
    expect(res.status).toBe('ok');
    expect(Object.keys(res.forges)).toEqual(['the-forge']);
    expect(res.skipped).toBe(3);
  });
});

describe('projeção nos consumidores', () => {
  it('scanWorkspace anexa `context` granular por projeto (aditivo)', async () => {
    const root = temp();
    mkdirSync(path.join(root, 'api-forge'), { recursive: true });
    writeFileSync(
      path.join(root, 'api-forge', 'forge.json'),
      JSON.stringify({ forge_id: 'api-forge' }),
    );
    writeContext(root, [
      { fid: 'api-forge', state: 'degraded', health: 'unverified', scope: 'workspace' },
    ]);
    const inv = await scanWorkspace(root);
    const project = inv.projects.find((p) => p.id === 'api-forge');
    expect(project?.context).toEqual({
      state: 'degraded',
      health: 'unverified',
      scope: 'workspace',
      kind: null,
    });
    // Forja fora do registry não ganha context inventado.
    mkdirSync(path.join(root, 'portal'), { recursive: true });
    writeFileSync(path.join(root, 'portal', 'package.json'), JSON.stringify({ name: 'portal' }));
    const inv2 = await scanWorkspace(root);
    expect(inv2.projects.find((p) => p.id === 'portal')?.context).toBeUndefined();
  });

  it('mergeContextStates anota linhas de status existentes sem criar linhas', () => {
    const root = temp();
    writeContext(root, [
      { fid: 'api-forge', state: 'available', health: 'healthy', scope: 'project' },
    ]);
    const infos: Parameters<typeof mergeContextStates>[0] = [
      { name: 'api-forge' },
      { name: 'the-forge' },
    ];
    mergeContextStates(infos, root);
    expect(infos[0].context).toMatchObject({ state: 'available', health: 'healthy' });
    expect(infos[1].context).toBeUndefined();
    expect(infos).toHaveLength(2);
  });
});
