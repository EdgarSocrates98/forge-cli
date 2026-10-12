import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE,
  findInstallScript,
  hasGitRepo,
  resolveTargetDir,
} from '../src/utils/system.js';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveTargetDir', () => {
  it('defaults to ./forge-workspace resolved against cwd', () => {
    const cwd = path.join('some', 'base');
    expect(resolveTargetDir(undefined, cwd)).toBe(path.resolve(cwd, DEFAULT_WORKSPACE));
    expect(resolveTargetDir('', cwd)).toBe(path.resolve(cwd, DEFAULT_WORKSPACE));
    expect(resolveTargetDir('   ', cwd)).toBe(path.resolve(cwd, DEFAULT_WORKSPACE));
  });

  it('resolves relative paths against cwd', () => {
    const cwd = path.join('some', 'base');
    expect(resolveTargetDir('my-dir', cwd)).toBe(path.resolve(cwd, 'my-dir'));
  });

  it('keeps absolute paths absolute', () => {
    const abs = path.resolve('elsewhere');
    expect(resolveTargetDir(abs, 'ignored')).toBe(abs);
  });
});

describe('hasGitRepo', () => {
  it('is true only when .git exists inside the dir', () => {
    const dir = tmpDir();
    expect(hasGitRepo(dir)).toBe(false);
    mkdirSync(path.join(dir, '.git'));
    expect(hasGitRepo(dir)).toBe(true);
  });
});

describe('findInstallScript', () => {
  it('runs install.ps1 through powershell.exe on win32', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'install.ps1'), '# setup');
    const script = findInstallScript(dir, 'win32');
    expect(script).not.toBeNull();
    expect(script?.command).toBe('powershell.exe');
    expect(script?.args).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'install.ps1',
    ]);
  });

  it('ignores install.sh on win32', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'install.sh'), '# setup');
    expect(findInstallScript(dir, 'win32')).toBeNull();
  });

  it('runs install.sh via chmod +x && ./install.sh on POSIX', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'install.sh'), '# setup');
    for (const platform of ['linux', 'darwin'] as const) {
      const script = findInstallScript(dir, platform);
      expect(script).not.toBeNull();
      expect(script?.command).toBe('sh');
      expect(script?.args).toEqual(['-c', 'chmod +x install.sh && ./install.sh']);
    }
  });

  it('ignores install.ps1 on POSIX', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'install.ps1'), '# setup');
    expect(findInstallScript(dir, 'linux')).toBeNull();
  });

  it('returns null when no install script exists', () => {
    const dir = tmpDir();
    expect(findInstallScript(dir, 'win32')).toBeNull();
    expect(findInstallScript(dir, 'linux')).toBeNull();
  });
});
