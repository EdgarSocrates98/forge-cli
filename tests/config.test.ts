import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-cfg2-'));
  tmpDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, content: unknown): void {
  writeFileSync(
    path.join(dir, 'forge-cli.config.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadConfig', () => {
  it('returns null when no config file exists', () => {
    expect(loadConfig(tmpDir())).toBeNull();
  });

  it('parses all known keys', () => {
    const dir = tmpDir();
    writeConfig(dir, {
      dir: './ws',
      only: ['a', 'b'],
      timeout: 300,
      json: true,
      shallow: true,
      jobs: 4,
    });
    const result = loadConfig(dir);
    expect(result).toEqual({
      config: {
        dir: './ws',
        only: ['a', 'b'],
        timeout: 300,
        json: true,
        shallow: true,
        jobs: 4,
      },
    });
  });

  it('returns error for invalid JSON and non-objects', () => {
    const dir = tmpDir();
    writeConfig(dir, '{oops');
    expect(loadConfig(dir)).toEqual({ error: 'invalid-json' });
    writeConfig(dir, '[1,2]');
    expect(loadConfig(dir)).toEqual({ error: 'not-an-object' });
  });

  it('drops keys with wrong types and tolerates unknown keys', () => {
    const dir = tmpDir();
    writeConfig(dir, {
      only: 'not-an-array',
      timeout: 'abc',
      jobs: 99,
      json: 'yes',
      future: 'key',
    });
    const result = loadConfig(dir);
    expect(result).toEqual({ config: {} });
  });

  it('floors timeout and rejects non-positive values', () => {
    const dir = tmpDir();
    writeConfig(dir, { timeout: 12.9 });
    expect(loadConfig(dir)).toEqual({ config: { timeout: 12 } });
    writeConfig(dir, { timeout: -5 });
    expect(loadConfig(dir)).toEqual({ config: {} });
  });
});
