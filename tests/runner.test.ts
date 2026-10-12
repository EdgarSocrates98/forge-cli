import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { processPool, processRepo } from '../src/runner.js';
import type { ForgeRepo } from '../src/types.js';
import { S } from '../src/ui/strings.js';

const mockedExeca = vi.mocked(execa);
const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-run-'));
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

interface GitState {
  dirty?: boolean;
  pullFails?: boolean;
  head?: string;
}

function mockExeca(state: GitState = {}) {
  mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
    const joined = args.join(' ');
    if (cmd === 'git' && joined.startsWith('clone')) {
      mkdirSync(args[args.length - 1], { recursive: true });
      return proc({ stdout: '' });
    }
    if (cmd === 'git' && args[0] === '-C' && joined.includes('rev-parse')) {
      return proc({ stdout: state.head ?? 'sha-1' });
    }
    if (cmd === 'git' && joined.startsWith('status')) {
      return proc({ stdout: state.dirty ? ' M dirty.ts' : '' });
    }
    if (cmd === 'git' && joined.startsWith('pull')) {
      return state.pullFails ? proc(new Error('pull boom')) : proc({ stdout: '' });
    }
    if (cmd === 'verify-bad') return proc(new Error('verify boom'));
    return proc({ stdout: '' });
  }) as never);
}

const baseRepo: ForgeRepo = {
  name: 'demo',
  url: 'https://x/demo',
  description: 'demo',
  kind: 'node',
};

