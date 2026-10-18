import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { artifactsRoot, forgetRepo, loadState } from './artifacts.js';
import { checkoutRef } from './git-revs.js';
import { isLinkOrJunction, resolveInside } from './safety.js';
import type { ForgeRepo } from './types.js';
import { commandOutput, currentHead, hasGitRepo, isGitDirty, sameRemote } from './utils/system.js';

export type UninstallRefusal = 'invalid-name' | 'symlink' | 'non-git' | 'remote-mismatch' | 'dirty';

export type UninstallPlan =
  | { kind: 'absent'; dir: string }
  | { kind: 'refused'; dir: string; reason: UninstallRefusal }
  | { kind: 'ready'; dir: string; backups: string[] };

/** `.env` e arquivos `x.y` que têm um modelo `x.example.y` correspondente. */
export function configFilesToBackup(repoDir: string): string[] {
  const out = new Set<string>();
  if (existsSync(path.join(repoDir, '.env'))) out.add('.env');
  for (const file of readdirSync(repoDir)) {
    if (file === '.env.example' || !file.includes('.example.')) continue;
    const real = file.replace('.example.', '.');
    if (existsSync(path.join(repoDir, real))) out.add(real);
  }
  return [...out];
}

/** Só planeja: nunca altera o disco. */
export async function planUninstall(targetDir: string, repo: ForgeRepo): Promise<UninstallPlan> {
  const dir = resolveInside(targetDir, repo.name);
  if (!dir)
    return { kind: 'refused', dir: path.join(targetDir, repo.name), reason: 'invalid-name' };
  if (isLinkOrJunction(dir)) return { kind: 'refused', dir, reason: 'symlink' };
  if (!existsSync(dir)) return { kind: 'absent', dir };
  if (!hasGitRepo(dir)) return { kind: 'refused', dir, reason: 'non-git' };
  const remote = await commandOutput('git', ['-C', dir, 'remote', 'get-url', 'origin']);
  if (remote && remote !== 'ok' && !sameRemote(remote, repo.url)) {
    return { kind: 'refused', dir, reason: 'remote-mismatch' };
  }
  if (await isGitDirty(dir)) return { kind: 'refused', dir, reason: 'dirty' };
  return { kind: 'ready', dir, backups: configFilesToBackup(dir) };
}

/** Copia configs pessoais para .forge-cli/backups e remove somente o diretório planejado. */
export function executeUninstall(
  targetDir: string,
  repo: ForgeRepo,
  plan: Extract<UninstallPlan, { kind: 'ready' }>,
): string | null {
  const expected = resolveInside(targetDir, repo.name);
  if (!expected || expected !== plan.dir) throw new Error('plano de remoção inconsistente');
  let backupDir: string | null = null;
  if (plan.backups.length) {
    backupDir = path.join(artifactsRoot(targetDir), 'backups', `${repo.name}-${Date.now()}`);
    for (const file of plan.backups) {
      const dest = path.join(backupDir, file);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(path.join(plan.dir, file), dest);
    }
  }
  rmSync(plan.dir, { recursive: true, force: true });
  forgetRepo(targetDir, repo.name);
  return backupDir;
}

export type RollbackResult =
  | { ok: true; from?: string; to: string }
  | { ok: false; reason: 'no-previous' | 'not-cloned' | 'dirty' | 'failed'; detail?: string };

export type RollbackPlan =
  | { ok: true; from?: string; to: string }
  | { ok: false; reason: 'no-previous' | 'not-cloned' | 'dirty' };

/**
 * Só planeja: as mesmas validações read-only do rollbackRepo (clone,
 * previousHead no state, working tree limpo) sem o `git checkout` —
 * `--plan`/`--check` nunca tocam o working tree nem o state.
 */
export async function planRollback(targetDir: string, repo: ForgeRepo): Promise<RollbackPlan> {
  const dir = resolveInside(targetDir, repo.name);
  if (!dir || !hasGitRepo(dir) || isLinkOrJunction(dir)) return { ok: false, reason: 'not-cloned' };
  const previous = loadState(targetDir)?.repos[repo.name]?.previousHead;
  if (!previous) return { ok: false, reason: 'no-previous' };
  if (await isGitDirty(dir)) return { ok: false, reason: 'dirty' };
  const from = (await currentHead(dir)) ?? undefined;
  return { ok: true, from, to: previous };
}

/** Volta ao HEAD anterior registrado; só mexe no checkout Git, nunca em efeitos do instalador. */
export async function rollbackRepo(targetDir: string, repo: ForgeRepo): Promise<RollbackResult> {
  const dir = resolveInside(targetDir, repo.name);
  if (!dir || !hasGitRepo(dir) || isLinkOrJunction(dir)) return { ok: false, reason: 'not-cloned' };
  const previous = loadState(targetDir)?.repos[repo.name]?.previousHead;
  if (!previous) return { ok: false, reason: 'no-previous' };
  if (await isGitDirty(dir)) return { ok: false, reason: 'dirty' };
  const from = (await currentHead(dir)) ?? undefined;
  try {
    await checkoutRef(dir, previous);
  } catch (error) {
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : '' };
  }
  return { ok: true, from, to: previous };
}
