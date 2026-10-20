import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { reposNeedingFix, runDoctor } from '../src/doctor.js';
import type { ForgeRepo } from '../src/types.js';
import { S } from '../src/ui/strings.js';

const mockedExeca = vi.mocked(execa);
const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-doc-'));
  tmpDirs.push(dir);
  return dir;
}

function proc(outcome: { stdout?: string; exitCode?: number } | Error) {
  const iterable = async function* () {};
  const p =
    outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve({ exitCode: 0, ...outcome });
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

  it('fails a repo whose verify passes but prereqs are unmet', async () => {
    mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
      const joined = args.join(' ');
      if (joined === '--version' && cmd === 'python') return proc({ stdout: 'Python 3.10.4' });
      return proc({ stdout: '' });
    }) as never);
    const dir = tmpDir();
    checkout(dir, 'a');
    writeFileSync(path.join(dir, 'a', 'pyproject.toml'), '[project]\nrequires-python = ">=3.12"\n');
    const results = await runDoctor([repo('a', ['a', '--help'])], dir);
    expect(results[0].status).toBe('fail');
    expect(results[0].prereqFails?.some((f) => f.includes('Python >=3.12'))).toBe(true);
  });

  it('reports ok when verify and prereqs both pass', async () => {
    mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
      const joined = args.join(' ');
      // Pipeline lf-0017: `command -v` resolve o nome antes do --version;
      // resposta vazia/outra coisa conta como `absent` (não executa).
      if (cmd === 'sh' && args[1] === 'command -v python') {
        return proc({ stdout: '/usr/bin/python' });
      }
      if (joined === '--version' && cmd === 'python') return proc({ stdout: 'Python 3.14.0' });
      return proc({ stdout: '' });
    }) as never);
    const dir = tmpDir();
    checkout(dir, 'a');
    writeFileSync(path.join(dir, 'a', 'pyproject.toml'), '[project]\nrequires-python = ">=3.10"\n');
    const results = await runDoctor([repo('a', ['a', '--help'])], dir);
    expect(results[0].status).toBe('ok');
    expect(results[0].prereqFails).toBeUndefined();
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

describe('reposNeedingFix', () => {
  it('returns only repos whose doctor status is fail', () => {
    const results = [
      { repo: repo('a', ['a']), status: 'ok' as const, detail: 'x' },
      { repo: repo('b', ['b']), status: 'fail' as const, detail: 'x' },
      { repo: repo('c', ['c']), status: 'skipped' as const, detail: 'x' },
      { repo: repo('d', ['d']), status: 'fail' as const, detail: 'x' },
    ];
    expect(reposNeedingFix(results).map((r) => r.name)).toEqual(['b', 'd']);
  });

  it('returns empty when nothing failed', () => {
    expect(reposNeedingFix([])).toEqual([]);
    expect(reposNeedingFix([{ repo: repo('a'), status: 'ok' as const, detail: 'x' }])).toEqual([]);
  });
});
