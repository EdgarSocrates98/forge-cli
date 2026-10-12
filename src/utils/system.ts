import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { ForgeRepo, SetupScript, SyncResult } from '../types.js';

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

export async function syncRepo(repo: ForgeRepo, targetDir: string): Promise<SyncResult> {
  const repoDir = path.join(targetDir, repo.name);
  if (existsSync(repoDir)) {
    if (!hasGitRepo(repoDir)) return { kind: 'non-git', dirty: false };
    const dirty = await isGitDirty(repoDir);
    try {
      await execa('git', ['pull', '--ff-only'], { cwd: repoDir });
      return { kind: 'pulled', dirty };
    } catch {
      return { kind: 'pull-failed', dirty };
    }
  }
  await execa('git', ['clone', repo.url, repoDir]);
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
    onLine?.(line);
  }
  await sub;
}

export function errorDetail(error: unknown): string {
  if (error && typeof error === 'object') {
    const err = error as { shortMessage?: string; stderr?: string; message?: string };
    return err.stderr?.trim() || err.shortMessage || err.message || String(error);
  }
  return String(error);
}
