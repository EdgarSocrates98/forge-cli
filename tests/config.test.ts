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

describe('loadConfig — bloco ai (§6.3 opt-in)', () => {
  it('parses all ai keys within bounds', () => {
    const dir = tmpDir();
    writeConfig(dir, {
      ai: {
        enabled: true,
        command: ['bridge', '--local'],
        maxContextBytes: 4096,
        timeoutMs: 5000,
        cacheTtlMs: 60000,
      },
    });
    expect(loadConfig(dir)).toEqual({
      config: {
        ai: {
          enabled: true,
          command: ['bridge', '--local'],
          maxContextBytes: 4096,
          timeoutMs: 5000,
          cacheTtlMs: 60000,
        },
      },
    });
  });

  it('accepts partial ai config — only valid keys kept', () => {
    const dir = tmpDir();
    writeConfig(dir, { ai: { enabled: false, unknownKnob: 'x' } });
    expect(loadConfig(dir)).toEqual({ config: { ai: { enabled: false } } });
  });

  it('drops out-of-bounds and wrong-typed ai values', () => {
    const dir = tmpDir();
    writeConfig(dir, {
      ai: {
        enabled: 'yes', // não-booleano
        command: [], // vazio
        maxContextBytes: 100, // < 512
        timeoutMs: 999999, // > 300000
        cacheTtlMs: -1, // < 0
      },
    });
    expect(loadConfig(dir)).toEqual({ config: {} });
  });

  it('boundary values accepted: 512 bytes, 1000ms, 0 ttl, ceiling values', () => {
    const dir = tmpDir();
    writeConfig(dir, {
      ai: { maxContextBytes: 512, timeoutMs: 1000, cacheTtlMs: 0 },
    });
    expect(loadConfig(dir)).toEqual({
      config: { ai: { maxContextBytes: 512, timeoutMs: 1000, cacheTtlMs: 0 } },
    });
    const dir2 = tmpDir();
    writeConfig(dir2, {
      ai: { maxContextBytes: 262144, timeoutMs: 300000, cacheTtlMs: 86400000 },
    });
    expect(loadConfig(dir2)).toEqual({
      config: { ai: { maxContextBytes: 262144, timeoutMs: 300000, cacheTtlMs: 86400000 } },
    });
  });

  it('non-integer and non-string-array command are dropped', () => {
    const dir = tmpDir();
    writeConfig(dir, {
      ai: { command: ['ok', '', 'x'], timeoutMs: 1000.5 },
    });
    expect(loadConfig(dir)).toEqual({ config: {} });
  });

  it('ai as array/scalar is ignored, not an error', () => {
    const dir = tmpDir();
    writeConfig(dir, { ai: ['not', 'object'], json: true });
    expect(loadConfig(dir)).toEqual({ config: { json: true } });
  });
});
