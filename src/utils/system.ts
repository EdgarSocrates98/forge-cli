import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { discoverPythons } from '../env/python.js';
import { isLinkOrJunction, isSafeRepoUrl, redactSecrets, resolveInside } from '../safety.js';
import type { ForgeRepo, SetupScript, SyncFailure, SyncResult } from '../types.js';

export const DEFAULT_WORKSPACE = './forge-workspace';

/** Keep Windows subprocess lookup stable when a host exposes both PATH/Path. */
export function portableEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (process.platform === 'win32') {
    const winPath = env.Path ?? env.PATH;
    delete env.PATH;
    delete env.Path;
    if (winPath) env.Path = winPath;
  }
  return env;
}

/** Resolve git by absolute path on Windows hosts with unreliable PATH lookup. */
export function gitExecutable(): string {
  if (process.platform !== 'win32') return 'git';
  const raw = process.env.Path ?? process.env.PATH ?? '';
  for (const dir of raw.split(path.delimiter)) {
    const candidate = path.join(dir, 'git.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'git';
}

export function commandEnv(command: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = portableEnv(extra);
  if (process.platform === 'win32' && command.toLowerCase() === 'git') {
    const git = gitExecutable();
    if (path.isAbsolute(git)) {
      const current = env.Path ?? '';
      env.Path = `${path.dirname(git)}${path.delimiter}${current}`;
    }
  }
  return env;
}

function executable(command: string): string {
  return command.toLowerCase() === 'git' ? gitExecutable() : command;
}

/** Home do estado forge-cli — `FORGE_CLI_HOME` permite home hermético
 * (bench, testes, containers). Hosts continuam no home real do usuário. */
export function cliHome(): string {
  return process.env.FORGE_CLI_HOME || os.homedir();
}

/**
 * Cadeias de script de setup por rota (ciclo 12.1, lf-0016). Windows tem
 * DUAS rotas nativas: `.ps1` via PowerShell/pwsh e `.sh` via Git Bash
 * (`install.windows.sh` é o script dedicado — lf-0018 — seguido dos
 * candidatos POSIX, que o Git Bash executa nativamente). WSL, Cygwin e
 * MSYS2 nunca entram na cadeia — reportados pela descoberta, não rotas.
 */
const WIN_PS_SETUP_CANDIDATES = ['setup.ps1', 'install.ps1'];
const WIN_BASH_SETUP_CANDIDATES = ['install.windows.sh', 'setup.sh', 'install.sh'];
const POSIX_SETUP_CANDIDATES = ['setup.sh', 'install.sh'];

/**
 * Shells de setup resolvidas pela descoberta (`windowsSetupShells`):
 * `ps` = condutor .ps1 verificado (powershell.exe|pwsh), `bash` = bash.exe
 * do Git for Windows verificado executando. Ausente na posição = rota
 * indisponível — capability é execução verificada, nunca palpite de PATH.
 */
export interface WinSetupShells {
  ps?: string;
  bash?: string;
}

export function resolveTargetDir(input: string | undefined, cwd = process.cwd()): string {
  const trimmed = input?.trim();
  return path.resolve(cwd, trimmed ? trimmed : DEFAULT_WORKSPACE);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export function hasGitRepo(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

const PKG_FILE_MAX_BYTES = 256 * 1024;
const PYPROJECT_NAME_RE = /^\s*name\s*=\s*["']([^"']+)["']\s*$/m;

/**
 * Identidade de conteúdo de um checkout — lê `[project] name` do
 * `pyproject.toml` ou `"name"` do `package.json` (limitado a 256 KiB,
 * nunca lança). É o que reconhece um ZIP extraído sem `.git` como uma
 * Forja do catálogo: `product-forge-main/` com `name = "product-forge"`
 * é a Forja `product-forge`. `null` = sem evidência (ausente/ilegível).
 */
export function packageIdentity(dir: string): { name: string; file: string } | null {
  try {
    const pyproject = path.join(dir, 'pyproject.toml');
    if (existsSync(pyproject)) {
      const text = readFileSync(pyproject, 'utf8');
      if (text.length <= PKG_FILE_MAX_BYTES) {
        const match = PYPROJECT_NAME_RE.exec(text);
        if (match) return { name: match[1], file: 'pyproject.toml' };
      }
    }
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      const text = readFileSync(pkg, 'utf8');
      if (text.length <= PKG_FILE_MAX_BYTES) {
        const parsed: unknown = JSON.parse(text);
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { name?: unknown }).name === 'string'
        ) {
          return { name: (parsed as { name: string }).name, file: 'package.json' };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Lista nomes de um diretório — determinismo de enumeração, nunca lança. */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Candidatos de executável node, em ordem — para quando `node` não está no
 * PATH mas a máquina tem instalação (portable, nvm, scoop, chocolatey…).
 * O primeiro é sempre `process.execPath`: o interpretador que ESTÁ rodando
 * este CLI — evidência real de capacidade, nunca palpite. Os literais são
 * só caminhos prováveis; quem chama filtra por `existsSync` e sonda
 * `--version` antes de acreditar.
 */
export function nodeExecutables(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string | null | undefined) => {
    if (!candidate) return;
    const key = candidate.toLowerCase().replace(/\//g, '\\');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };
  if (/^node/i.test(path.basename(process.execPath))) push(process.execPath);
  // path.win32.join / path.posix.join: candidates must carry the TARGET
  // platform's separators even when discovery is simulated off-OS (tests,
  // CI on Linux) — bare path.join leaks host separators into the list.
  const wj = path.win32.join;
  if (platform === 'win32') {
    for (const pf of [env.PROGRAMFILES, env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (pf) push(wj(pf, 'nodejs', 'node.exe'));
    }
    push('C:\\Program Files\\nodejs\\node.exe');
    push('C:\\Progra~1\\nodejs\\node.exe');
    // nvm-windows: symlink (NVM_SYMLINK) + versões instaladas sob NVM_HOME.
    if (env.NVM_SYMLINK) push(wj(env.NVM_SYMLINK, 'node.exe'));
    const nvmRoots = [env.NVM_HOME, env.APPDATA ? wj(env.APPDATA, 'nvm') : null];
    for (const root of nvmRoots) {
      if (!root) continue;
      for (const ver of safeReaddir(root)) push(wj(root, ver, 'node.exe'));
    }
    push('C:\\nvm4w\\nodejs\\node.exe');
    // scoop e chocolatey — gerenciadores comuns fora do PATH padrão.
    push(wj(home, 'scoop', 'apps', 'nodejs', 'current', 'node.exe'));
    push(wj(home, 'scoop', 'apps', 'nodejs-lts', 'current', 'node.exe'));
    const chocoLib = wj(env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'lib');
    for (const dir of safeReaddir(chocoLib)) {
      if (/^nodejs/i.test(dir)) push(wj(chocoLib, dir, 'tools', 'node.exe'));
    }
    push(wj(home, 'AppData', 'Local', 'Volta', 'bin', 'node.exe'));
  } else {
    const pj = path.posix.join;
    push('/usr/local/bin/node');
    push('/opt/homebrew/bin/node');
    if (platform === 'linux') push('/home/linuxbrew/.linuxbrew/bin/node');
    const nvmDir = env.NVM_DIR ?? pj(home, '.nvm');
    const nvmVersions = pj(nvmDir, 'versions', 'node');
    for (const ver of safeReaddir(nvmVersions)) {
      push(pj(nvmVersions, ver, 'bin', 'node'));
    }
    push(pj(home, '.volta', 'bin', 'node'));
    push(pj(home, '.asdf', 'shims', 'node'));
    const mise = pj(home, '.local', 'share', 'mise', 'installs', 'node');
    for (const ver of safeReaddir(mise)) push(pj(mise, ver, 'bin', 'node'));
  }
  return out;
}

/** Diretório do pacote instalado — sobe até achar o package.json do próprio CLI. */
export function findPackageRoot(startDir: string, pkgName = 'theforge-cli'): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    const identity = packageIdentity(dir);
    if (identity?.file === 'package.json' && identity.name === pkgName) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Sugestão de workspace — o diretório onde já vivem checkouts das Forjas.
 * Caso comum: clone/zip extraído como `E:\projetos\FORJAS\forge-cli` → o
 * pai `E:\projetos\FORJAS` já contém os irmãos do catálogo. Em instalação
 * npm global o pai não tem checkouts → `null` (sem sugestão inventada).
 * Ordem: `cwd` (contexto explícito do usuário), depois o pai do pacote.
 */
export function suggestWorkspaceDir(
  repoNames: readonly string[],
  opts: { cwd?: string; selfDir?: string; exists?: (dir: string) => boolean } = {},
): string | null {
  const exists = opts.exists ?? existsSync;
  const names = new Set(repoNames.map((n) => n.toLowerCase()));
  const hasCheckout = (dir: string): boolean => {
    try {
      return readdirSync(dir, { withFileTypes: true }).some(
        (entry) => entry.isDirectory() && names.has(entry.name.toLowerCase()),
      );
    } catch {
      return false;
    }
  };
  const candidates: string[] = [];
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  candidates.push(cwd);
  const selfRoot = findPackageRoot(opts.selfDir ?? path.dirname(fileURLToPath(import.meta.url)));
  if (selfRoot) {
    const parent = path.dirname(selfRoot);
    if (parent !== cwd) candidates.push(parent);
  }
  for (const dir of candidates) {
    if (exists(dir) && hasCheckout(dir)) return dir;
  }
  return null;
}

/**
 * Escolhe o script de setup pelo OS + shells verificadas. Em `win32` sem
 * `winShells` mantém o comportamento legado (só cadeia `.ps1` via
 * powershell.exe); com `winShells` a cadeia é `.ps1` quando `ps` existe
 * senão `.sh` via Git Bash — `install.windows.sh` primeiro, depois os
 * candidatos POSIX que o Git Bash executa. `{}` (sondado, nada encontrado)
 * = sem rota → `null`; `undefined` (não sondado) = legado.
 */
export function findSetupScript(
  repoDir: string,
  platform: NodeJS.Platform = process.platform,
  winShells?: WinSetupShells,
): SetupScript | null {
  if (platform === 'win32') {
    const ps = winShells === undefined ? 'powershell.exe' : winShells.ps;
    if (ps) {
      for (const file of WIN_PS_SETUP_CANDIDATES) {
        if (existsSync(path.join(repoDir, file))) {
          return {
            file,
            command: ps,
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
          };
        }
      }
    }
    const bash = winShells?.bash;
    if (bash) {
      for (const file of WIN_BASH_SETUP_CANDIDATES) {
        if (existsSync(path.join(repoDir, file))) {
          return { file, command: bash, args: [file] };
        }
      }
    }
    return null;
  }
  for (const file of POSIX_SETUP_CANDIDATES) {
    if (existsSync(path.join(repoDir, file))) {
      return { file, command: 'sh', args: ['-c', `chmod +x ${file} && ./${file}`] };
    }
  }
  return null;
}

export function npmInstallArgs(repoDir: string): string[] | null {
  if (!existsSync(path.join(repoDir, 'package.json'))) return null;
  return existsSync(path.join(repoDir, 'package-lock.json')) ? ['ci'] : ['install'];
}

export function withCmdExt(bin: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && /^(npm|npx|pnpm|yarn)$/i.test(bin) ? `${bin}.cmd` : bin;
}

/**
 * Teto de um probe externo de ambiente (versão/auth/toolchain). Um shim
 * que nunca responde — `cursor --version` Electron girando por >4min no
 * E2E do ciclo 11.2.1 — não pode travar doctor/hosts-list/preflight.
 * `FORGE_CLI_PROBE_TIMEOUT_MS` (inteiro >0, ms) sobrescreve o default.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export function probeTimeoutMs(): number {
  const raw = Number(process.env.FORGE_CLI_PROBE_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_PROBE_TIMEOUT_MS;
}

export async function commandWorks(
  command: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const result = await execa(executable(command), args, {
      reject: false,
      timeout: opts.timeoutMs ?? probeTimeoutMs(),
      env: commandEnv(command),
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve o interpretador Python disponível — agora delega ao pipeline
 * lf-0017 (`discoverPythons`): FORGE_PYTHON, venvs, managers e locais
 * de plataforma entram, e toda seleção foi validada por `--version`.
 * `null` = nenhum interpretador válido (a recusa detalhada vive no
 * relatório de descoberta — `env discover` a expõe).
 */
export async function resolvePython(): Promise<string[] | null> {
  const discovery = await discoverPythons({});
  return discovery.selected?.argv ?? null;
}

export async function commandOutput(
  command: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  try {
    // Sem timeout um shim de host pode girar para sempre (host Electron
    // travado manteve `doctor`/`hosts list` bloqueados >4 min — E2E-A).
    const result = await execa(executable(command), args, {
      reject: false,
      timeout: opts.timeoutMs ?? probeTimeoutMs(),
      env: commandEnv(command),
    });
    if (result.exitCode !== 0) return null;
    return (result.stdout || result.stderr || '').trim() || 'ok';
  } catch {
    return null;
  }
}

/** Resultado detalhado de um probe — distingue timeout de sem-saída. */
export interface CommandProbeResult {
  output: string | null;
  /**
   * true = processo morto por timeout — INCONCLUSIVO, nunca "ausente":
   * um shim que não responde não é evidência de que o host não existe.
   */
  timedOut: boolean;
}

export async function commandProbe(
  command: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<CommandProbeResult> {
  const timeoutMs = opts.timeoutMs ?? probeTimeoutMs();
  try {
    const result = await execa(executable(command), args, {
      reject: false,
      timeout: timeoutMs,
      env: commandEnv(command),
    });
    if (result.timedOut) return { output: null, timedOut: true };
    if (result.exitCode !== 0) return { output: null, timedOut: false };
    return { output: (result.stdout || result.stderr || '').trim() || 'ok', timedOut: false };
  } catch {
    return { output: null, timedOut: false };
  }
}

export async function isGitDirty(repoDir: string): Promise<boolean> {
  try {
    const { stdout } = await execa(gitExecutable(), ['status', '--porcelain'], {
      cwd: repoDir,
      env: commandEnv('git'),
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function currentHead(repoDir: string): Promise<string | null> {
  return commandOutput('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
}

function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^https?:\/\/[^@/]+@/, 'https://')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function sameRemote(a: string, b: string): boolean {
  return normalizeRemote(a) === normalizeRemote(b);
}

export function classifyGitFailure(message: string): SyncFailure {
  if (
    /authentication failed|could not read username|permission denied|403|terminal prompts disabled/i.test(
      message,
    )
  )
    return 'auth';
  if (/not possible to fast-forward|divergent|diverged|refusing to merge/i.test(message))
    return 'diverged';
  if (
    /could not resolve host|unable to access|timed out|connection (refused|reset)|network is unreachable/i.test(
      message,
    )
  )
    return 'network';
  return 'unknown';
}

export interface SyncOptions {
  shallow?: boolean;
  noPull?: boolean;
  offline?: boolean;
}

export async function syncRepo(
  repo: ForgeRepo,
  targetDir: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const repoDir = resolveInside(targetDir, repo.name);
  if (!repoDir) throw new Error(`nome de repositório inválido: ${repo.name}`);
  if (!isSafeRepoUrl(repo.url)) throw new Error(`URL de repositório não permitida: ${repo.name}`);
  if (isLinkOrJunction(repoDir)) {
    throw new Error(`destino é link simbólico/junction: ${repo.name}`);
  }
  if (existsSync(repoDir)) {
    if (!hasGitRepo(repoDir)) return { kind: 'non-git', dirty: false };
    const dirty = await isGitDirty(repoDir);
    const remote = await commandOutput('git', ['-C', repoDir, 'remote', 'get-url', 'origin']);
    if (remote && remote !== 'ok' && !sameRemote(remote, repo.url)) {
      return { kind: 'remote-mismatch', dirty };
    }
    if (opts.offline) return { kind: 'fixed-ref', dirty };
    if (opts.noPull) {
      await execa(gitExecutable(), ['fetch', '--quiet', '--tags'], {
        cwd: repoDir,
        reject: false,
        env: commandEnv('git', { GIT_TERMINAL_PROMPT: '0' }),
      });
      return { kind: 'fixed-ref', dirty };
    }
    try {
      await execa(gitExecutable(), ['pull', '--ff-only'], { cwd: repoDir, env: commandEnv('git') });
      return { kind: 'pulled', dirty };
    } catch (error) {
      return { kind: 'pull-failed', dirty, failure: classifyGitFailure(errorDetail(error)) };
    }
  }
  if (opts.offline) throw new Error(`modo offline: ${repo.name} não está clonada localmente`);
  const cloneArgs = opts.shallow ? ['clone', '--depth', '1'] : ['clone'];
  await execa(gitExecutable(), [...cloneArgs, '--', repo.url, repoDir], { env: commandEnv('git') });
  return { kind: 'cloned', dirty: false };
}

export async function runStreamed(
  argv: readonly string[],
  cwd: string,
  onLine?: (line: string) => void,
  timeoutMs?: number,
): Promise<void> {
  const [bin, ...args] = argv;
  const sub = execa(bin.toLowerCase() === 'git' ? gitExecutable() : withCmdExt(bin), args, {
    cwd,
    all: true,
    buffer: false,
    timeout: timeoutMs,
    env: commandEnv(bin),
  });
  for await (const line of sub.iterable({ from: 'all' })) {
    onLine?.(redactSecrets(line));
  }
  await sub;
}

export function errorDetail(error: unknown): string {
  if (error && typeof error === 'object') {
    const err = error as { shortMessage?: string; stderr?: string; message?: string };
    return redactSecrets(err.stderr?.trim() || err.shortMessage || err.message || String(error));
  }
  return redactSecrets(String(error));
}