function existingGitRepo(targetDir: string): string {
  const repoDir = path.join(targetDir, baseRepo.name);
  mkdirSync(path.join(repoDir, '.git'), { recursive: true });
  return repoDir;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('processRepo', () => {
  it('clones missing repos and warns when no setup step exists', async () => {
    mockExeca();
    const target = tmpDir();
    const result = await processRepo(baseRepo, target);
    expect(result.status).toBe('warning');
    expect(result.detail).toBe(S.noSetupSteps);
    expect(result.envNote).toBe(S.envStub);
  });

  it('warns and skips an existing non-git directory', async () => {
    mockExeca();
    const target = tmpDir();
    mkdirSync(path.join(target, baseRepo.name));
    const result = await processRepo(baseRepo, target);
    expect(result.status).toBe('warning');
    expect(result.detail).toBe(S.nonGitDir);
  });

  it('runs npm ci when package-lock.json is present and reports ok', async () => {
    mockExeca();
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    writeFileSync(path.join(repoDir, 'package-lock.json'), '{}');
    const result = await processRepo(baseRepo, target);
    expect(result.status).toBe('ok');
    expect(result.detail).toBe(`${S.installedVia} npm ci`);
    const npmCall = mockedExeca.mock.calls.find(
      ([cmd, args]) => /^npm/.test(String(cmd)) && (args as string[])[0] === 'ci',
    );
    expect(npmCall).toBeDefined();
  });

  it('runs npm install when no lockfile exists', async () => {
    mockExeca();
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const result = await processRepo(baseRepo, target);
    expect(result.status).toBe('ok');
    expect(result.detail).toBe(`${S.installedVia} npm install`);
  });

  it('notes a dirty tree and continues setup', async () => {
    mockExeca({ dirty: true });
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const result = await processRepo(baseRepo, target);
    expect(result.notes).toContain(S.warnDirtyTree);
    expect(result.status).toBe('ok');
  });

  it('does not run setup scripts after a pull failure by default', async () => {
    mockExeca({ pullFails: true });
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const result = await processRepo(baseRepo, target);
    expect(result.status).toBe('warning');
    expect(result.notes).toContain(S.warnPullFailed);
    expect(result.notes).toContain(S.warnScriptsSkippedSync);
    expect(result.detail).toBe(S.noSetupSteps);
  });

  it('runs setup after a pull failure with runAfterSyncFailure', async () => {
    mockExeca({ pullFails: true });
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const result = await processRepo(baseRepo, target, {}, { runAfterSyncFailure: true });
    expect(result.status).toBe('warning');
    expect(result.detail).toBe(`${S.installedVia} npm install`);
  });

  it('skips scripts of custom repos unless trustCustom', async () => {
    mockExeca();
    const target = tmpDir();
    const repo: ForgeRepo = { ...baseRepo, origin: 'custom' };
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const blocked = await processRepo(repo, target);
    expect(blocked.notes).toContain(S.warnScriptsSkippedUntrusted);
    expect(blocked.detail).toBe(S.noSetupSteps);
    const trusted = await processRepo(repo, target, {}, { trustCustom: true });
    expect(trusted.detail).toBe(`${S.installedVia} npm install`);
  });

  it('cloneOnly stops after sync without env, scripts or npm', async () => {
    mockExeca();
    const target = tmpDir();
    const result = await processRepo(baseRepo, target, {}, { cloneOnly: true });
    expect(result.status).toBe('ok');
    expect(result.detail).toBe(S.clonedOnly);
    const ran = mockedExeca.mock.calls.map(([cmd]) => cmd);
    expect(ran).not.toContain('npm');
    expect(existsSync(path.join(target, 'demo', '.env'))).toBe(false);
  });

  it('copies config examples and notes them', async () => {
    mockExeca();
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'config.example.yaml'), 'a: 1\n');
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const result = await processRepo(baseRepo, target);
    expect(result.status).toBe('ok');
    expect(result.notes).toContain(`${S.configCopied}: config.yaml`);
  });

  it('fails fast on unmet prereqs and skips setup/npm/verify', async () => {
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'pyproject.toml'), '[project]\nrequires-python = ">=3.12"\n');
    writeFileSync(path.join(repoDir, 'setup.ps1'), '# never run');
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    writeFileSync(path.join(repoDir, 'package-lock.json'), '{}');
    mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
      const joined = args.join(' ');
      if (cmd === 'git' && joined.startsWith('status')) return proc({ stdout: '' });
      if (cmd === 'git' && joined.startsWith('pull')) return proc({ stdout: '' });
      if (joined === '--version' && cmd === 'python') return proc({ stdout: 'Python 3.10.4' });
      if (joined === '-m pip --version') return proc({ stdout: 'pip 25.0' });
      return proc({ stdout: '' });
    }) as never);
    const result = await processRepo(baseRepo, target);
    expect(result.status).toBe('error');
    expect(result.detail).toContain('Python >=3.12');
    expect(result.notes?.some((n) => n.includes('Python >=3.12'))).toBe(true);
    const invoked = mockedExeca.mock.calls.map(
      ([cmd, args]) => `${String(cmd)} ${(args as string[]).join(' ')}`,
    );
    expect(invoked.some((c) => c.includes('powershell'))).toBe(false);
    expect(invoked.some((c) => c === 'npm ci' || c === 'npm install')).toBe(false);
  });

  it('passes prereqs and runs setup when requirements are met', async () => {
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'pyproject.toml'), '[project]\nrequires-python = ">=3.10"\n');
    mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
      const joined = args.join(' ');
      if (cmd === 'git' && joined.startsWith('status')) return proc({ stdout: '' });
      if (cmd === 'git' && joined.startsWith('pull')) return proc({ stdout: '' });
      if (joined === '--version' && cmd === 'python') return proc({ stdout: 'Python 3.14.0' });
      return proc({ stdout: '' });
    }) as never);
    const result = await processRepo(baseRepo, target);
    expect(result.status).not.toBe('error');
  });

  it('marks verify failure as a soft warning, never an error', async () => {
    mockExeca();
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const repo: ForgeRepo = { ...baseRepo, verify: ['verify-bad', '--help'] };
    const result = await processRepo(repo, target);
    expect(result.status).toBe('warning');
    expect(result.notes?.join(' ')).toContain(S.verifyFailed);
  });

  it('records verify success as a note', async () => {
    mockExeca();
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const repo: ForgeRepo = { ...baseRepo, verify: ['node', '--version'] };
    const result = await processRepo(repo, target);
    expect(result.status).toBe('ok');
    expect(result.notes?.join(' ')).toContain(S.verifyOk);
  });

  it('runs the detected setup script and reports it in the detail', async () => {
    mockExeca();
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    const file = process.platform === 'win32' ? 'setup.ps1' : 'setup.sh';
    writeFileSync(path.join(repoDir, file), '# setup');
    const result = await processRepo(baseRepo, target);
    expect(result.status).toBe('ok');
    expect(result.detail).toBe(`${S.installedVia} ${file}`);
  });

  it('skips script and npm steps with --skip-scripts', async () => {
    mockExeca();
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    writeFileSync(path.join(repoDir, 'package-lock.json'), '{}');
    const result = await processRepo(baseRepo, target, {}, { skipScripts: true });
    const npmRuns = mockedExeca.mock.calls.filter(
      ([cmd, args]) => /^npm/.test(String(cmd)) && (args as string[])[0] !== '--version',
    );
    expect(npmRuns).toHaveLength(0);
    expect(result.status).toBe('warning');
    expect(result.detail).toBe(S.noSetupSteps);
  });

  it('skips verify with --skip-verify', async () => {
    mockExeca();
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const repo: ForgeRepo = { ...baseRepo, verify: ['verify-ok', '--help'] };
    const result = await processRepo(repo, target, {}, { skipVerify: true });
    expect(result.status).toBe('ok');
    expect(mockedExeca.mock.calls.some(([cmd]) => cmd === 'verify-ok')).toBe(false);
    expect(result.notes?.join(' ') ?? '').not.toContain(S.verifyOk);
  });

  it('returns error and skips npm when the setup script fails', async () => {
    mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
      const joined = args.join(' ');
      if (cmd === 'git') {
        if (joined.startsWith('status')) return proc({ stdout: '' });
        return proc({ stdout: '' });
      }
      if (cmd === 'npm' && joined === '--version') return proc({ stdout: '12.0.2' });
      return proc(new Error('script boom'));
    }) as never);
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, process.platform === 'win32' ? 'setup.ps1' : 'setup.sh'), 'x');
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const result = await processRepo(baseRepo, target);
    expect(result.status).toBe('error');
    expect(result.detail).toContain(S.installFailed);
    const npmRuns = mockedExeca.mock.calls.filter(
      ([cmd, args]) => /^npm/.test(String(cmd)) && (args as string[])[0] !== '--version',
    );
    expect(npmRuns).toHaveLength(0);
  });
});

