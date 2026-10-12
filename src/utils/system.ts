import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { ForgeRepo, InstallScript, RepoResult } from '../types.js';

export const DEFAULT_WORKSPACE = './forge-workspace';

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

export function findInstallScript(
  repoDir: string,
  platform: NodeJS.Platform = process.platform,
): InstallScript | null {
  if (platform === 'win32') {
    return existsSync(path.join(repoDir, 'install.ps1'))
      ? {
          file: 'install.ps1',
          command: 'powershell.exe',
          args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'install.ps1'],
        }
      : null;
  }
  return existsSync(path.join(repoDir, 'install.sh'))
    ? {
        file: 'install.sh',
        command: 'sh',
        args: ['-c', 'chmod +x install.sh && ./install.sh'],
      }
    : null;
}

function errorDetail(error: unknown): string {
  if (error && typeof error === 'object') {
    const err = error as { shortMessage?: string; stderr?: string; message?: string };
    return err.stderr?.trim() || err.shortMessage || err.message || String(error);
  }
  return String(error);
}

export async function cloneOrPull(repo: ForgeRepo, targetDir: string): Promise<'cloned' | 'pulled'> {
  const repoDir = path.join(targetDir, repo.name);
  if (hasGitRepo(repoDir)) {
    await execa('git', ['pull'], { cwd: repoDir });
    return 'pulled';
  }
  await execa('git', ['clone', repo.url, repoDir]);
  return 'cloned';
}

export async function processRepo(repo: ForgeRepo, targetDir: string): Promise<RepoResult> {
  const repoDir = path.join(targetDir, repo.name);
  try {
    await cloneOrPull(repo, targetDir);
  } catch (error) {
    return { repo, status: 'error', detail: `Falha no clone/pull: ${errorDetail(error)}` };
  }

  const script = findInstallScript(repoDir);
  if (!script) {
    return { repo, status: 'warning', detail: 'Sem script de instalação para este SO' };
  }
  try {
    await execa(script.command, script.args, { cwd: repoDir });
    return { repo, status: 'ok', detail: `Instalado via ${script.file}` };
  } catch (error) {
    return { repo, status: 'error', detail: `Falha em ${script.file}: ${errorDetail(error)}` };
  }
}
