import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPortablePack,
  inspectPortablePack,
  importPortablePack,
  verifyPortablePack,
} from '../src/adaptive/pack.js';
import { scanWorkspace } from '../src/adaptive/workspace.js';

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-adaptive-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WorkspaceInventory/v1', () => {
  it('reconhece projetos heterogêneos sem .git e mantém identidade explícita', async () => {
    const root = temp();
    mkdirSync(path.join(root, 'api-forge'), { recursive: true });
    writeFileSync(
      path.join(root, 'api-forge', 'forge.json'),
      JSON.stringify({ forge_id: 'api-forge' }),
    );
    writeFileSync(
      path.join(root, 'api-forge', 'pyproject.toml'),
      '[project]\nname = "api-forge"\nversion = "1.2.3"\n',
    );
    mkdirSync(path.join(root, 'portal'), { recursive: true });
    writeFileSync(
      path.join(root, 'portal', 'package.json'),
      JSON.stringify({ name: 'portal', version: '0.1.0' }),
    );
    const result = await scanWorkspace(root, { now: '2026-01-01T00:00:00.000Z' });
    expect(result.schema).toBe('forge/WorkspaceInventory/v1');
    expect(result.projects.map((project) => project.id)).toEqual(['api-forge', 'portal']);
    expect(result.projects[0]).toMatchObject({
      kind: 'python',
      state: 'READY',
      identity: { level: 'declared' },
    });
    expect(result.projects[1]).toMatchObject({ kind: 'node', identity: { level: 'derived' } });
  });

  it('marca conflito de identidade e não promove o projeto', async () => {
    const root = temp();
    mkdirSync(path.join(root, 'api-forge'), { recursive: true });
    writeFileSync(path.join(root, 'forge.json'), '{}');
    writeFileSync(
      path.join(root, 'api-forge', 'forge.json'),
      JSON.stringify({ forge_id: 'other-forge' }),
    );
    writeFileSync(
      path.join(root, 'api-forge', 'package.json'),
      JSON.stringify({ name: 'api-forge' }),
    );
    const result = await scanWorkspace(root);
    expect(result.projects[0].identity.level).toBe('conflict');
    expect(result.projects[0].state).toBe('DEGRADED');
  });
});

describe('PortableDistributionPack/v1', () => {
  it('cria, inspeciona, verifica e importa um pack autocontido', () => {
    const root = temp();
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'theforge-cli', version: '9.9.9' }),
    );
    writeFileSync(path.join(root, 'dist', 'index.js'), '#!/usr/bin/env node\nconsole.log("ok")\n');
    const archive = path.join(root, 'artifact.zip');
    const result = createPortablePack(root, archive, '2026-01-01T00:00:00.000Z');
    expect(result.manifest.schema).toBe('forge/PortableDistributionPack/v1');
    expect(inspectPortablePack(archive).files).toContain('portable-manifest.json');
    expect(verifyPortablePack(archive)).toMatchObject({ ok: true });
    const destination = path.join(root, 'imported');
    expect(importPortablePack(archive, destination).files).toContain('dist/index.js');
  });

  it('recusa corrupção antes de extrair', () => {
    const root = temp();
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'theforge-cli', version: '9.9.9' }),
    );
    writeFileSync(path.join(root, 'dist', 'index.js'), 'ok');
    const archive = path.join(root, 'artifact.zip');
    createPortablePack(root, archive);
    const bytes = Buffer.from(readFileSync(archive));
    bytes[30 + Buffer.byteLength('package.json') + 1] ^= 0xff;
    writeFileSync(archive, bytes);
    expect(verifyPortablePack(archive).ok).toBe(false);
  });
});
