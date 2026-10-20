/**
 * Descoberta de shells — `forge/EnvironmentDiscovery/v1` (ciclo 12.1, lf-0016).
 *
 * Responde "o que esta máquina consegue EXECUTAR", nunca "o que existe no
 * disco": presença sem execução não é capacidade (powershell.exe pode estar
 * bloqueado por política; bash.exe do System32 é stub do WSL, não Git Bash).
 * Sete shells, sempre na mesma ordem, cada uma com evidência em `probes`:
 *
 *   powershell | pwsh | bash | git_bash | wsl | cygwin | msys2
 *
 * Toda sonda é inofensiva (`--version`, `command -v`, `where.exe`, variáveis
 * de ambiente, existsSync) e tem timeout ≤ `SHELL_PROBE_TIMEOUT_MS` (5 s) —
 * sonda que expira é INCONCLUSIVA, nunca prova de ausência. Distinções
 * duras do contrato:
 *
 *   - WSL NUNCA substitui shell nativo de Windows (reportado, jamais rota);
 *   - Cygwin e MSYS2 são capacidades próprias, não colapsam em Git Bash;
 *   - Git Bash só conta quando um bash.exe do Git for Windows EXECUTA
 *     (`-lc 'echo ok'`), com o executável resolvido registrado.
 *
 * Determinístico e offline: mesma máquina + mesmas respostas das sondas →
 * mesma descoberta. `run`/`exists`/`env` são injetáveis para teste — nada
 * spawna PowerShell de verdade no CI Linux.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ForgeErrorCode } from '../errors.js';
import { commandProbe } from '../utils/system.js';

/** Teto de toda sonda de shell — spec: timeout em toda sonda, ≤ 5 s. */
export const SHELL_PROBE_TIMEOUT_MS = 5_000;

/** Resultado de UMA sonda — registrado em `probes` como evidência auditável. */
export interface ShellProbeResult {
  /** Comando exato executado (ou `exists <path>`/`env:<VAR>` para provas fs/env). */
  command: string;
  ok: boolean;
  output: string | null;
  /** true = processo morto por timeout — INCONCLUSIVO, não prova ausência. */
  timed_out: boolean;
}

/** Estado descoberto de uma shell — `present` exige execução verificada. */
export interface ShellStatus {
  present: boolean;
  version: string | null;
  /** Executável resolvido (path completo quando conhecido, senão o nome). */
  executable: string | null;
  /** Origem distinta do nome — 'git-bash'|'wsl-bash'|'msys2'|'cygwin'|'native'|'inside-wsl'. */
  kind: string | null;
  /** Evidência por sonda, chaves em ordem fixa de emissão. */
  probes: Record<string, ShellProbeResult>;
}

export interface ShellDiscovery {
  powershell: ShellStatus;
  pwsh: ShellStatus;
  bash: ShellStatus;
  git_bash: ShellStatus;
  wsl: ShellStatus;
  cygwin: ShellStatus;
  msys2: ShellStatus;
}

/** Saída mínima de uma sonda — a chave do mapa carrega o nome da sonda. */
export interface ProbeOutcome {
  ok: boolean;
  output: string | null;
  timed_out: boolean;
}

/** Runner injetável — implementação real usa execa com timeout ≤ 5 s. */
export type ProbeRun = (command: string, args: string[]) => Promise<ProbeOutcome>;

export interface ShellDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: ProbeRun;
  exists?: (target: string) => boolean;
}

interface ResolvedShellDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run: ProbeRun;
  exists: (target: string) => boolean;
}

const defaultRun: ProbeRun = async (command, args) => {
  const probe = await commandProbe(command, args, { timeoutMs: SHELL_PROBE_TIMEOUT_MS });
  return {
    ok: !probe.timedOut && probe.output !== null,
    output: probe.output,
    timed_out: probe.timedOut,
  };
};

function resolveDeps(deps: ShellDeps): ResolvedShellDeps {
  return {
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    run: deps.run ?? defaultRun,
    exists: deps.exists ?? existsSync,
  };
}

function firstLine(output: string | null): string | null {
  const line = output?.split(/\r?\n/, 1)[0]?.trim();
  return line ? line : null;
}

function absent(probes: Record<string, ShellProbeResult> = {}): ShellStatus {
  return { present: false, version: null, executable: null, kind: null, probes };
}

function probeResult(command: string, args: string[], outcome: ProbeOutcome): ShellProbeResult {
  return { command: [command, ...args].join(' '), ...outcome };
}

function fsProbe(command: string, ok: boolean, output: string | null = null): ShellProbeResult {
  return { command, ok, output, timed_out: false };
}

