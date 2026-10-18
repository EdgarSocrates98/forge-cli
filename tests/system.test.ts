import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandOutput,
  commandProbe,
  commandWorks,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_WORKSPACE,
  findSetupScript,
  hasGitRepo,
  npmInstallArgs,
  probeTimeoutMs,
  resolveTargetDir,
  withCmdExt,
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

describe('findSetupScript', () => {
  it('runs setup.ps1 through powershell.exe on win32', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'setup.ps1'), '# setup');
    const script = findSetupScript(dir, 'win32');
    expect(script).not.toBeNull();
    expect(script?.file).toBe('setup.ps1');
    expect(script?.command).toBe('powershell.exe');
    expect(script?.args).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'setup.ps1',
    ]);
  });

  it('prefers setup.ps1 over install.ps1 on win32', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'setup.ps1'), '# setup');
    writeFileSync(path.join(dir, 'install.ps1'), '# install');
    expect(findSetupScript(dir, 'win32')?.file).toBe('setup.ps1');
  });

  it('falls back to install.ps1 on win32 when setup.ps1 is absent', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'install.ps1'), '# install');
    expect(findSetupScript(dir, 'win32')?.file).toBe('install.ps1');
  });

  it('ignores POSIX scripts on win32', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'setup.sh'), '# setup');
    expect(findSetupScript(dir, 'win32')).toBeNull();
  });

  it('runs setup.sh via chmod +x && ./setup.sh on POSIX', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'setup.sh'), '# setup');
    for (const platform of ['linux', 'darwin'] as const) {
      const script = findSetupScript(dir, platform);
      expect(script?.command).toBe('sh');
      expect(script?.args).toEqual(['-c', 'chmod +x setup.sh && ./setup.sh']);
    }
  });

  it('falls back to install.sh on POSIX', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'install.sh'), '# install');
    const script = findSetupScript(dir, 'linux');
    expect(script?.args).toEqual(['-c', 'chmod +x install.sh && ./install.sh']);
  });

  it('ignores PowerShell scripts on POSIX', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'setup.ps1'), '# setup');
    expect(findSetupScript(dir, 'linux')).toBeNull();
  });

  it('returns null when no setup script exists', () => {
    const dir = tmpDir();
    expect(findSetupScript(dir, 'win32')).toBeNull();
    expect(findSetupScript(dir, 'linux')).toBeNull();
  });
});

describe('npmInstallArgs', () => {
  it('returns ["ci"] when package-lock.json is present', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'package.json'), '{}');
    writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    expect(npmInstallArgs(dir)).toEqual(['ci']);
  });

  it('returns ["install"] without a lockfile', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(npmInstallArgs(dir)).toEqual(['install']);
  });

  it('returns null without package.json', () => {
    expect(npmInstallArgs(tmpDir())).toBeNull();
  });
});

describe('withCmdExt', () => {
  it('appends .cmd to npm/npx on win32 only', () => {
    expect(withCmdExt('npm', 'win32')).toBe('npm.cmd');
    expect(withCmdExt('npx', 'win32')).toBe('npx.cmd');
    expect(withCmdExt('npm', 'linux')).toBe('npm');
    expect(withCmdExt('git', 'win32')).toBe('git');
    expect(withCmdExt('powershell.exe', 'win32')).toBe('powershell.exe');
  });
});

// E2E 11.2.1: `cursor --version` era um shim Electron girando >4min —
// doctor/hosts-list travavam. Probes de ambiente têm teto: o subprocesso
// é morto, nunca um Promise.race que o deixa vivo.
describe('probes de ambiente — teto de subprocesso (E2E 11.2.1)', () => {
  const HANG = ['-e', 'setInterval(() => {}, 1e9)'];

  it('commandProbe marca timedOut e retorna dentro do teto configurável', async () => {
    const t0 = Date.now();
    const res = await commandProbe(process.execPath, HANG, { timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(res.output).toBeNull();
    // o shim é morto — jamais os >4min do E2E
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it('commandProbe distingue sem-saída (ausente/falha) de timeout', async () => {
    const missing = await commandProbe('forge-cli-binary-inexistente-9x', [], {
      timeoutMs: 5_000,
    });
    expect(missing).toEqual({ output: null, timedOut: false });
    const ok = await commandProbe(process.execPath, ['-e', 'console.log("v1")'], {
      timeoutMs: 5_000,
    });
    expect(ok).toEqual({ output: 'v1', timedOut: false });
  });

  it('commandOutput devolve null no teto — o caller nunca trava', async () => {
    expect(await commandOutput(process.execPath, HANG, { timeoutMs: 300 })).toBeNull();
  });

  it('commandWorks devolve false para o shim pendurado', async () => {
    expect(await commandWorks(process.execPath, HANG, { timeoutMs: 300 })).toBe(false);
  });

  it('probeTimeoutMs: default 15s, override por env, valores inválidos ignorados', () => {
    const prev = process.env.FORGE_CLI_PROBE_TIMEOUT_MS;
    delete process.env.FORGE_CLI_PROBE_TIMEOUT_MS;
    try {
      expect(probeTimeoutMs()).toBe(DEFAULT_PROBE_TIMEOUT_MS);
      expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(15_000);
      process.env.FORGE_CLI_PROBE_TIMEOUT_MS = '250';
      expect(probeTimeoutMs()).toBe(250);
      process.env.FORGE_CLI_PROBE_TIMEOUT_MS = 'abc';
      expect(probeTimeoutMs()).toBe(DEFAULT_PROBE_TIMEOUT_MS);
      process.env.FORGE_CLI_PROBE_TIMEOUT_MS = '0';
      expect(probeTimeoutMs()).toBe(DEFAULT_PROBE_TIMEOUT_MS);
    } finally {
      if (prev === undefined) delete process.env.FORGE_CLI_PROBE_TIMEOUT_MS;
      else process.env.FORGE_CLI_PROBE_TIMEOUT_MS = prev;
    }
  });
});
