import type { PreflightCheck } from './types.js';
import { S } from './ui/strings.js';
import { commandOutput, commandWorks } from './utils/system.js';

const MIN_NODE_MAJOR = 20;

export function isNodeSupported(version: string): boolean {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}

export interface PythonInfo {
  exe: string;
  version: string;
}

export async function pythonInfo(
  platform: NodeJS.Platform = process.platform,
): Promise<PythonInfo | null> {
  const candidates =
    platform === 'win32'
      ? (['python', 'python3', 'py'] as const)
      : (['python3', 'python'] as const);
  for (const exe of candidates) {
    const out = await commandOutput(exe, ['--version']);
    if (out) return { exe, version: out };
  }
  return null;
}

export async function pythonVersion(
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  return (await pythonInfo(platform))?.version ?? null;
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
