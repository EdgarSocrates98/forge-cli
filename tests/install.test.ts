import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import {
  addToWindowsPath,
  fishBlock,
  GUARD_END,
  GUARD_START,
  guardBlock,
  install,
  installDir,
  pathStatus,
  posixShim,
  removeFromWindowsPath,
  uninstall,
  windowsShim,
} from '../src/install.js';

const mockedExeca = vi.mocked(execa);
const tmpDirs: string[] = [];
let userPath = '';

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-inst-'));
  tmpDirs.push(dir);
  return dir;
}

function mockPsPath() {
  mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
    const script = args.join(' ');
    if (cmd === 'powershell.exe' && script.includes('GetEnvironmentVariable')) {
      return Promise.resolve({ exitCode: 0, stdout: userPath });
    }
    if (cmd === 'powershell.exe' && script.includes('SetEnvironmentVariable')) {
      const match = /SetEnvironmentVariable\('Path','(.*)','User'\)/.exec(script);
      userPath = match?.[1].replace(/''/g, "'") ?? userPath;
      return Promise.resolve({ exitCode: 0, stdout: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '' });
  }) as never);
}

const base = (dir: string, platform: NodeJS.Platform = 'linux') => ({
  homedir: dir,
  platform,
  bundlePath: path.join(dir, 'src-bundle.js'),
});

function writeBundle(dir: string): void {
  writeFileSync(path.join(dir, 'src-bundle.js'), '// bundle', 'utf8');
}

