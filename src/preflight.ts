import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { discoverPythons } from './env/python.js';
import { windowsSetupShells } from './env/shells.js';
import type { PreflightCheck } from './types.js';
import { S } from './ui/strings.js';
import { cliHome, commandOutput, commandWorks, type WinSetupShells } from './utils/system.js';

const MIN_NODE_MAJOR = 20;

export function isNodeSupported(version: string): boolean {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}

export interface PythonCandidate {
  exe: string;
  args: string[];
}

/**
 * Ordem legada de sondagem por nome no PATH — documentação da ordem em
 * que nomes são tentados primeiro; a SELEÇÃO real passou a ser o pipeline
 * lf-0017 (`discoverPythons`), que estes nomes cobrem só no estágio PATH.
 */
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

/**
 * Interpretador "de referência" da máquina — seleção do pipeline lf-0017
 * (`discoverPythons().selected`), nunca mais a lista fixa acima. A saída
 * mantém o formato legado (`version` como `Python X.Y.Z`).
 */
export async function pythonInfo(
  platform: NodeJS.Platform = process.platform,
): Promise<PythonInfo | null> {
  const selected = (await discoverPythons({ platform })).selected;
  if (!selected) return null;
  return {
    exe: selected.argv[0],
    args: selected.argv.slice(1),
    version: `Python ${selected.version}`,
  };
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
 * `py` opcional = interpretador já selecionado (evita segunda descoberta).
 */
export async function pythonToolchain(
  platform: NodeJS.Platform = process.platform,
  py?: PythonInfo | null,
): Promise<string | null> {
  if (await commandOutput('pipx', ['--version'])) return 'pipx';
  if (await commandOutput('uv', ['--version'])) return 'uv';
  py ??= await pythonInfo(platform);
  if (py && (await commandOutput(py.exe, [...py.args, '-m', 'pip', '--version']))) {
    return 'pip';
  }
  if (await commandOutput('pip3', ['--version'])) return 'pip3';
  if (await commandOutput('pip', ['--version'])) return 'pip';
  return null;
}

/**
 * Bloco de preflight do fluxo de instalação — roda ANTES de qualquer
 * mutação. cobre: git, Node>=20, npm, shell de setup (win32: powershell/
 * pwsh/Git Bash verificados — lf-0016), python3, pip/pipx/uv, writability
 * de ~/.forge-cli, OS/arch e instalações registry existentes. Fatal
 * bloqueia; warn vira relatório compacto com dica de remediação.
 * `out.winShells` recebe a rota sondada (win32) para o chamador reutilizar
 * sem sondar de novo; em POSIX fica `{}`.
 */
export async function runPreflight(
  platform: NodeJS.Platform = process.platform,
  home: string = cliHome(),
  out?: { winShells?: WinSetupShells },
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
    // Rota de shell nativa (lf-0016): powershell.exe → pwsh → Git Bash
    // verificado executando. Fatal só quando NENHUMA rota existe —
    // powershell ausente com Git Bash presente não bloqueia mais.
    const winShells = await windowsSetupShells(platform);
    if (out) out.winShells = winShells;
    const route = winShells.ps ?? (winShells.bash ? `Git Bash (${winShells.bash})` : null);
    checks.push({
      name: S.preflightShellWin,
      ok: route !== null,
      detail: route ?? 'powershell.exe|pwsh|Git Bash',
      severity: 'fatal',
      hint: S.preflightHintShellWin,
    });
  }
  const py = await pythonInfo(platform);
  checks.push({
    name: S.preflightPython,
    ok: py !== null,
    detail: py?.version ?? S.pythonNotFound,
    severity: 'warn',
    hint: S.preflightHintPython,
  });
  // Reusa a seleção já sondada — toolchain não redescobre interpretador.
  const toolchain = await pythonToolchain(platform, py);
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
