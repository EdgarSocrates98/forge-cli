import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { runDoctor } from '../src/doctor.js';
import type { ForgeRepo } from '../src/types.js';
import { S } from '../src/ui/strings.js';

const mockedExeca = vi.mocked(execa);
const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-doc-'));
  tmpDirs.push(dir);
  return dir;
}

function proc(outcome: { stdout?: string } | Error) {
  const iterable = async function* () {};
  const p = outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  p.catch(() => {});
  return Object.assign(p, { iterable: () => iterable() });
}

const repo = (name: string, verify?: string[]): ForgeRepo => ({
  name,
  url: `https://x/${name}`,
  description: 'd',
  kind: 'python',
  verify,
});

function checkout(targetDir: string, name: string): void {
  mkdirSync(path.join(targetDir, name, '.git'), { recursive: true });
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runDoctor', () => {
  it('skips repos without a checkout', async () => {
    mockedExeca.mockImplementation((() => proc({ stdout: '' })) as never);
    const results = await runDoctor([repo('a', ['a', '--help'])], tmpDir());
    expect(results[0].status).toBe('skipped');
    expect(results[0].detail).toBe(S.doctorNoCheckout);
  });

  it('skips repos without a verify command', async () => {
    mockedExeca.mockImplementation((() => proc({ stdout: '' })) as never);
    const dir = tmpDir();
    checkout(dir, 'a');
    const results = await runDoctor([repo('a')], dir);
    expect(results[0].status).toBe('skipped');
    expect(results[0].detail).toBe(S.doctorNoVerify);
  });

  it('reports ok when verify exits 0', async () => {
    mockedExeca.mockImplementation((() => proc({ stdout: '' })) as never);
    const dir = tmpDir();
    checkout(dir, 'a');
    const results = await runDoctor([repo('a', ['a', '--help'])], dir);
    expect(results[0].status).toBe('ok');
  });

  it('reports fail when verify exits non-zero', async () => {
    mockedExeca.mockImplementation((() => proc(new Error('boom'))) as never);
    const dir = tmpDir();
    checkout(dir, 'a');
    const results = await runDoctor([repo('a', ['a', '--help'])], dir);
    expect(results[0].status).toBe('fail');
  });

  it('never runs setup, env or npm steps', async () => {
    mockedExeca.mockImplementation((() => proc({ stdout: '' })) as never);
    const dir = tmpDir();
    checkout(dir, 'a');
    await runDoctor([repo('a', ['a', '--help'])], dir);
    const calls = mockedExeca.mock.calls.map(([cmd]) => String(cmd));
    expect(calls).toEqual(['a']);
  });
});