afterEach(() => {
  vi.clearAllMocks();
  userPath = '';
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('shims and blocks', () => {
  it('windows shim calls node on the bundle', () => {
    expect(windowsShim()).toContain('node');
    expect(windowsShim()).toContain('.forge-cli');
  });

  it('posix shim execs node from $HOME', () => {
    expect(posixShim()).toContain('#!/bin/sh');
    expect(posixShim()).toContain('exec node "$HOME/.forge-cli/bin/index.mjs"');
  });

  it('blocks carry guard markers and PATH export', () => {
    expect(guardBlock()).toContain(GUARD_START);
    expect(guardBlock()).toContain(GUARD_END);
    expect(guardBlock()).toContain('export PATH=');
    expect(fishBlock()).toContain('set -gx PATH');
  });
});

describe('install (posix)', () => {
  it('copies bundle, writes executable shim, appends guarded block to profiles', async () => {
    const home = tmpDir();
    writeBundle(home);
    writeFileSync(path.join(home, '.bashrc'), '# my bashrc\n');
    const report = await install(base(home));
    expect(existsSync(path.join(report.dir, 'index.mjs'))).toBe(true);
    expect(existsSync(path.join(report.dir, 'forge-cli'))).toBe(true);
    const bashrc = readFileSync(path.join(home, '.bashrc'), 'utf8');
    expect(bashrc).toContain(GUARD_START);
    expect(bashrc).toContain('$HOME/.forge-cli/bin');
    expect(report.profilesTouched).toContain(path.join(home, '.bashrc'));
  });

  it('is idempotent — second install touches nothing', async () => {
    const home = tmpDir();
    writeBundle(home);
    writeFileSync(path.join(home, '.zshrc'), '# zsh\n');
    await install(base(home));
    const again = await install(base(home));
    expect(again.profilesTouched).toHaveLength(0);
    const zshrc = readFileSync(path.join(home, '.zshrc'), 'utf8');
    expect(zshrc.split(GUARD_START).length - 1).toBe(1);
  });

  it('creates ~/.profile when no profile exists', async () => {
    const home = tmpDir();
    writeBundle(home);
    const report = await install(base(home));
    const profile = path.join(home, '.profile');
    expect(existsSync(profile)).toBe(true);
    expect(readFileSync(profile, 'utf8')).toContain(GUARD_START);
    expect(report.profilesTouched).toContain(profile);
  });

  it('uses fish syntax inside fish config', async () => {
    const home = tmpDir();
    writeBundle(home);
    const fishDir = path.join(home, '.config', 'fish');
    mkdirSync(fishDir, { recursive: true });
    const fishFile = path.join(fishDir, 'config.fish');
    writeFileSync(fishFile, '# fish\n');
    await install(base(home));
    expect(readFileSync(fishFile, 'utf8')).toContain('set -gx PATH');
  });
});

describe('uninstall (posix)', () => {
  it('removes dir and strips guarded blocks, leaving other content', async () => {
    const home = tmpDir();
    writeBundle(home);
    const bashrc = path.join(home, '.bashrc');
    writeFileSync(bashrc, 'export EDITOR=vim\n');
    await install(base(home));
    const report = await uninstall(base(home));
    expect(report.dirRemoved).toBe(true);
    expect(existsSync(installDir(home))).toBe(false);
    const content = readFileSync(bashrc, 'utf8');
    expect(content).not.toContain(GUARD_START);
    expect(content).toContain('export EDITOR=vim');
  });

  it('is idempotent on repeat runs and clean profiles', async () => {
    const home = tmpDir();
    writeBundle(home);
    const report = await uninstall(base(home));
    expect(report.dirRemoved).toBe(false);
    expect(report.profilesTouched).toHaveLength(0);
  });
});

describe('windows PATH', () => {
  it('adds and removes the install dir on the user PATH', async () => {
    mockPsPath();
    const dir = 'C:\\Users\\x\\.forge-cli\\bin';
    expect(await addToWindowsPath(dir)).toBe(true);
    expect(userPath).toContain(dir);
    await addToWindowsPath(dir);
    expect(userPath.split(dir).length - 1).toBe(1);
    expect(await removeFromWindowsPath(dir)).toBe(true);
    expect(userPath).not.toContain(dir);
    expect(userPath).not.toContain(';;');
  });

  it('preserves existing PATH entries when adding/removing', async () => {
    mockPsPath();
    userPath = 'C:\\Windows;C:\\tools\\git\\bin';
    const dir = 'C:\\Users\\x\\.forge-cli\\bin';
    await addToWindowsPath(dir);
    expect(userPath).toContain('C:\\Windows');
    expect(userPath).toContain('C:\\tools\\git\\bin');
    await removeFromWindowsPath(dir);
    expect(userPath).toBe('C:\\Windows;C:\\tools\\git\\bin');
  });

  it('matches dirs case-insensitively and ignores trailing slashes', async () => {
    mockPsPath();
    userPath = 'C:\\USERS\\X\\.FORGE-CLI\\BIN\\';
    expect(await addToWindowsPath('c:\\users\\x\\.forge-cli\\bin')).toBe(true);
    expect(userPath).toBe('C:\\USERS\\X\\.FORGE-CLI\\BIN\\');
  });
});

describe('install (windows)', () => {
  it('writes forge-cli.cmd and registers the dir on PATH', async () => {
    mockPsPath();
    const home = tmpDir();
    writeBundle(home);
    const report = await install(base(home, 'win32'));
    const cmd = path.join(report.dir, 'forge-cli.cmd');
    expect(existsSync(cmd)).toBe(true);
    expect(readFileSync(cmd, 'utf8')).toContain('node');
    expect(userPath).toContain(installDir(home));
    expect(report.pathAlready).toBe(false);
  });
});

describe('pathStatus', () => {
  it('reports on-path when the resolver succeeds', async () => {
    mockedExeca.mockImplementation((() => Promise.resolve({ exitCode: 0, stdout: 'x' })) as never);
    expect(await pathStatus({ platform: 'linux' })).toBe('on-path');
    expect(await pathStatus({ platform: 'win32' })).toBe('on-path');
  });

  it('reports missing on nonzero exit or throw', async () => {
    mockedExeca.mockImplementation((() => Promise.resolve({ exitCode: 1, stdout: '' })) as never);
    expect(await pathStatus({ platform: 'linux' })).toBe('missing');
    mockedExeca.mockImplementation((() => Promise.reject(new Error('no sh'))) as never);
    expect(await pathStatus({ platform: 'linux' })).toBe('missing');
  });
});
