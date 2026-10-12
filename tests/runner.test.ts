import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { processRepo } from '../src/runner.js';
import type { ForgeRepo } from '../src/types.js';
import { S } from '../src/ui/strings.js';

const mockedExeca = vi.mocked(execa);
const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-run-'));
  tmpDirs.push(dir);
  return dir;
}

function proc(outcome: { stdout?: string } | Error) {
  const iterable = async function* () {};
  const p =
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  p.catch(() => {});
  return Object.assign(p, { iterable: () => iterable() });
}

interface GitState {
  dirty?: boolean;
  pullFails?: boolean;
}

function mockExeca(state: GitState = {}) {
  mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
    const joined = args.join(' ');
    if (cmd === 'git' && joined.startsWith('clone')) {
      mkdirSync(args[2], { recursive: true });
      return proc({ stdout: '' });
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

const baseRepo: ForgeRepo = { name: 'demo', url: 'https://x/demo', description: 'demo' };

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
    const npmCall = mockedExeca.mock.calls.find(([cmd]) => /^npm/.test(String(cmd)));
    expect(npmCall?.[1]).toEqual(['ci']);
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

  it('downgrades to warning on pull failure and still runs setup', async () => {
    mockExeca({ pullFails: true });
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const result = await processRepo(baseRepo, target);
    expect(result.status).toBe('warning');
    expect(result.notes).toContain(S.warnPullFailed);
    expect(result.detail).toBe(`${S.installedVia} npm install`);
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
    expect(mockedExeca.mock.calls.some(([cmd]) => /^npm/.test(String(cmd)))).toBe(false);
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
      return proc(new Error('script boom'));
    }) as never);
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, process.platform === 'win32' ? 'setup.ps1' : 'setup.sh'), 'x');
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const result = await processRepo(baseRepo, target);
    expect(result.status).toBe('error');
    expect(result.detail).toContain(S.installFailed);
    expect(mockedExeca.mock.calls.some(([cmd]) => /^npm/.test(String(cmd)))).toBe(false);
  });
});
