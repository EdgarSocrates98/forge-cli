import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { PreflightCheck } from './types.js';
import { S } from './ui/strings.js';
import { cliHome, commandOutput, commandWorks } from './utils/system.js';

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

/** Diretório mais próximo que existe — alvo do check de writability. */
function nearestExisting(dir: string): string {
  let cur = dir;
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return dir;
    cur = parent;
  }
  return cur;
}

/**
 * Probe de ferramenta de pacotes Python: pipx → uv → `python -m pip` →
 * `pip3`/`pip`. Devolve o nome que respondeu (evidência), nunca só ok.
 */
export async function pythonToolchain(
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (await commandOutput('pipx', ['--version'])) return 'pipx';
  if (await commandOutput('uv', ['--version'])) return 'uv';
  const py = await pythonInfo(platform);
  if (py && (await commandOutput(py.exe, [...py.args, '-m', 'pip', '--version']))) {
    return 'pip';
  }
  if (await commandOutput('pip3', ['--version'])) return 'pip3';
  if (await commandOutput('pip', ['--version'])) return 'pip';
  return null;
}

/**
 * Bloco de preflight do fluxo de instalação — roda ANTES de qualquer
 * mutação. cobre: git, Node>=20, npm, python3, pip/pipx/uv, writability de
 * ~/.forge-cli, OS/arch e instalações registry existentes. Fatal bloqueia;
 * warn vira relatório compacto com dica de remediação.
 */
export async function runPreflight(
  platform: NodeJS.Platform = process.platform,
  home: string = cliHome(),
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [
    {
      name: S.preflightOsArch,
      ok: true,
      detail: `${platform} ${process.arch}`,
      severity: 'warn',
    },
    {
      name: S.preflightGit,
      ok: await commandWorks('git', ['--version']),
      detail: 'git --version',
      severity: 'fatal',
      hint: S.preflightHintGit,
    },
    {
      name: S.preflightNode,
      ok: isNodeSupported(process.version),
      detail: process.version,
      severity: 'fatal',
      hint: S.preflightHintNode,
    },
    {
      name: S.preflightNpm,
      ok: (await commandOutput('npm', ['--version'])) !== null,
      detail: 'npm --version',
      severity: 'warn',
      hint: S.preflightHintNpm,
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
      hint: S.preflightHintPwsh,
    });
  }
  const py = await pythonVersion(platform);
  checks.push({
    name: S.preflightPython,
    ok: py !== null,
    detail: py ?? S.pythonNotFound,
    severity: 'warn',
    hint: S.preflightHintPython,
  });
  const toolchain = await pythonToolchain(platform);
  checks.push({
    name: S.preflightPyTool,
    ok: toolchain !== null,
    detail: toolchain ?? 'pip/pipx/uv',
    severity: 'warn',
    hint: S.preflightHintPyTool,
  });
  // ~/.forge-cli/bin é onde os shims vão — o ancestral existente mais
  // próximo precisa aceitar escrita (sem criar nada: check é puro).
  const shimTarget = path.join(home, '.forge-cli', 'bin');
  const ancestor = nearestExisting(shimTarget);
  let writable: boolean;
  try {
    accessSync(ancestor, constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  checks.push({
    name: S.preflightPath,
    ok: writable,
    detail: ancestor,
    severity: 'warn',
    hint: S.preflightHintPath,
  });
  const forgesDir = path.join(home, '.forge-cli', 'forges');
  const installed = existsSync(forgesDir) ? readdirSync(forgesDir).length : 0;
  checks.push({
    name: S.preflightExisting,
    ok: true,
    detail: installed ? `${installed} via registry` : 'nenhuma',
    severity: 'warn',
  });
  return checks;
}
