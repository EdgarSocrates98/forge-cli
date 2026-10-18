import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { artifactsRoot, loadState } from './artifacts.js';
import { writeFileAtomic } from './safety.js';
import type { CliState } from './artifacts.js';
import type { ForgeRepo } from './types.js';

// ---------------------------------------------------------------------------
// §2.7 lifecycle additions: env lockfile, profile import/export,
// interrupted-run recovery, breaking-change analysis.
// Drift detection lives in status.ts ('drifted' phase); managed-file backup in
// lifecycle.ts (configFilesToBackup). Rollback scope stays per-effect:
// only actions marked reversible in the plan are covered — everything else
// is reported as manual/non-reversible.
// ---------------------------------------------------------------------------

// ---- env lockfile --------------------------------------------------------

export interface EnvLock {
  schema: 'forge-cli/EnvLock/v1';
  generated_at: string;
  forges: Record<string, { head?: string; env_files: string[]; digest: string }>;
}

/** Digest of env-relevant file *names + sizes* (never values). */
export function envLockDigest(repoDir: string): { files: string[]; digest: string } {
  const names = [
    '.env.example',
    'forge.env.schema.json',
    'forge.json',
    'package.json',
    'pyproject.toml',
  ];
  const files: string[] = [];
  const hash = createHash('sha256');
  for (const name of names) {
    const file = path.join(repoDir, name);
    if (!existsSync(file)) continue;
    files.push(name);
    const content = readFileSync(file);
    // .env values are NEVER hashed — only schema-bearing files.
    hash.update(name).update('\0').update(content).update('\0');
  }
  return { files, digest: hash.digest('hex') };
}

/** Monta o lockfile sem gravar — `--plan`/`--check` nunca escreve. */
export function buildEnvLock(targetDir: string, repos: readonly ForgeRepo[]): EnvLock {
  const lock: EnvLock = {
    schema: 'forge-cli/EnvLock/v1',
    generated_at: new Date().toISOString(),
    forges: {},
  };
  for (const repo of repos) {
    const dir = path.join(targetDir, repo.name);
    if (!existsSync(dir)) continue;
    const { files, digest } = envLockDigest(dir);
    const head = loadState(targetDir)?.repos[repo.name]?.head;
    lock.forges[repo.name] = { env_files: files, digest, ...(head ? { head } : {}) };
  }
  return lock;
}

export function writeEnvLock(targetDir: string, repos: readonly ForgeRepo[]): EnvLock {
  const lock = buildEnvLock(targetDir, repos);
  const file = path.join(artifactsRoot(targetDir), 'env.lock.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(lock, null, 2));
  return lock;
}

export type LockCheck = { forge: string; state: 'match' | 'drifted' | 'untracked' | 'absent' };

export function checkEnvLock(targetDir: string, repos: readonly ForgeRepo[]): LockCheck[] {
  const file = path.join(artifactsRoot(targetDir), 'env.lock.json');
  if (!existsSync(file)) return repos.map((r) => ({ forge: r.name, state: 'untracked' }));
  let lock: EnvLock;
  try {
    lock = JSON.parse(readFileSync(file, 'utf8')) as EnvLock;
  } catch {
    return repos.map((r) => ({ forge: r.name, state: 'untracked' }));
  }
  return repos.map((repo) => {
    const entry = lock.forges?.[repo.name];
    if (!entry) return { forge: repo.name, state: 'untracked' };
    const dir = path.join(targetDir, repo.name);
    if (!existsSync(dir)) return { forge: repo.name, state: 'absent' };
    const { digest } = envLockDigest(dir);
    return { forge: repo.name, state: digest === entry.digest ? 'match' : 'drifted' };
  });
}

// ---- profile import/export -------------------------------------------------

export interface ForgeProfile {
  schema: 'forge-cli/Profile/v1';
  exported_at: string;
  pins?: Record<string, string>;
  repos: Record<string, { head?: string; phase?: string }>;
}

/** Monta o profile sem gravar — `--plan`/`--check` nunca escreve. */
export function buildProfile(targetDir: string): ForgeProfile {
  const state = loadState(targetDir);
  return {
    schema: 'forge-cli/Profile/v1',
    exported_at: new Date().toISOString(),
    ...(state?.pins ? { pins: state.pins } : {}),
    repos: Object.fromEntries(
      Object.entries(state?.repos ?? {}).map(([name, v]) => [
        name,
        { ...(v.head ? { head: v.head } : {}), ...(v.phase ? { phase: v.phase } : {}) },
      ]),
    ),
  };
}

export function exportProfile(targetDir: string, dest: string): ForgeProfile {
  const profile = buildProfile(targetDir);
  mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
  writeFileAtomic(dest, JSON.stringify(profile, null, 2));
  return profile;
}

export function importProfile(file: string): ForgeProfile | { error: string } {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ForgeProfile;
    if (parsed?.schema !== 'forge-cli/Profile/v1' || typeof parsed.repos !== 'object') {
      return { error: 'invalid-profile' };
    }
    return parsed;
  } catch {
    return { error: 'invalid-json' };
  }
}

// ---- interrupted-run recovery ----------------------------------------------

export interface InterruptedRun {
  forge: string;
  phase: string;
  at?: string;
  suggestion: 'retry' | 'reinstall' | 'inspect';
}

/** Entradas que indicam uma execução interrompida (partial/failed sem fechamento). */
export function interruptedRuns(state: CliState | null): InterruptedRun[] {
  if (!state) return [];
  return Object.entries(state.repos)
    .filter(([, v]) => v.phase === 'partial' || v.status === 'error')
    .map(([forge, v]) => ({
      forge,
      phase: v.phase ?? 'failed',
      at: v.at,
      suggestion: v.status === 'error' ? 'retry' : 'reinstall',
    }));
}

// ---- breaking-change analysis ------------------------------------------------

export interface VersionBump {
  from: string;
  to: string;
  level: 'major' | 'minor' | 'patch' | 'prerelease' | 'unknown';
  breaking_suspect: boolean;
}

export function classifyBump(from: string, to: string): VersionBump['level'] {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] } : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return 'unknown';
  if (a.major !== b.major) return 'major';
  if (a.minor !== b.minor) return 'minor';
  if (a.patch !== b.patch) return 'patch';
  if (a.pre !== b.pre) return 'prerelease';
  return 'unknown';
}

/** Analisa o salto entre a revisão atual e cada tag disponível (offline: só refs locais). */
export function analyzeBumps(current: string, candidates: readonly string[]): VersionBump[] {
  return candidates
    .filter((t) => t !== current)
    .map((to) => {
      const level = classifyBump(current, to);
      return { from: current, to, level, breaking_suspect: level === 'major' };
    })
    .sort((a, b) => a.to.localeCompare(b.to, undefined, { numeric: true }));
}

// ---- managed-file inventory (para backup/restore consistente) ----------------

export function managedFiles(repoDir: string): string[] {
  const out = new Set<string>();
  for (const name of ['.env', 'forge.json', 'forge-cli.config.json']) {
    if (existsSync(path.join(repoDir, name))) out.add(name);
  }
  try {
    for (const file of readdirSync(repoDir)) {
      if (file === '.env.example' || !file.includes('.example.')) continue;
      const real = file.replace('.example.', '.');
      if (existsSync(path.join(repoDir, real))) out.add(real);
    }
  } catch {
    /* permissões — reporta o que deu para ler */
  }
  return [...out].sort();
}
