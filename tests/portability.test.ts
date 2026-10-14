import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLE_FILES,
  exportBundle,
  importBundle,
  planReinstall,
  SecretKeysRefusedError,
} from '../src/portability/bundle.js';
import { buildIntegrityManifest, verifyIntegrityManifest } from '../src/portability/manifest.js';
import { verifyPlan } from '../src/planner.js';
import type { ForgeRepo } from '../src/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-port-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = '2026-10-14T00:00:00.000Z';
const alpha: ForgeRepo = {
  name: 'alpha-forge',
  url: 'https://x/alpha',
  description: 'd',
  kind: 'node',
};
const beta: ForgeRepo = {
  name: 'beta-forge',
  url: 'https://x/beta',
  description: 'd',
  kind: 'python',
};

function seedTarget(): void {
  const repoDir = path.join(dir, alpha.name);
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(
    path.join(repoDir, 'forge.json'),
    JSON.stringify({ forge_id: 'alpha-forge', version: '1.2.3' }),
  );
  writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(path.join(repoDir, '.env.example'), 'API_TOKEN=\nLOG_LEVEL=\n');
  writeFileSync(path.join(repoDir, '.env'), 'API_TOKEN=supersecret\nLOG_LEVEL=debug\n');
  mkdirSync(path.join(dir, '.forge-cli'), { recursive: true });
  writeFileSync(
    path.join(dir, '.forge-cli', 'state.json'),
    JSON.stringify({
      version: 1,
      repos: { 'alpha-forge': { status: 'ok', detail: 'd', at: NOW, head: 'abc123' } },
      pins: { 'alpha-forge': 'v1.2.3' },
    }),
  );
}

function bundleText(bundleDir: string): string {
  return readdirSync(bundleDir)
    .map((f) => readFileSync(path.join(bundleDir, f), 'utf8'))
    .join('\n');
}