/** powershell.exe (Windows PowerShell 5.1) ou pwsh (PowerShell 7+) — separados. */
async function probePowerShell(d: ResolvedShellDeps, core: boolean): Promise<ShellStatus> {
  const command = core ? 'pwsh' : d.platform === 'win32' ? 'powershell.exe' : 'powershell';
  const args = ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'];
  const probes: Record<string, ShellProbeResult> = {};
  const version = await d.run(command, args);
  probes.version = probeResult(command, args, version);
  if (d.platform === 'win32') {
    // Evidência de arquivo: exe no disco + sonda falha → "unavailable"
    // (bloqueio de política), não "not found".
    const file = core ? pwshProgramFile(d.env) : powershellSystemFile(d.env);
    if (file) probes.file = fsProbe(`exists ${file}`, d.exists(file), file);
  }
  return {
    present: version.ok,
    version: version.ok ? firstLine(version.output) : null,
    executable: version.ok ? command : null,
    kind: null,
    probes,
  };
}

function powershellSystemFile(env: NodeJS.ProcessEnv): string | null {
  const root = env.SYSTEMROOT ?? env.SystemRoot ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function pwshProgramFile(env: NodeJS.ProcessEnv): string | null {
  const pf = env.PROGRAMFILES ?? env.ProgramFiles ?? 'C:\\Program Files';
  return path.join(pf, 'PowerShell', '7', 'pwsh.exe');
}

/**
 * bash genérico — no win32 o path resolvido decide a origem: System32 é o
 * stub do WSL ('wsl-bash'), `\Git\` é Git for Windows, msys/cygwin têm os
 * próprios rótulos. POSIX resolve via `sh -c 'command -v bash'`.
 */
async function probeBash(d: ResolvedShellDeps): Promise<ShellStatus> {
  const probes: Record<string, ShellProbeResult> = {};
  const version = await d.run('bash', ['--version']);
  probes.version = probeResult('bash', ['--version'], version);
  let resolvedPath: string | null = null;
  if (version.ok) {
    const whichArgs =
      d.platform === 'win32'
        ? { cmd: 'where.exe', args: ['bash'] }
        : { cmd: 'sh', args: ['-c', 'command -v bash'] };
    const which = await d.run(whichArgs.cmd, whichArgs.args);
    probes.which = probeResult(whichArgs.cmd, whichArgs.args, which);
    resolvedPath = which.ok ? firstLine(which.output) : null;
  }
  return {
    present: version.ok,
    version: version.ok ? firstLine(version.output) : null,
    executable: version.ok ? (resolvedPath ?? 'bash') : null,
    kind: version.ok ? classifyBashPath(resolvedPath, d.platform) : null,
    probes,
  };
}

function classifyBashPath(resolved: string | null, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return 'native';
  const norm = (resolved ?? '').toLowerCase().replace(/\//g, '\\');
  if (norm.includes('system32')) return 'wsl-bash';
  if (norm.includes('\\git\\')) return 'git-bash';
  if (norm.includes('msys')) return 'msys2';
  if (norm.includes('cygwin')) return 'cygwin';
  return 'native';
}

/**
 * Candidatos ordenados de bash.exe do Git for Windows (win32 apenas):
 * 1. `bash` do PATH quando já é Git-bash; 2. raiz de `git --exec-path`;
 * 3. `%ProgramFiles%\Git`, `%LocalAppData%\Programs\Git` e literais.
 */
async function gitBashCandidates(
  d: ResolvedShellDeps,
  bashPath: string | null,
  probes: Record<string, ShellProbeResult>,
): Promise<string[]> {
  const candidates: string[] = [];
  if (bashPath && classifyBashPath(bashPath, d.platform) === 'git-bash') candidates.push(bashPath);
  const execPath = await d.run('git', ['--exec-path']);
  probes['git-exec-path'] = probeResult('git', ['--exec-path'], execPath);
  const execDir = execPath.ok ? firstLine(execPath.output) : null;
  if (execDir) {
    let dir = execDir;
    for (let i = 0; i < 4; i += 1) {
      candidates.push(path.join(dir, 'bin', 'bash.exe'), path.join(dir, 'usr', 'bin', 'bash.exe'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const pfVariants = [d.env.PROGRAMFILES, d.env.ProgramFiles, d.env['PROGRAMFILES(X86)']].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  for (const pf of pfVariants) {
    candidates.push(
      path.join(pf, 'Git', 'bin', 'bash.exe'),
      path.join(pf, 'Git', 'usr', 'bin', 'bash.exe'),
    );
  }
  const local = d.env.LOCALAPPDATA;
  if (local) {
    candidates.push(
      path.join(local, 'Programs', 'Git', 'bin', 'bash.exe'),
      path.join(local, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
    );
  }
  candidates.push(
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  );
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase().replace(/\//g, '\\');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Git Bash — só conta verificado executando: `--version` e `-lc 'echo ok'`
 * no bash.exe resolvido. Ausência de executável funcional = rota indisponível.
 */
async function probeGitBash(d: ResolvedShellDeps, bashPath: string | null): Promise<ShellStatus> {
  const probes: Record<string, ShellProbeResult> = {};
  if (d.platform !== 'win32') return absent(probes);
  const candidates = await gitBashCandidates(d, bashPath, probes);
  for (const candidate of candidates) {
    const exists = d.exists(candidate);
    probes[`exists:${candidate}`] = fsProbe(`exists ${candidate}`, exists);
    if (!exists) continue;
    const versionArgs = ['--version'];
    const version = await d.run(candidate, versionArgs);
    probes[`version:${candidate}`] = probeResult(candidate, versionArgs, version);
    if (!version.ok) continue;
    const execArgs = ['-lc', 'echo forge-gitbash-ok'];
    const exec = await d.run(candidate, execArgs);
    probes[`exec:${candidate}`] = probeResult(candidate, execArgs, exec);
    if (exec.ok) {
      return {
        present: true,
        version: firstLine(version.output),
        executable: candidate,
        kind: 'git-bash',
        probes,
      };
    }
  }
  return absent(probes);
}

/**
 * WSL — reportado como capacidade à parte; a rota Windows o ignora sempre.
 * Presente quando `wsl.exe` responde, `where.exe` o localiza ou estamos
 * dentro dele (`WSL_DISTRO_NAME`).
 */
async function probeWsl(d: ResolvedShellDeps): Promise<ShellStatus> {
  const probes: Record<string, ShellProbeResult> = {};
  const distro = d.env.WSL_DISTRO_NAME;
  if (distro) {
    probes['env:WSL_DISTRO_NAME'] = fsProbe('env:WSL_DISTRO_NAME', true, distro);
    return { present: true, version: distro, executable: null, kind: 'inside-wsl', probes };
  }
  probes['env:WSL_DISTRO_NAME'] = fsProbe('env:WSL_DISTRO_NAME', false, null);
  if (d.platform !== 'win32') return absent(probes);
  const whichArgs = ['wsl.exe'];
  const which = await d.run('where.exe', whichArgs);
  probes.which = probeResult('where.exe', whichArgs, which);
  const statusArgs = ['--status'];
  const status = await d.run('wsl.exe', statusArgs);
  probes.status = probeResult('wsl.exe', statusArgs, status);
  const present = which.ok || status.ok;
  return {
    present,
    version: status.ok ? firstLine(status.output) : null,
    executable: which.ok ? firstLine(which.output) : present ? 'wsl.exe' : null,
    kind: null,
    probes,
  };
}

/**
 * Shell MSYS de arquivo candidato (Cygwin/MSYS2) — `--version` no bash.exe
 * resolve a execução; nunca colapsa em Git Bash (paths e rótulos próprios).
 */
async function probeMsysFamily(
  d: ResolvedShellDeps,
  kind: 'cygwin' | 'msys2',
  candidates: string[],
): Promise<ShellStatus> {
  const probes: Record<string, ShellProbeResult> = {};
  if (d.platform !== 'win32') return absent(probes);
  for (const candidate of candidates) {
    const exists = d.exists(candidate);
    probes[`exists:${candidate}`] = fsProbe(`exists ${candidate}`, exists);
    if (!exists) continue;
    const args = ['--version'];
    const version = await d.run(candidate, args);
    probes[`version:${candidate}`] = probeResult(candidate, args, version);
    if (version.ok) {
      return {
        present: true,
        version: firstLine(version.output),
        executable: candidate,
        kind,
        probes,
      };
    }
  }
  return absent(probes);
}

/**
 * As sete shells na ordem fixa do contrato — `bash` antes de `git_bash`
 * porque o path resolvido do bash genérico alimenta os candidatos do Git.
 */
export async function discoverShells(deps: ShellDeps = {}): Promise<ShellDiscovery> {
  const d = resolveDeps(deps);
  const powershell = await probePowerShell(d, false);
  const pwsh = await probePowerShell(d, true);
  const bash = await probeBash(d);
  const git_bash = await probeGitBash(d, bash.executable);
  const wsl = await probeWsl(d);
  const cygwin = await probeMsysFamily(d, 'cygwin', [
    'C:\\cygwin64\\bin\\bash.exe',
    'C:\\cygwin\\bin\\bash.exe',
  ]);
  const msys2 = await probeMsysFamily(d, 'msys2', [
    'C:\\msys64\\usr\\bin\\bash.exe',
    'C:\\msys32\\usr\\bin\\bash.exe',
  ]);
  return { powershell, pwsh, bash, git_bash, wsl, cygwin, msys2 };
}

export interface ShellRefusal {
  code: ForgeErrorCode;
  cause: string;
  remedy: string;
}

/** Rota de setup no Windows — o que `findSetupScript` consome. */
export interface WinShellRoute {
  route: 'powershell' | 'pwsh' | 'git_bash' | 'none';
  /** Condutor da cadeia `.ps1` — `powershell.exe` ou `pwsh`. */
  ps?: string;
  /** bash.exe do Git for Windows verificado executando — rota `.sh`. */
  bash?: string;
  refusal?: ShellRefusal;
}

const SHELL_NOT_FOUND_CAUSE =
  'nenhuma shell de instalação utilizável no Windows: powershell.exe/pwsh ausentes e Git Bash não executa';
const SHELL_NOT_FOUND_REMEDY =
  'instale PowerShell 7+ (`winget install Microsoft.PowerShell`), habilite o powershell.exe 5.1 do Windows ou instale Git for Windows — o Git Bash vira a rota de `install.windows.sh`. WSL nunca substitui shell nativo';
const SHELL_UNAVAILABLE_CAUSE =
  'shells de instalação encontradas no disco mas nenhuma executa (powershell.exe/pwsh/bash.exe falharam na sonda — política bloqueando ou instalação quebrada)';
const SHELL_UNAVAILABLE_REMEDY =
  'verifique a política de execução (Get-ExecutionPolicy / AppLocker / WDAC) ou reinstale PowerShell 7+/Git for Windows; WSL nunca substitui shell nativo';

/** Alguma shell candidata existe no disco mas falhou na execução? */
function shellsOnDiskButBroken(shells: ShellDiscovery): boolean {
  const psFile = shells.powershell.probes.file?.ok === true && !shells.powershell.present;
  const pwshFile = shells.pwsh.probes.file?.ok === true && !shells.pwsh.present;
  const gitBashCandidate =
    !shells.git_bash.present &&
    Object.entries(shells.git_bash.probes).some(
      ([key, probe]) => key.startsWith('exists:') && probe.ok,
    );
  return psFile || pwshFile || gitBashCandidate;
}

/**
 * Decisão de rota Windows — as quatro células do contrato:
 *
 *   powershell/pwsh presente → `.ps1` (powershell.exe primeiro, pwsh depois)
 *   ambas ausentes + Git Bash executando → `install.windows.sh`
 *   nada → FORGE-SHELL-NOT-FOUND (ou FORGE-SHELL-UNAVAILABLE quando há
 *     executável no disco que não responde — bloqueio, não ausência)
 *
 * WSL, Cygwin e MSYS2 são reportados mas JAMAIS entram na rota nativa.
 */
export function windowsRoute(shells: ShellDiscovery): WinShellRoute {
  const gitBash = shells.git_bash.present ? (shells.git_bash.executable ?? 'bash') : undefined;
  if (shells.powershell.present) {
    return {
      route: 'powershell',
      ps: shells.powershell.executable ?? 'powershell.exe',
      ...(gitBash ? { bash: gitBash } : {}),
    };
  }
  if (shells.pwsh.present) {
    return {
      route: 'pwsh',
      ps: shells.pwsh.executable ?? 'pwsh',
      ...(gitBash ? { bash: gitBash } : {}),
    };
  }
  if (shells.git_bash.present) {
    return { route: 'git_bash', bash: gitBash };
  }
  const unavailable = shellsOnDiskButBroken(shells);
  return {
    route: 'none',
    refusal: {
      code: unavailable ? 'FORGE-SHELL-UNAVAILABLE' : 'FORGE-SHELL-NOT-FOUND',
      cause: unavailable ? SHELL_UNAVAILABLE_CAUSE : SHELL_NOT_FOUND_CAUSE,
      remedy: unavailable ? SHELL_UNAVAILABLE_REMEDY : SHELL_NOT_FOUND_REMEDY,
    },
  };
}

/**
 * Par `{ps, bash}` para `findSetupScript` — só sonda shells em win32; em
 * POSIX devolve `{}` (a cadeia `sh` é o contrato da plataforma).
 */
export async function windowsSetupShells(
  platform: NodeJS.Platform = process.platform,
  deps: ShellDeps = {},
): Promise<{ ps?: string; bash?: string }> {
  if (platform !== 'win32') return {};
  const route = windowsRoute(await discoverShells({ ...deps, platform }));
  return { ...(route.ps ? { ps: route.ps } : {}), ...(route.bash ? { bash: route.bash } : {}) };
}
