import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'install.windows.sh');

function hasCmd(cmd: string): boolean {
  try {
    execFileSync(cmd, ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('install.windows.sh — adapter Git Bash', () => {
  const src = readFileSync(SCRIPT, 'utf8');

  it('ships a UTF-8/LF Bash entrypoint and delegates to the shared Node installer', () => {
    expect(src.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(src).not.toContain('\r\n');
    expect(src).toContain('scripts/install_portable.mjs');
    expect(src).toContain('install.sh');
    if (process.platform !== 'win32') expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it('never invokes PowerShell and refuses a non-Bash shell', () => {
    const executable = src
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#') && !line.trimStart().startsWith('echo'))
      .join('\n')
      .toLowerCase();
    expect(executable).not.toMatch(/powershell|pwsh/);
    expect(src).toContain('FORGE-SHELL-UNAVAILABLE');
    expect(src).toContain('BASH_VERSION');
  });

  it('bash -n accepts the script', (ctx) => {
    if (!hasCmd('bash')) {
      ctx.skip();
      return;
    }
    expect(() => execFileSync('bash', ['-n', SCRIPT], { stdio: 'pipe' })).not.toThrow();
  });
});
