import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyConfigExamples } from '../src/configs.js';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-cfg-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('copyConfigExamples', () => {
  it('copies config.example.yaml to config.yaml', async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'config.example.yaml'), 'key: value\n');
    expect(await copyConfigExamples(dir)).toEqual(['config.yaml']);
    expect(readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toBe('key: value\n');
  });

  it('never overwrites an existing target', async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'config.example.yaml'), 'from: example\n');
    writeFileSync(path.join(dir, 'config.yaml'), 'mine: true\n');
    expect(await copyConfigExamples(dir)).toEqual([]);
    expect(readFileSync(path.join(dir, 'config.yaml'), 'utf8')).toBe('mine: true\n');
  });

  it('ignores .env.example — owned by the env step', async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, '.env.example'), 'A=1\n');
    expect(await copyConfigExamples(dir)).toEqual([]);
  });

  it('ignores regular files and directories', async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'README.md'), '# x');
    mkdirSync(path.join(dir, 'examples'));
    writeFileSync(path.join(dir, 'examples', 'demo.example.yaml'), 'a: b\n');
    expect(await copyConfigExamples(dir)).toEqual([]);
  });

  it('copies multiple example configs', async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'config.example.yaml'), 'a: 1\n');
    writeFileSync(path.join(dir, 'db.example.json'), '{}\n');
    const copied = await copyConfigExamples(dir);
    expect(copied.sort()).toEqual(['config.yaml', 'db.json']);
  });
});
