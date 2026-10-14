/**
 * Repair catalog for the self-healing flow (spec C5/§5.2).
 *
 * Exactly four honest repairs, keyed by DoctorCheck.id via REPAIR_REGISTRY:
 * - installation.forge-dir.absent   SAFE_AUTOMATIC — create .forge-cli tree
 * - environment.env.missing-key     REVIEW_REQUIRED — append `NAME=` lines, never overwrite
 * - installation.lockfile.drift     MANUAL_ONLY     — plan only; apply() refuses
 * - installation.backup.restore     REVIEW_REQUIRED — copy a reviewed backup back
 *
 * Nothing here invents fixes for unknown checks and no value ever leaves the
 * .env parser — appended lines are empty placeholders for a human to fill.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { artifactsRoot } from '../artifacts.js';
import { ENV_KEY_RE, parseEnv } from '../envintel/parse.js';
import { analyzeEnv } from '../envintel/validate.js';
import { writeFileAtomic } from '../safety.js';
import type { DoctorCheck } from '../doctor2/model.js';
import type { RepairAction, RepairContext, RepairStep } from './types.js';

/** Context actually passed by the flow — RepairContext plus review choices. */
export interface HealContext extends RepairContext {
  /** The DoctorCheck being repaired — evidence may carry key names. */
  check?: DoctorCheck;
  /** Root-relative backup file selected during plan review. */
  backup?: string;
  /** Injected clock for backup-dir naming; defaults to ISO wall clock. */
  now?: () => string;
}

const rel = (root: string, abs: string): string => path.relative(root, abs) || '.';

