import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { isLinkOrJunction, isSafeRepoUrl, redactSecrets, resolveInside } from '../safety.js';
import type { ForgeRepo, SetupScript, SyncFailure, SyncResult } from '../types.js';

export const DEFAULT_WORKSPACE = './forge-workspace';

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

export async function commandWorks(command: string, args: string[]): Promise<boolean> {
  try {
    const result = await execa(command, args, { reject: false });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function commandOutput(command: string, args: string[]): Promise<string | null> {
  try {
    const result = await execa(command, args, { reject: false });
    if (result.exitCode !== 0) return null;
    return (result.stdout || result.stderr || '').trim() || 'ok';
  } catch {
    return null;
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
    try {
      await execa('git', ['pull', '--ff-only'], { cwd: repoDir });
      return { kind: 'pulled', dirty };
    } catch (error) {
      return { kind: 'pull-failed', dirty, failure: classifyGitFailure(errorDetail(error)) };
    }
  }
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
