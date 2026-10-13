import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureEnvFile, planEnvFile, stubContent } from '../src/env.js';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-env-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('planEnvFile', () => {
  it('returns exists when .env is present, even alongside .env.example', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    writeFileSync(path.join(dir, '.env.example'), 'SECRET=');
    expect(planEnvFile(dir)).toBe('exists');
  });

  it('returns copied when only .env.example is present', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, '.env.example'), 'SECRET=');
    expect(planEnvFile(dir)).toBe('copied');
  });

  it('returns stub when no env files exist', () => {
    expect(planEnvFile(tmpDir())).toBe('stub');
  });
});

describe('ensureEnvFile', () => {
  it('never overwrites an existing .env', async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, '.env'), 'KEEP_ME=1');
    writeFileSync(path.join(dir, '.env.example'), 'OTHER=');
    expect(await ensureEnvFile(dir)).toBe('exists');
    expect(readFileSync(path.join(dir, '.env'), 'utf8')).toBe('KEEP_ME=1');
  });

  it('copies .env.example content into a new .env', async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, '.env.example'), 'API_KEY=\nDB_URL=\n');
    expect(await ensureEnvFile(dir)).toBe('copied');
    expect(readFileSync(path.join(dir, '.env'), 'utf8')).toBe('API_KEY=\nDB_URL=\n');
  });

  it('writes a commented stub when no example exists', async () => {
    const dir = tmpDir();
    expect(await ensureEnvFile(dir)).toBe('stub');
    const content = readFileSync(path.join(dir, '.env'), 'utf8');
    expect(content).toContain('forge-cli');
    expect(content.startsWith('#')).toBe(true);
  });

  it('includes commented envKeys lines when provided', async () => {
    const dir = tmpDir();
    await ensureEnvFile(dir, ['APIFORGE_HOME', 'APIFORGE_CONFIG', 'APIFORGE_CACHE']);
    const content = readFileSync(path.join(dir, '.env'), 'utf8');
    expect(content).toContain('# APIFORGE_HOME=');
    expect(content).toContain('# APIFORGE_CONFIG=');
    expect(content).toContain('# APIFORGE_CACHE=');
    expect(content).not.toContain('APIFORGE_HOME=x');
  });
});

describe('stubContent', () => {
  it('returns the bare header without envKeys', () => {
    expect(stubContent()).not.toContain('APIFORGE');
    expect(stubContent([])).not.toContain('APIFORGE');
  });

  it('keeps every key commented', () => {
    const out = stubContent(['FOO', 'BAR']);
    for (const line of out.split('\n').filter(Boolean)) {
      expect(line.startsWith('#')).toBe(true);
    }
    expect(out).toContain('# FOO=');
    expect(out).toContain('# BAR=');
  });
});
