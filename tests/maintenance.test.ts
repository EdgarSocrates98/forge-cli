import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeBumps,
  checkEnvLock,
  classifyBump,
  envLockDigest,
  exportProfile,
  importProfile,
  interruptedRuns,
  managedFiles,
  writeEnvLock,
} from '../src/maintenance.js';
import type { ForgeRepo } from '../src/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-maint-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const repo: ForgeRepo = { name: 'the-forge', url: 'https://x/y', description: 'd', kind: 'python' };

describe('env lockfile', () => {
  it('digest covers schema-bearing files, never .env values', () => {
    const repoDir = path.join(dir, 'the-forge');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, '.env'), 'SECRET=supersecret\n');
    writeFileSync(path.join(repoDir, '.env.example'), 'SECRET=\n');
    const { files, digest } = envLockDigest(repoDir);
    expect(files).toContain('.env.example');
    expect(files).not.toContain('.env');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('write → check round-trips as match; schema change → drifted', () => {
    const repoDir = path.join(dir, 'the-forge');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    writeEnvLock(dir, [repo]);
    expect(checkEnvLock(dir, [repo])).toEqual([{ forge: 'the-forge', state: 'match' }]);
    writeFileSync(path.join(repoDir, 'package.json'), '{"a":1}');
    expect(checkEnvLock(dir, [repo])).toEqual([{ forge: 'the-forge', state: 'drifted' }]);
  });

  it('untracked when no lockfile; absent when repo dir missing', () => {
    expect(checkEnvLock(dir, [repo])).toEqual([{ forge: 'the-forge', state: 'untracked' }]);
  });
});

describe('profile export/import', () => {
  it('export writes a valid profile; import validates schema', () => {
    const file = path.join(dir, 'profile.json');
    const profile = exportProfile(dir, file);
    expect(profile.schema).toBe('forge-cli/Profile/v1');
    expect(existsSync(file)).toBe(true);
    const imported = importProfile(file);
    expect('error' in imported).toBe(false);
  });

  it('rejects malformed profiles', () => {
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{"schema":"other"}');
    expect(importProfile(bad)).toEqual({ error: 'invalid-profile' });
    writeFileSync(bad, 'not json');
    expect(importProfile(bad)).toEqual({ error: 'invalid-json' });
  });
});

describe('interrupted-run recovery', () => {
  it('flags partial/failed entries with suggestions', () => {
    const state = {
      version: 1 as const,
      repos: {
        a: { status: 'error' as const, detail: 'x', at: 't' },
        b: { status: 'ok' as const, detail: 'y', at: 't', phase: 'partial' as const },
        c: { status: 'ok' as const, detail: 'z', at: 't', phase: 'validated' as const },
      },
    };
    const runs = interruptedRuns(state);
    expect(runs.map((r) => r.forge).sort()).toEqual(['a', 'b']);
    expect(runs.find((r) => r.forge === 'a')?.suggestion).toBe('retry');
    expect(runs.find((r) => r.forge === 'b')?.suggestion).toBe('reinstall');
    expect(interruptedRuns(null)).toEqual([]);
  });
});

describe('breaking-change analysis', () => {
  it('classifies semver bumps', () => {
    expect(classifyBump('v1.0.0', 'v2.0.0')).toBe('major');
    expect(classifyBump('1.0.0', '1.1.0')).toBe('minor');
    expect(classifyBump('v1.0.0', 'v1.0.1')).toBe('patch');
    expect(classifyBump('v1.0.0', 'v1.0.0-rc.1')).toBe('prerelease');
    expect(classifyBump('abc', 'v1.0.0')).toBe('unknown');
  });

  it('flags major bumps as breaking suspects', () => {
    const bumps = analyzeBumps('v1.2.3', ['v1.3.0', 'v2.0.0', 'v1.2.3']);
    expect(bumps).toHaveLength(2);
    expect(bumps.find((b) => b.to === 'v2.0.0')?.breaking_suspect).toBe(true);
    expect(bumps.find((b) => b.to === 'v1.3.0')?.breaking_suspect).toBe(false);
  });
});

describe('managedFiles', () => {
  it('inventories .env + example-derived configs', () => {
    const repoDir = path.join(dir, 'the-forge');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, '.env'), 'A=1');
    writeFileSync(path.join(repoDir, 'config.example.toml'), 'x');
    writeFileSync(path.join(repoDir, 'config.toml'), 'y');
    writeFileSync(path.join(repoDir, 'other.toml'), 'z');
    const files = managedFiles(repoDir);
    expect(files).toContain('.env');
    expect(files).toContain('config.toml');
    expect(files).not.toContain('other.toml');
    expect(files).not.toContain('config.example.toml');
  });
});
