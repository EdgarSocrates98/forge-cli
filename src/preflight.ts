import { execa } from 'execa';
import type { PreflightCheck } from './types.js';
import { S } from './ui/strings.js';

const MIN_NODE_MAJOR = 20;

export function isNodeSupported(version: string): boolean {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}

async function commandWorks(command: string, args: string[]): Promise<boolean> {
  try {
    const result = await execa(command, args, { reject: false });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function commandOutput(command: string, args: string[]): Promise<string | null> {
  try {
    const result = await execa(command, args, { reject: false });
    if (result.exitCode !== 0) return null;
    return (result.stdout || result.stderr || '').trim() || 'ok';
  } catch {
    return null;
  }
}

export async function pythonVersion(
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const candidates =
    platform === 'win32'
      ? (['python', 'python3', 'py'] as const)
      : (['python3', 'python'] as const);
  for (const cmd of candidates) {
    const out = await commandOutput(cmd, ['--version']);
    if (out) return out;
  }
  return null;
}

export async function runPreflight(
  platform: NodeJS.Platform = process.platform,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [
    {
      name: S.preflightGit,
      ok: await commandWorks('git', ['--version']),
      detail: 'git --version',
      severity: 'fatal',
    },
    {
      name: S.preflightNode,
      ok: isNodeSupported(process.version),
      detail: process.version,
      severity: 'fatal',
    },
  ];
  if (platform === 'win32') {
    checks.push({
      name: S.preflightPwsh,
      ok: await commandWorks('powershell.exe', [
        '-NoProfile',
        '-Command',
        '$PSVersionTable.PSVersion | Out-Null',
      ]),
      detail: 'powershell.exe',
      severity: 'fatal',
    });
  }
  const py = await pythonVersion(platform);
  checks.push({
    name: S.preflightPython,
    ok: py !== null,
    detail: py ?? S.pythonNotFound,
    severity: 'warn',
  });
  return checks;
}
