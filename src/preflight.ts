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

export async function runPreflight(
  platform: NodeJS.Platform = process.platform,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [
    {
      name: S.preflightGit,
      ok: await commandWorks('git', ['--version']),
      detail: 'git --version',
    },
    {
      name: S.preflightNode,
      ok: isNodeSupported(process.version),
      detail: process.version,
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
    });
  }
  return checks;
}
