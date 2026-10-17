import { execa } from 'execa';
import { classifyGitFailure, errorDetail } from './utils/system.js';
import type { SyncFailure } from './types.js';

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0' };

export function isValidRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_PATTERN.test(ref) && !ref.includes('..');
}

export function compareVersions(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

export interface UpdateCheck {
  upstream?: string;
  behind: number;
  ahead: number;
  failure?: SyncFailure;
}

/** Faz fetch (não altera a working tree) e compara HEAD com o upstream. */
export async function updateCheck(repoDir: string): Promise<UpdateCheck> {
  // Sem remote configurado não há o que buscar: 'no-upstream' honesto,
  // nunca 'unknown' (que implicaria erro transitório de rede/auth).
  const remotes = await execa('git', ['remote'], { cwd: repoDir, reject: false });
  if (remotes.exitCode !== 0 || !String(remotes.stdout).trim()) {
    return { behind: 0, ahead: 0, failure: 'no-upstream' };
  }
  try {
    await execa('git', ['fetch', '--quiet', '--tags'], { cwd: repoDir, env: NO_PROMPT });
  } catch (error) {
    return { behind: 0, ahead: 0, failure: classifyGitFailure(errorDetail(error)) };
  }
  const up = await execa('git', ['rev-parse', '--abbrev-ref', '@{u}'], {
    cwd: repoDir,
    reject: false,
  });
  if (up.exitCode !== 0) return { behind: 0, ahead: 0, failure: 'no-upstream' };
  const counts = await execa('git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], {
    cwd: repoDir,
    reject: false,
  });
  const [ahead, behind] = String(counts.stdout ?? '')
    .trim()
    .split(/\s+/)
    .map((n) => Number.parseInt(n, 10) || 0);
  return { upstream: String(up.stdout).trim(), ahead: ahead ?? 0, behind: behind ?? 0 };
}

export async function localTags(repoDir: string, limit = 10): Promise<string[]> {
  const res = await execa('git', ['tag', '--list'], { cwd: repoDir, reject: false });
  if (res.exitCode !== 0) return [];
  return String(res.stdout)
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
    .sort(compareVersions)
    .slice(0, limit);
}

export async function remoteTags(url: string, limit = 10): Promise<string[] | null> {
  const res = await execa('git', ['ls-remote', '--tags', '--refs', '--', url], {
    reject: false,
    env: NO_PROMPT,
    timeout: 30_000,
  });
  if (res.exitCode !== 0) return null;
  return String(res.stdout)
    .split('\n')
    .map((l) => l.split('refs/tags/')[1]?.trim())
    .filter((t): t is string => Boolean(t))
    .sort(compareVersions)
    .slice(0, limit);
}

/** Resolve tag (com ou sem prefixo v) ou revisão e faz checkout destacado. */
export async function checkoutRef(repoDir: string, ref: string): Promise<string> {
  if (!isValidRef(ref)) throw new Error(`revisão inválida: ${ref}`);
  const candidates = [ref, ref.startsWith('v') ? ref.slice(1) : `v${ref}`];
  for (const candidate of candidates) {
    const verify = await execa(
      'git',
      ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`],
      { cwd: repoDir, reject: false },
    );
    if (verify.exitCode === 0) {
      await execa('git', ['checkout', '--detach', String(verify.stdout).trim()], {
        cwd: repoDir,
      });
      return candidate;
    }
  }
  throw new Error(`revisão não encontrada: ${ref}`);
}