/** `2026-10-14T01:23:45.678Z` → `20261014-012345` (matches env-\d{8}-\d{6}). */
function stampOf(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}` : iso.replace(/[^\d]/g, '').slice(0, 14);
}

// ---------------------------------------------------------------------------
// installation.forge-dir.absent — SAFE_AUTOMATIC
// ---------------------------------------------------------------------------

export const FORGE_DIR_SUBDIRS = ['backups', 'logs', 'receipts', 'reports'] as const;

export const forgeDirRepair: RepairAction = {
  id: 'heal.installation.forge-dir',
  checkId: 'installation.forge-dir.absent',
  description: 'Create the .forge-cli state directory tree (idempotent)',
  riskClass: 'SAFE_AUTOMATIC',
  reversible: true,
  plan(ctx: RepairContext): RepairStep[] {
    const base = artifactsRoot(ctx.root);
    return ['', ...FORGE_DIR_SUBDIRS].map((sub) => {
      const dir = sub ? path.join(base, sub) : base;
      return {
        description: `create directory ${rel(ctx.root, dir)}${existsSync(dir) ? ' (already present)' : ''}`,
        touches: [rel(ctx.root, dir)],
      };
    });
  },
  async apply(ctx: RepairContext): Promise<string> {
    if (ctx.dryRun) return 'dry-run — not applied';
    const base = artifactsRoot(ctx.root);
    const created: string[] = [];
    for (const sub of ['', ...FORGE_DIR_SUBDIRS]) {
      const dir = sub ? path.join(base, sub) : base;
      if (existsSync(dir)) continue;
      mkdirSync(dir, { recursive: true });
      created.push(rel(ctx.root, dir));
    }
    return created.length
      ? `created ${created.length} directorie(s): ${created.join(', ')}`
      : 'all directories already present';
  },
  async verify(ctx: RepairContext): Promise<boolean> {
    const base = artifactsRoot(ctx.root);
    return ['', ...FORGE_DIR_SUBDIRS].every((sub) => {
      const dir = sub ? path.join(base, sub) : base;
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  },
};

// ---------------------------------------------------------------------------
// environment.env.missing-key — REVIEW_REQUIRED
// ---------------------------------------------------------------------------

/** Uppercase-only env key tokens found in check evidence. */
const EVIDENCE_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

function envPathOf(root: string): string {
  return path.join(root, '.env');
}

function presentKeys(root: string): Set<string> {
  const file = envPathOf(root);
  if (!existsSync(file)) return new Set();
  return new Set(parseEnv(readFileSync(file, 'utf8')).entries.map((e) => e.key));
}

/**
 * Keys the environment still lacks: re-derived deterministically from the
 * envintel analysis (findings kind 'missing'), unioned with uppercase key
 * names carried by the check's own evidence. Sorted, value-free.
 */
export function missingEnvKeys(root: string, check?: DoctorCheck): string[] {
  const missing = new Set<string>();
  for (const f of analyzeEnv(root).findings) {
    if (f.kind === 'missing') missing.add(f.key);
  }
  for (const line of check?.evidence ?? []) {
    for (const token of line.split(/[^A-Za-z0-9_]+/)) {
      if (EVIDENCE_KEY_RE.test(token) && ENV_KEY_RE.test(token)) missing.add(token);
    }
  }
  return [...missing].sort();
}

/** Keys to append — the missing set minus anything already present (never overwrite). */
function keysToAppend(root: string, check?: DoctorCheck): string[] {
  const present = presentKeys(root);
  return missingEnvKeys(root, check).filter((k) => !present.has(k));
}

function backupEnvFile(ctx: HealContext, current: string): string {
  const stamp = stampOf(ctx.now?.() ?? new Date().toISOString());
  const dir = path.join(artifactsRoot(ctx.root), 'backups', `env-${stamp}`);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, '.env'), current);
  return dir;
}

export const envMissingKeyRepair: RepairAction = {
  id: 'heal.environment.env-missing-key',
  checkId: 'environment.env.missing-key',
  description: 'Append `NAME=` placeholder lines for missing .env keys (never overwrites)',
  riskClass: 'REVIEW_REQUIRED',
  reversible: true,
  plan(ctx: RepairContext): RepairStep[] {
    const root = ctx.root;
    const toAppend = keysToAppend(root, (ctx as HealContext).check);
    const steps: RepairStep[] = [];
    if (existsSync(envPathOf(root))) {
      steps.push({
        description: `backup .env to ${rel(root, path.join(artifactsRoot(root), 'backups'))}/env-<ts>/.env`,
        touches: ['.env', `${rel(root, artifactsRoot(root))}/backups/`],
      });
    }
    if (!toAppend.length) {
      steps.push({ description: 'no missing keys to append', touches: [] });
      return steps;
    }
    for (const key of toAppend) {
      steps.push({ description: `append line '${key}=' to .env`, touches: ['.env'] });
    }
    return steps;
  },
  async apply(ctx: RepairContext): Promise<string> {
    const root = ctx.root;
    if (ctx.dryRun) return 'dry-run — not applied';
    const file = envPathOf(root);
    const exists = existsSync(file);
    const current = exists ? readFileSync(file, 'utf8') : '';
    const env = parseEnv(current);
    const present = new Set(env.entries.map((e) => e.key));
    const toAppend = keysToAppend(root, (ctx as HealContext).check).filter((k) => !present.has(k));
    if (!toAppend.length) return 'no missing keys to append — .env unchanged';

    const backup = exists ? backupEnvFile(ctx as HealContext, current) : null;
    const lines = [...env.lines];
    if (exists && lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!exists) lines.push('# .env gerado pelo forge-cli');
    for (const key of toAppend) lines.push(`${key}=`);
    lines.push('');
    writeFileAtomic(file, lines.join('\n'));

    const backupNote = backup ? ` · backup ${rel(root, backup)}` : '';
    return `appended ${toAppend.length} placeholder line(s): ${toAppend.map((k) => `${k}=`).join(', ')}${backupNote}`;
  },
  async verify(ctx: RepairContext): Promise<boolean> {
    const file = envPathOf(ctx.root);
    if (!existsSync(file)) return false;
    const present = new Set(parseEnv(readFileSync(file, 'utf8')).entries.map((e) => e.key));
    return missingEnvKeys(ctx.root, (ctx as HealContext).check).every((k) => present.has(k));
  },
};

// ---------------------------------------------------------------------------
// installation.lockfile.drift — MANUAL_ONLY (diagnosed + planned, never applied)
// ---------------------------------------------------------------------------

export const LOCKFILE_REGEN_COMMAND = 'forge-cli lock';
export const LOCKFILE_CHECK_COMMAND = 'forge-cli lock check';

export const lockfileDriftRepair: RepairAction = {
  id: 'heal.installation.lockfile-regen',
  checkId: 'installation.lockfile.drift',
  description: 'Regenerate .forge-cli/env.lock.json (manual command — never auto-applied)',
  riskClass: 'MANUAL_ONLY',
  reversible: false,
  plan(): RepairStep[] {
    return [
      {
        description: `run \`${LOCKFILE_REGEN_COMMAND}\` to regenerate .forge-cli/env.lock.json`,
        touches: [path.join('.forge-cli', 'env.lock.json')],
      },
      {
        description: `run \`${LOCKFILE_CHECK_COMMAND}\` to confirm the drift cleared`,
        touches: [],
      },
    ];
  },
  async apply(): Promise<string> {
    throw new Error(
      `manual-only fix refused: run \`${LOCKFILE_REGEN_COMMAND}\` to regenerate env.lock.json`,
    );
  },
  async verify(): Promise<boolean> {
    // Drift is a per-forge digest comparison requiring the repo catalog; the
    // verifier of record is `forge-cli lock check`, so self-verify stays false.
    return false;
  },
};

// ---------------------------------------------------------------------------
// installation.backup.restore — REVIEW_REQUIRED
// ---------------------------------------------------------------------------

export interface BackupCandidate {
  /** Backup dir name under .forge-cli/backups (e.g. env-20261014-012345). */
  name: string;
  /** Absolute dir path. */
  dir: string;
  /** Files inside the backup dir, sorted. */
  files: string[];
  mtimeMs: number;
}