describe('buildIntegrityManifest', () => {
  it('sorts entries, hashes each payload, and stamps an injectable generatedAt', () => {
    const m = buildIntegrityManifest(
      [
        { path: 'b.json', content: 'bb' },
        { path: 'a.json', content: 'aa' },
      ],
      { now: NOW },
    );
    expect(m.schema).toBe('forge/IntegrityManifest/v1');
    expect(m.generatedAt).toBe(NOW);
    expect(m.entries.map((e) => e.path)).toEqual(['a.json', 'b.json']);
    expect(m.entries[0].sha256).toBe(createHash('sha256').update('aa').digest('hex'));
    expect(m.entries[0].bytes).toBe(2);
    expect(m.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts byte payloads and is deterministic for the same inputs', () => {
    const inputs = [{ path: 'x.bin', bytes: new Uint8Array([1, 2, 3]) }];
    const a = buildIntegrityManifest(inputs, { now: NOW });
    const b = buildIntegrityManifest(inputs, { now: NOW });
    expect(a).toEqual(b);
  });
});

describe('verifyIntegrityManifest', () => {
  const manifest = buildIntegrityManifest([{ path: 'a.json', content: 'aa' }], { now: NOW });

  it('returns ok when every entry matches', () => {
    expect(verifyIntegrityManifest(manifest, () => 'aa')).toEqual({ ok: true });
  });

  it('reports missing files instead of throwing', () => {
    const r = verifyIntegrityManifest(manifest, () => null);
    expect(r).toEqual({ ok: false, mismatches: ['a.json'] });
  });

  it('reports tampered content', () => {
    const r = verifyIntegrityManifest(manifest, () => 'tampered');
    expect(r).toEqual({ ok: false, mismatches: ['a.json'] });
  });

  it('reports a tampered digest and refuses unsafe entry paths without reading them', () => {
    const bad = {
      ...manifest,
      digest: '0'.repeat(64),
      entries: [...manifest.entries, { path: '../evil', bytes: 0, sha256: 'x' }],
    };
    const r = verifyIntegrityManifest(bad, (p) => {
      if (p === '../evil') throw new Error('must not be called for unsafe paths');
      return 'aa';
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.mismatches).toContain('../evil');
      expect(r.mismatches).toContain('<digest>');
    }
  });

  it('reports a malformed manifest', () => {
    expect(verifyIntegrityManifest(null, () => null)).toEqual({
      ok: false,
      mismatches: ['<manifest>'],
    });
  });
});

describe('bundle export/import', () => {
  it('round-trips: export → import → verify ok', async () => {
    seedTarget();
    const dest = path.join(dir, 'bundle');
    const res = await exportBundle(dir, [alpha, beta], dest, { now: NOW });
    expect(res.ok).toBe(true);
    for (const f of res.files) expect(existsSync(path.join(dest, f))).toBe(true);

    const imported = importBundle(dest);
    expect(imported.verify).toEqual({ ok: true });
    expect(imported.profile?.schema).toBe('forge-cli/Profile/v1');
    expect(imported.profile?.repos['alpha-forge']?.head).toBe('abc123');
    expect(imported.lockfile?.schema).toBe('forge-cli/EnvLock/v1');
    expect(imported.lockCheck).toContainEqual({ forge: 'alpha-forge', state: 'match' });
    expect(imported.lockCheck).toContainEqual({ forge: 'beta-forge', state: 'untracked' });
    const alphaPin = imported.pins.find((p) => p.name === 'alpha-forge');
    expect(alphaPin).toMatchObject({ url: alpha.url, version: '1.2.3', ref: 'v1.2.3' });
  });

  it('is deterministic: two exports with the same clock produce identical bytes', async () => {
    seedTarget();
    const a = path.join(dir, 'b1');
    const b = path.join(dir, 'b2');
    const ra = await exportBundle(dir, [alpha], a, { now: NOW });
    const rb = await exportBundle(dir, [alpha], b, { now: NOW });
    expect(ra.files).toEqual(rb.files);
    expect(ra.manifest.digest).toBe(rb.manifest.digest);
    for (const f of ra.files) {
      expect(readFileSync(path.join(a, f), 'utf8')).toBe(readFileSync(path.join(b, f), 'utf8'));
    }
  });

  it('never exports env values by default; schema keys travel as names only', async () => {
    seedTarget();
    const dest = path.join(dir, 'bundle');
    await exportBundle(dir, [alpha], dest, { now: NOW });
    const imported = importBundle(dest);
    expect(imported.envKeys['alpha-forge']).toEqual(['API_TOKEN', 'LOG_LEVEL']);
    expect(existsSync(path.join(dest, BUNDLE_FILES.envValues))).toBe(false);
    expect(bundleText(dest)).not.toContain('supersecret');
    expect(bundleText(dest)).not.toContain('LOG_LEVEL=debug');
  });

  it('refuses whitelisted keys that match the secret denylist — typed error', async () => {
    seedTarget();
    await expect(
      exportBundle(dir, [alpha], path.join(dir, 'bundle'), {
        now: NOW,
        includeEnvKeys: ['LOG_LEVEL', 'API_TOKEN'],
      }),
    ).rejects.toThrowError(SecretKeysRefusedError);
    await expect(
      exportBundle(dir, [alpha], path.join(dir, 'bundle'), {
        now: NOW,
        includeEnvKeys: ['SSH_PRIVATE_KEY_PATH'],
      }),
    ).rejects.toMatchObject({ code: 'secret-keys-refused' });
  });

  it('refuses keys the derived schema marks secret even with a harmless name', async () => {
    const repoDir = path.join(dir, alpha.name);
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      path.join(repoDir, 'forge.env.schema.json'),
      JSON.stringify({ vars: [{ key: 'INNOCUOUS', secret: true }] }),
    );
    await expect(
      exportBundle(dir, [alpha], path.join(dir, 'bundle'), {
        now: NOW,
        includeEnvKeys: ['INNOCUOUS'],
      }),
    ).rejects.toThrowError(SecretKeysRefusedError);
  });

  it('carries whitelisted non-secret values when explicitly allowed', async () => {
    seedTarget();
    const dest = path.join(dir, 'bundle');
    await exportBundle(dir, [alpha], dest, { now: NOW, includeEnvKeys: ['LOG_LEVEL'] });
    const imported = importBundle(dest);
    expect(imported.verify).toEqual({ ok: true });
    expect(imported.envValues).toEqual({ 'alpha-forge': { LOG_LEVEL: 'debug' } });
    expect(bundleText(dest)).not.toContain('supersecret');
  });

  it('detects tampering after export', async () => {
    seedTarget();
    const dest = path.join(dir, 'bundle');
    await exportBundle(dir, [alpha], dest, { now: NOW });
    writeFileSync(path.join(dest, BUNDLE_FILES.pins), '[]');
    const imported = importBundle(dest);
    expect(imported.verify.ok).toBe(false);
    if (!imported.verify.ok) {
      expect(imported.verify.mismatches).toContain(BUNDLE_FILES.pins);
    }
  });

  it('skips verification when asked (forensics) and survives hostile bundles', async () => {
    seedTarget();
    const dest = path.join(dir, 'bundle');
    await exportBundle(dir, [alpha], dest, { now: NOW });
    writeFileSync(path.join(dest, BUNDLE_FILES.integrity), 'not json');
    const imported = importBundle(dest, { verifyIntegrity: false });
    expect(imported.verify).toEqual({ ok: true });
    expect(imported.manifest).toBeNull();
    expect(importBundle(path.join(dir, 'missing')).verify.ok).toBe(false);
  });
});

describe('planReinstall', () => {
  it('maps pins to a deterministic hashed reinstall plan', async () => {
    seedTarget();
    const dest = path.join(dir, 'bundle');
    await exportBundle(dir, [alpha, beta], dest, { now: NOW });
    const imported = importBundle(dest);
    const now = new Date(NOW);
    const plan = planReinstall(imported, { now });
    const again = planReinstall(imported, { now });
    expect(plan).toEqual(again);
    expect(plan.schema).toBe('forge/ForgeOperationPlan/v1');
    expect(verifyPlan(plan, new Date(NOW))).toEqual({ ok: true });
    const alphaPlan = plan.forges.find((f) => f.forge_id === 'alpha-forge');
    expect(alphaPlan?.actions.map((a) => a.kind)).toEqual(['clone', 'sync', 'env']);
    expect(alphaPlan?.actions[1].argv).toContain('v1.2.3');
    const betaPlan = plan.forges.find((f) => f.forge_id === 'beta-forge');
    expect(betaPlan?.actions.map((a) => a.kind)).toEqual(['clone']);
  });
});
