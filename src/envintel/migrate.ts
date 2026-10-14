import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { artifactsRoot } from '../artifacts.js';
import { writeFileAtomic } from '../safety.js';
import { S } from '../ui/strings.js';
import type { EnvSchema, VarSpec } from './model.js';
import { formatEntry, parseEnv } from './parse.js';
import { deriveSchema } from './schema.js';

export type PlanActionKind = 'add' | 'rename' | 'update-default' | 'remove-requested' | 'keep';

export interface PlanAction {
  kind: PlanActionKind;
  key: string;
  /**
   * Valor a escrever para 'add'. ATENÇÃO: pode conter segredo gerado —
   * mascarar com S.envSecretHidden em qualquer saída (ver maskPlan).
   */
  to?: string;
  reason: string;
}

export interface EnvPlan {
  actions: PlanAction[];
  removesRequireApproval: true;
}

export interface ApplyOptions {
  dryRun?: boolean;
  authorizeRemoves?: boolean;
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
  backup?: string;
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function generatedSecret(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Valor de preenchimento para um 'add':
 * - segredo claramente vazio no exemplo → hex aleatório (randomBytes);
 * - não-segredo com default do esquema → o default;
 * - demais casos → vazio, para o usuário preencher.
 */
function addValue(spec: VarSpec, exampleEmpty: boolean): string {
  if (spec.secret) return exampleEmpty ? generatedSecret() : '';
  return spec.default ?? '';
}

/**
 * Plano aditivo por padrão: só propõe 'add' para chaves ausentes.
 * Chaves presentes fora do esquema viram 'remove-requested' — nunca aplicadas
 * sem authorizeRemoves=true (o .env pode conter variáveis do usuário).
 */
export function planMigration(repoDir: string, targetSchema?: EnvSchema): EnvPlan {
  const schema = targetSchema ?? deriveSchema(repoDir);
  const envPath = path.join(repoDir, '.env');
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : null;
  const present = new Set(env?.entries.map((e) => e.key) ?? []);

  // "Vazio no exemplo" decide se segredo ganha valor gerado.
  const examplePath = path.join(repoDir, '.env.example');
  const exampleEmpty = new Set<string>();
  if (existsSync(examplePath)) {
    for (const e of parseEnv(readFileSync(examplePath, 'utf8')).entries) {
      if (e.value === '') exampleEmpty.add(e.key);
    }
  }

  const actions: PlanAction[] = [];
  for (const spec of schema.vars) {
    if (present.has(spec.key)) {
      actions.push({ kind: 'keep', key: spec.key, reason: 'presente' });
    } else {
      actions.push({
        kind: 'add',
        key: spec.key,
        to: addValue(spec, exampleEmpty.has(spec.key)),
        reason: S.envVarMissing,
      });
    }
  }
  if (env) {
    const inSchema = new Set(schema.vars.map((v) => v.key));
    for (const key of present) {
      if (!inSchema.has(key)) {
        actions.push({ kind: 'remove-requested', key, reason: S.envVarObsolete });
      }
    }
  }
  return { actions, removesRequireApproval: true };
}

function backupDirFor(repoDir: string, ts: string): string {
  return path.join(artifactsRoot(repoDir), 'backups', `env-${ts}`);
}

/** Copia o .env atual para <repo>/.forge-cli/backups/env-<ts>/.env. */
function backupEnv(repoDir: string, content: string): string {
  const dir = backupDirFor(repoDir, timestamp());
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.env');
  writeFileAtomic(file, content);
  return dir;
}

/**
 * Aplica o plano de forma aditiva: entradas existentes ficam byte a byte
 * (linhas brutas preservadas); novas chaves são anexadas ao final.
 * Sempre cria backup antes de escrever; dryRun não escreve nada.
 */
export function applyMigration(
  repoDir: string,
  plan: EnvPlan,
  opts: ApplyOptions = {},
): ApplyResult {
  const envPath = path.join(repoDir, '.env');
  const exists = existsSync(envPath);
  const current = exists ? readFileSync(envPath, 'utf8') : '';
  const env = parseEnv(current);
  const present = new Set(env.entries.map((e) => e.key));

  const removes = plan.actions.filter((a) => a.kind === 'remove-requested' && present.has(a.key));
  const authorized = opts.authorizeRemoves === true;
  const skipped: string[] = [];
  if (!authorized) skipped.push(...removes.map((a) => a.key));
  const adds = plan.actions.filter((a) => a.kind === 'add' && !present.has(a.key));

  if (opts.dryRun) {
    return { applied: [], skipped: [...adds.map((a) => a.key), ...skipped] };
  }
  if (!adds.length && !(authorized && removes.length)) {
    return { applied: [], skipped };
  }

  const removeSet = new Set(authorized ? removes.map((a) => a.key) : []);
  const dropLines = new Set(env.entries.filter((e) => removeSet.has(e.key)).map((e) => e.line));
  let lines = env.lines.filter((_, i) => !dropLines.has(i));
  if (exists && lines.length && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  if (!exists) lines = ['# .env gerado pelo forge-cli'];
  for (const a of adds) lines.push(formatEntry(a.key, a.to ?? ''));
  lines.push('');

  const backup = exists ? backupEnv(repoDir, current) : undefined;
  writeFileAtomic(envPath, lines.join('\n'));
  return {
    applied: [...(authorized ? removes.map((a) => a.key) : []), ...adds.map((a) => a.key)],
    skipped,
    ...(backup ? { backup } : {}),
  };
}

/** Diretório do backup mais recente de .env, ou null. */
export function latestEnvBackup(repoDir: string): string | null {
  const root = path.join(artifactsRoot(repoDir), 'backups');
  if (!existsSync(root)) return null;
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^env-\d{8}-\d{6}$/.test(d.name))
    .map((d) => d.name)
    .sort();
  const last = candidates.at(-1);
  return last ? path.join(root, last) : null;
}

/** Restaura o .env byte a byte a partir de um diretório de backup. */
export function rollbackEnv(repoDir: string, backupDir: string): boolean {
  const src = path.join(backupDir, '.env');
  if (!existsSync(src)) return false;
  writeFileAtomic(path.join(repoDir, '.env'), readFileSync(src, 'utf8'));
  return true;
}