describe('--shallow clones', () => {
  it('passes --depth 1 to fresh clones only', async () => {
    mockExeca();
    const target = tmpDir();
    await processRepo(baseRepo, target, {}, { shallow: true });
    const clone = mockedExeca.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && (args as string[])[0] === 'clone',
    );
    expect(clone?.[1]).toEqual(['clone', '--depth', '1', '--', baseRepo.url, expect.any(String)]);
  });

  it('clones without --depth when shallow is off', async () => {
    mockExeca();
    const target = tmpDir();
    await processRepo(baseRepo, target);
    const clone = mockedExeca.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && (args as string[])[0] === 'clone',
    );
    expect(clone?.[1]).toEqual(['clone', '--', baseRepo.url, expect.any(String)]);
  });
});

describe('--only-changed', () => {
  const stateWith = (name: string, head: string) => ({
    [name]: { status: 'ok' as const, detail: 'x', at: '2026-01-01T00:00:00.000Z', head },
  });

  it('skips repos whose HEAD matches the last ok run', async () => {
    mockExeca({ head: 'sha-abc' });
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const result = await processRepo(
      baseRepo,
      target,
      {},
      {
        onlyChanged: true,
        state: stateWith(baseRepo.name, 'sha-abc'),
      },
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toBe(S.unchanged);
    const npmRuns = mockedExeca.mock.calls.filter(([cmd]) => /^npm/.test(String(cmd)));
    expect(npmRuns).toHaveLength(0);
  });

  it('reruns when HEAD moved since the last ok run', async () => {
    mockExeca({ head: 'sha-new' });
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const result = await processRepo(
      baseRepo,
      target,
      {},
      {
        onlyChanged: true,
        state: stateWith(baseRepo.name, 'sha-old'),
      },
    );
    expect(result.detail).toBe(`${S.installedVia} npm install`);
  });

  it('reruns when prior state is missing or not ok', async () => {
    mockExeca({ head: 'sha-abc' });
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const noPrior = await processRepo(
      baseRepo,
      target,
      {},
      {
        onlyChanged: true,
        state: {},
      },
    );
    expect(noPrior.detail).toBe(`${S.installedVia} npm install`);
    const failed = await processRepo(
      baseRepo,
      target,
      {},
      {
        onlyChanged: true,
        state: {
          [baseRepo.name]: { status: 'error' as const, detail: 'x', at: 'a', head: 'sha-abc' },
        },
      },
    );
    expect(failed.detail).toBe(`${S.installedVia} npm install`);
  });

  it('records head on the result for state persistence', async () => {
    mockExeca({ head: 'sha-xyz' });
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const result = await processRepo(baseRepo, target);
    expect(result.head).toBe('sha-xyz');
  });
});

describe('processPool', () => {
  const named = (name: string): ForgeRepo => ({ ...baseRepo, name, url: `https://x/${name}` });

  it('keeps results in catalog order and isolates failures', async () => {
    mockExeca();
    const target = tmpDir();
    for (const name of ['a', 'b', 'c']) {
      const dir = path.join(target, name);
      mkdirSync(path.join(dir, '.git'), { recursive: true });
      writeFileSync(path.join(dir, 'package.json'), '{}');
    }
    // b becomes non-git → warning; others install fine.
    rmSync(path.join(target, 'b', '.git'), { recursive: true, force: true });
    const finished: string[] = [];
    const results = await processPool(
      [named('a'), named('b'), named('c')],
      target,
      {},
      2,
      () => ({}),
      (r) => finished.push(r.repo.name),
    );
    expect(results.map((r) => r.repo.name)).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.status)).toEqual(['ok', 'warning', 'ok']);
    expect(finished.sort()).toEqual(['a', 'b', 'c']);
  });

  it('handles more jobs than repos and empty input', async () => {
    mockExeca();
    const target = tmpDir();
    const results = await processPool([named('solo')], target, {}, 8, () => ({}));
    expect(results).toHaveLength(1);
    expect(await processPool([], target, {}, 4, () => ({}))).toEqual([]);
  });
});
