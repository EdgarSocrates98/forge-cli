import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifactsRoot } from '../artifacts.js';
import { writeFileAtomic } from '../safety.js';
import { S } from '../ui/strings.js';
import { commandOutput, commandWorks, withCmdExt } from '../utils/system.js';

// ---------------------------------------------------------------------------
// §2.5 — contrato dos adaptadores de hosts de IA.
// Seis estados distintos, nunca achatados, nunca pulados por inferência
// otimista: absent → installed → configured → authenticated → integrated →
// validated. 'authenticated' só via probe real (comando documentado saindo 0);
// 'integrated' só quando um registro está presente na config do host;
// 'validated' só depois de validateIntegration — detect() nunca o reporta.
// ---------------------------------------------------------------------------

export type HostState =
  'absent' | 'installed' | 'configured' | 'authenticated' | 'integrated' | 'validated';

export interface HostDetection {
  host: string;
  state: HostState;
  found: boolean;
  version?: string | null;
  configPaths: string[];
  auth: 'verified' | 'absent' | 'unknown';
  detail?: string;
}

export interface HostPlanAction {
  kind: 'write-config' | 'merge-json' | 'run-argv' | 'manual';
  target?: string;
  argv?: readonly string[];
  preview?: string;
  reason: string;
}

export interface HostPlan {
  host: string;
  forge_id: string;
  actions: HostPlanAction[];
  copyable_command?: string;
  reversible: boolean;
}

export interface HostResult {
  ok: boolean;
  applied: string[];
  skipped: string[];
  detail?: string;
  backup?: string;
}

export interface HostValidation {
  ok: boolean;
  checks: { id: string; result: 'pass' | 'warn' | 'fail' | 'skipped'; detail?: string }[];
}