const ENV_BACKUP_RE = /^env-\d{8}-\d{6}$/;
const REPO_BACKUP_RE = /^([a-z0-9][a-z0-9._-]*)-\d{10,}$/i;

/** Backups under <root>/.forge-cli/backups, newest first (mtime desc, name asc). */
export function listBackups(root: string): BackupCandidate[] {
  const base = path.join(artifactsRoot(root), 'backups');
  if (!existsSync(base)) return [];
  const out: BackupCandidate[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    try {
      const files = readdirSync(dir, { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => f.name)
        .sort();
      if (!files.length) continue;
      out.push({ name: entry.name, dir, files, mtimeMs: statSync(dir).mtimeMs });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

/**
 * Where a backup file copies back to, relative to root:
 *   env-<ts>/.env        → .env
 *   <repo>-<epoch>/.env  → <repo>/.env
 *   anything else        → basename at root
 */
export function restoreTargetFor(backupDirName: string, fileName: string): string {
  if (ENV_BACKUP_RE.test(backupDirName)) return fileName;
  const m = REPO_BACKUP_RE.exec(backupDirName);
  if (m) return `${m[1]}/${fileName}`;
  return fileName;
}

/** Resolve the backup file to restore — the reviewed selection or the newest. */
function pickBackupFile(ctx: HealContext): { src: string; rel: string; dest: string } {
  const backupsBase = path.join(artifactsRoot(ctx.root), 'backups');
  if (ctx.backup) {
    const abs = path.resolve(ctx.root, ctx.backup);
    const inside = path.relative(backupsBase, abs);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new Error(`selected backup escapes .forge-cli/backups: ${ctx.backup}`);
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`selected backup not found: ${ctx.backup}`);
    }
    const dirName = inside.split(path.sep)[0] ?? '';
    const fileName = path.basename(abs);
    return { src: abs, rel: inside, dest: restoreTargetFor(dirName, fileName) };
  }
  const candidates = listBackups(ctx.root);
  const envCand = candidates.find((c) => ENV_BACKUP_RE.test(c.name) && c.files.includes('.env'));
  const cand = envCand ?? candidates[0];
  if (!cand) throw new Error('no backups available under .forge-cli/backups');
  const fileName = cand.files.includes('.env') ? '.env' : cand.files[0];
  return {
    src: path.join(cand.dir, fileName),
    rel: `${cand.name}/${fileName}`,
    dest: restoreTargetFor(cand.name, fileName),
  };
}

export const backupRestoreRepair: RepairAction = {
  id: 'heal.installation.backup-restore',
  checkId: 'installation.backup.restore',
  description: 'Restore a file from .forge-cli/backups (newest first; selection reviewed)',
  riskClass: 'REVIEW_REQUIRED',
  reversible: true,
  plan(ctx: RepairContext): RepairStep[] {
    const candidates = listBackups(ctx.root);
    if (!candidates.length) {
      return [
        {
          description: `no backups found under ${rel(ctx.root, path.join(artifactsRoot(ctx.root), 'backups'))}/`,
          touches: [],
        },
      ];
    }
    const steps: RepairStep[] = candidates.map((c) => ({
      description: `available backup ${c.name} (${c.files.join(', ')})`,
      touches: [],
    }));
    try {
      const picked = pickBackupFile(ctx as HealContext);
      steps.push({
        description: `copy ${picked.rel} back to ${picked.dest}`,
        touches: [picked.rel, picked.dest],
      });
    } catch (error) {
      steps.push({
        description: `no restorable backup selected (${error instanceof Error ? error.message : 'unknown'})`,
        touches: [],
      });
    }
    return steps;
  },
  async apply(ctx: RepairContext): Promise<string> {
    if (ctx.dryRun) return 'dry-run — not applied';
    const picked = pickBackupFile(ctx as HealContext);
    const dest = path.resolve(ctx.root, picked.dest);
    const relDest = path.relative(ctx.root, dest);
    if (relDest.startsWith('..') || path.isAbsolute(relDest)) {
      throw new Error(`restore target escapes root: ${picked.dest}`);
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileAtomic(dest, readFileSync(picked.src, 'utf8'));
    return `restored ${picked.rel} → ${relDest}`;
  },
  async verify(ctx: RepairContext): Promise<boolean> {
    try {
      const picked = pickBackupFile(ctx as HealContext);
      const dest = path.resolve(ctx.root, picked.dest);
      return existsSync(dest) && readFileSync(dest, 'utf8') === readFileSync(picked.src, 'utf8');
    } catch {
      return false;
    }
  },
};

/** The honest repair catalog — exactly these check ids, nothing else. */
export const REPAIR_ACTIONS: readonly RepairAction[] = [
  forgeDirRepair,
  envMissingKeyRepair,
  lockfileDriftRepair,
  backupRestoreRepair,
];
