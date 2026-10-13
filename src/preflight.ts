import type { PreflightCheck } from './types.js';
import { S } from './ui/strings.js';
import { commandOutput, commandWorks } from './utils/system.js';

const MIN_NODE_MAJOR = 20;

export function isNodeSupported(version: string): boolean {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}

export interface PythonCandidate {
  exe: string;
  args: string[];
}

const PYTHON_MINORS = [14, 13, 12, 11, 10] as const;

export function pythonCandidates(platform: NodeJS.Platform = process.platform): PythonCandidate[] {
  if (platform === 'win32') {
    return [
      ...PYTHON_MINORS.map((m) => ({ exe: 'py', args: [`-3.${m}`] })),
      { exe: 'python', args: [] },
      { exe: 'python3', args: [] },
      { exe: 'py', args: [] },
    ];
  }
  return [
    ...PYTHON_MINORS.map((m) => ({ exe: `python3.${m}`, args: [] })),
    { exe: 'python3', args: [] },
    { exe: 'python', args: [] },
  ];
}

export interface PythonInfo {
  exe: string;
  args: string[];
  version: string;
}

export async function pythonInfo(
  platform: NodeJS.Platform = process.platform,
): Promise<PythonInfo | null> {
  for (const candidate of pythonCandidates(platform)) {
    const out = await commandOutput(candidate.exe, [...candidate.args, '--version']);
    if (out) return { exe: candidate.exe, args: candidate.args, version: out };
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