export interface HostAdapter {
  id: string;
  displayName: string;
  detect(home?: string): Promise<HostDetection>;
  planIntegration(
    forge: { forge_id: string; mcp_command?: readonly string[] },
    workspaceDir: string,
    home?: string,
  ): Promise<HostPlan | null>;
  applyIntegration(plan: HostPlan, opts?: { dryRun?: boolean; home?: string }): Promise<HostResult>;
  validateIntegration(forge_id: string, home?: string): Promise<HostValidation>;
  rollback(plan: HostPlan, backup?: string, home?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers internos compartilhados (mantidos aqui para preservar o contrato de
// arquivos do §2.5 sem criar módulo extra nem ciclo de imports com index.ts).
// ---------------------------------------------------------------------------

/** Probe de comando injetável — testes substituem sem tocar em CLIs reais. */
export interface HostProbe {
  output(command: string, args: string[]): Promise<string | null>;
}

export const defaultProbe: HostProbe = {
  output: (command, args) => commandOutput(command, args),
};

export function hostHome(home?: string): string {
  return home || os.homedir();
}

/** Extrai a primeira versão semver-like; senão a 1ª linha útil do output. */
export function parseVersionOutput(out: string | null): string | null {
  if (!out) return null;
  const match = /(\d+\.\d+[\d.]*)/.exec(out);
  if (match) return match[1];
  const first = out.split('\n')[0]?.trim();
  return first && first !== 'ok' ? first : null;
}

export function existingConfigPaths(home: string, rels: readonly string[]): string[] {
  return rels.map((rel) => path.join(home, rel)).filter((p) => existsSync(p));
}

export interface DetectSpec {
  id: string;
  probe: HostProbe;
  /** Candidatos a probe de versão; o primeiro que sair 0 vence. */
  versionArgv: readonly (readonly string[])[];
  configRel: readonly string[];
  /** Probe de auth documentado; ausente ⇒ auth 'unknown', teto 'configured'. */
  authArgv?: readonly string[];
  /** Evidência de integração presente na config do host (mcpServers não vazio). */
  hasIntegration?: (home: string) => boolean;
}

/**
 * Detecção por evidência: binário (probe de versão) e/ou arquivos de config.
 * Sem probe de auth documentado, 'authenticated' é inalcançável — a ausência de
 * probe nunca é promovida a 'verified'.
 */
export async function detectHost(home: string, spec: DetectSpec): Promise<HostDetection> {
  let binary = false;
  let version: string | null = null;
  for (const argv of spec.versionArgv) {
    const out = await spec.probe.output(argv[0], argv.slice(1));
    if (out !== null) {
      binary = true;
      version = parseVersionOutput(out);
      break;
    }
  }
  const configPaths = existingConfigPaths(home, spec.configRel);
  if (!binary && configPaths.length === 0) {
    return {
      host: spec.id,
      state: 'absent',
      found: false,
      version: null,
      configPaths,
      auth: 'absent',
    };
  }
  let state: HostState = configPaths.length ? 'configured' : 'installed';
  let auth: HostDetection['auth'] = 'unknown';
  if (spec.authArgv) {
    const out = await spec.probe.output(spec.authArgv[0], spec.authArgv.slice(1));
    auth = out !== null ? 'verified' : 'absent';
    if (auth === 'verified') state = 'authenticated';
  }
  if (spec.hasIntegration?.(home)) state = 'integrated';
  return {
    host: spec.id,
    state,
    found: true,
    version,
    configPaths,
    auth,
    ...(binary && version === null ? { detail: S.hostVersionUnknown } : {}),
  };
}

// ---- JSON ---------------------------------------------------------------

type JsonObject = Record<string, unknown>;

export function readJsonObject(file: string): JsonObject | 'invalid' | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : 'invalid';
  } catch {
    return 'invalid';
  }
}

export function mcpServers(obj: JsonObject): JsonObject {
  const servers = obj.mcpServers;
  return servers && typeof servers === 'object' && !Array.isArray(servers)
    ? (servers as JsonObject)
    : {};
}

export function hasMcpEntry(file: string, forgeId: string): boolean {
  const existing = readJsonObject(file);
  if (existing === null || existing === 'invalid') return false;
  return Object.prototype.hasOwnProperty.call(mcpServers(existing), forgeId);
}

export function hasAnyMcpEntry(file: string): boolean {
  const existing = readJsonObject(file);
  return existing !== null && existing !== 'invalid'
    ? Object.keys(mcpServers(existing)).length > 0
    : false;
}

/**
 * Merge raso preservando TODAS as chaves existentes — nunca clobber.
 * 'duplicate' quando a chave já existe; 'invalid' quando o alvo não é JSON
 * objeto (recusamos escrever sobre algo que não entendemos).
 */
export function mergedMcpConfig(
  existing: JsonObject | 'invalid' | null,
  forgeId: string,
  argv: readonly string[],
): { content: string } | 'duplicate' | 'invalid' {
  if (existing === 'invalid') return 'invalid';
  const base = existing ?? {};
  const servers = mcpServers(base);
  if (Object.prototype.hasOwnProperty.call(servers, forgeId)) return 'duplicate';
  const next: JsonObject = {
    ...base,
    mcpServers: { ...servers, [forgeId]: { command: argv[0], args: argv.slice(1) } },
  };
  return { content: `${JSON.stringify(next, null, 2)}\n` };
}

// ---- backup / rollback ----------------------------------------------------

export interface BackupEntry {
  backup: string;
  target: string;
  absent: boolean;
}

function backupTimestamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

export function backupsRoot(home: string): string {
  return path.join(artifactsRoot(home), 'backups');
}

export function backupDirFor(home: string, hostId: string): string {
  return path.join(backupsRoot(home), `hosts-${hostId}-${backupTimestamp()}`);
}

/**
 * Copia os alvos para o backup ANTES de qualquer escrita. Alvo inexistente vira
 * sentinela `<nome>.absent` para que o rollback possa removê-lo. manifest.json
 * no diretório registra o mapa backup→target.
 */
export function backupTargets(dir: string, hostId: string, targets: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  const files: BackupEntry[] = targets.map((target) => {
    const name = path.basename(target);
    const absent = !existsSync(target);
    if (absent) writeFileAtomic(path.join(dir, `${name}.absent`), '');
    else copyFileSync(target, path.join(dir, name));
    return { backup: name, target, absent };
  });
  writeFileAtomic(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify({ host: hostId, files }, null, 2)}\n`,
  );
}

export function latestBackupDir(home: string, hostId: string): string | null {
  let names: string[];
  try {
    names = readdirSync(backupsRoot(home));
  } catch {
    return null;
  }
  const hit = names
    .filter((n) => n.startsWith(`hosts-${hostId}-`))
    .sort()
    .reverse()[0];
  return hit ? path.join(backupsRoot(home), hit) : null;
}

/** Restaura cada arquivo do manifest do backup; sentinela .absent ⇒ remove o alvo. */
export function restoreBackupDir(dir: string): { restored: string[]; removed: string[] } {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
    files?: BackupEntry[];
  };
  const restored: string[] = [];
  const removed: string[] = [];
  for (const entry of manifest.files ?? []) {
    if (entry.absent) {
      rmSync(entry.target, { force: true });
      removed.push(entry.target);
    } else {
      writeFileAtomic(entry.target, readFileSync(path.join(dir, entry.backup), 'utf8'));
      restored.push(entry.target);
    }
  }
  return { restored, removed };
}

// ---- apply / validate / rollback compartilhados ------------------------------

export type WriteResolution =
  { target: string; content: string } | 'duplicate' | 'invalid' | 'skip';

/**
 * Aplica um HostPlan sem mutação silenciosa: resolve todas as escritas antes,
 * faz backup de todos os alvos, e só então escreve de forma atômica.
 * 'manual' e 'dry-run' nunca escrevem. 'run-argv' executa um comando documentado
 * do host (somente quando planejado explicitamente).
 */
export async function applyHostPlan(
  home: string,
  plan: HostPlan,
  resolveWrite: (action: HostPlanAction) => WriteResolution | Promise<WriteResolution>,
  opts: { dryRun?: boolean } = {},
): Promise<HostResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const writes: { target: string; content: string }[] = [];
  for (const action of plan.actions) {
    if (action.kind === 'manual') {
      skipped.push(action.reason);
      continue;
    }
    if (action.kind === 'run-argv') {
      if (opts.dryRun || !action.argv?.length) {
        skipped.push(action.argv?.join(' ') ?? action.reason);
        continue;
      }
      const ok = await commandWorks(withCmdExt(action.argv[0]), [...action.argv.slice(1)]);
      if (!ok) return { ok: false, applied, skipped, detail: action.reason };
      applied.push(action.argv.join(' '));
      continue;
    }
    const resolved = await resolveWrite(action);
    if (resolved === 'duplicate') skipped.push(S.hostAlreadyIntegrated);
    else if (resolved === 'invalid')
      return { ok: false, applied, skipped, detail: 'invalid-target-json' };
    else if (resolved === 'skip') skipped.push(action.reason);
    else writes.push(resolved);
  }
  if (opts.dryRun) {
    return {
      ok: true,
      applied: [],
      skipped: [...skipped, ...writes.map((w) => w.target)],
      detail: 'dry-run',
    };
  }
  if (!writes.length) return { ok: true, applied, skipped };
  const backup = backupDirFor(home, plan.host);
  backupTargets(
    backup,
    plan.host,
    writes.map((w) => w.target),
  );
  for (const w of writes) {
    try {
      mkdirSync(path.dirname(w.target), { recursive: true });
      writeFileAtomic(w.target, w.content);
      applied.push(w.target);
    } catch (error) {
      return {
        ok: false,
        applied,
        skipped,
        detail: error instanceof Error ? error.message : String(error),
        backup,
      };
    }
  }
  return { ok: true, applied, skipped, backup };
}

/** Validação honesta: chave presente + command não-vazio. Nada de inferência. */
export function validateMcpFile(file: string, forgeId: string): HostValidation {
  const checks: HostValidation['checks'] = [];
  const existing = readJsonObject(file);
  if (existing === null || existing === 'invalid') {
    checks.push({
      id: 'config-file',
      result: 'fail',
      detail: existing === 'invalid' ? 'invalid-json' : 'absent',
    });
    checks.push({ id: 'mcp-key', result: 'fail', detail: forgeId });
    return { ok: false, checks };
  }
  checks.push({ id: 'config-file', result: 'pass', detail: file });
  const entry = mcpServers(existing)[forgeId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    checks.push({ id: 'mcp-key', result: 'fail', detail: forgeId });
    return { ok: false, checks };
  }
  checks.push({ id: 'mcp-key', result: 'pass', detail: forgeId });
  const command = (entry as JsonObject).command;
  const ok = typeof command === 'string' && command.trim().length > 0;
  checks.push({ id: 'command', result: ok ? 'pass' : 'fail', detail: ok ? command : 'empty' });
  return { ok, checks };
}

/** Rollback via manifest do backup; sem backup ⇒ erro 'no-backup' (honesto). */
export async function rollbackHostPlan(
  home: string,
  plan: HostPlan,
  backup?: string,
): Promise<void> {
  const dir = backup ?? latestBackupDir(home, plan.host);
  if (!dir) throw new Error('no-backup');
  restoreBackupDir(dir);
}
