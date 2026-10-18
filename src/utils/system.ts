import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { isLinkOrJunction, isSafeRepoUrl, redactSecrets, resolveInside } from '../safety.js';
import type { ForgeRepo, SetupScript, SyncFailure, SyncResult } from '../types.js';

export const DEFAULT_WORKSPACE = './forge-workspace';

/** Home do estado forge-cli — `FORGE_CLI_HOME` permite home hermético
 * (bench, testes, containers). Hosts continuam no home real do usuário. */
export function cliHome(): string {
  return process.env.FORGE_CLI_HOME || os.homedir();
}

const WIN_SETUP_CANDIDATES = ['setup.ps1', 'install.ps1'];
const POSIX_SETUP_CANDIDATES = ['setup.sh', 'install.sh'];

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

export function findSetupScript(
  repoDir: string,
  platform: NodeJS.Platform = process.platform,
): SetupScript | null {
  if (platform === 'win32') {
    for (const file of WIN_SETUP_CANDIDATES) {
      if (existsSync(path.join(repoDir, file))) {
        return {
          file,
          command: 'powershell.exe',
          args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
        };
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
    const result = await execa(command, args, {
      reject: false,
      timeout: opts.timeoutMs ?? probeTimeoutMs(),
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Resolve o interpretador Python disponível (python3, python, py -3). */
export async function resolvePython(): Promise<string[] | null> {
  for (const candidate of [['python3'], ['python'], ['py', '-3']]) {
    if (await commandWorks(candidate[0], [...candidate.slice(1), '--version'])) return candidate;
  }
  return null;
}

export async function commandOutput(
  command: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  try {
    // Sem timeout um shim de host pode girar para sempre (host Electron
    // travado manteve `doctor`/`hosts list` bloqueados >4 min — E2E-A).
    const result = await execa(command, args, {
      reject: false,
      timeout: opts.timeoutMs ?? probeTimeoutMs(),
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
    const result = await execa(command, args, { reject: false, timeout: timeoutMs });
    if (result.timedOut) return { output: null, timedOut: true };
    if (result.exitCode !== 0) return { output: null, timedOut: false };
    return { output: (result.stdout || result.stderr || '').trim() || 'ok', timedOut: false };
  } catch {
    return { output: null, timedOut: false };
  }
}

export async function isGitDirty(repoDir: string): Promise<boolean> {
  try {
    const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: repoDir });
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
      await execa('git', ['fetch', '--quiet', '--tags'], {
        cwd: repoDir,
        reject: false,
        env: { GIT_TERMINAL_PROMPT: '0' },
      });
      return { kind: 'fixed-ref', dirty };
    }
    try {
      await execa('git', ['pull', '--ff-only'], { cwd: repoDir });
      return { kind: 'pulled', dirty };
    } catch (error) {
      return { kind: 'pull-failed', dirty, failure: classifyGitFailure(errorDetail(error)) };
    }
  }
  if (opts.offline) throw new Error(`modo offline: ${repo.name} não está clonada localmente`);
  const cloneArgs = opts.shallow ? ['clone', '--depth', '1'] : ['clone'];
  await execa('git', [...cloneArgs, '--', repo.url, repoDir]);
  return { kind: 'cloned', dirty: false };
}

export async function runStreamed(
  argv: readonly string[],
  cwd: string,
  onLine?: (line: string) => void,
  timeoutMs?: number,
): Promise<void> {
  const [bin, ...args] = argv;
  const sub = execa(withCmdExt(bin), args, {
    cwd,
    all: true,
    buffer: false,
    timeout: timeoutMs,
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
