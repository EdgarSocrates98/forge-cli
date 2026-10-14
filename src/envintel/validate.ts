import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { S } from '../ui/strings.js';
import type { EnvEntry, EnvFile, EnvSchema, Finding, VarSpec, VarStatus } from './model.js';
import { parseEnv } from './parse.js';
import { deriveSchema, inferKind, isPlaceholderValue, looksSecretKey } from './schema.js';

export interface ValidateOptions {
  /** Quando true, vars kind 'path' também precisam existir no disco (relativas ao repoDir). */
  checkPaths?: boolean;
}

/** Comprimento mínimo determinístico para um segredo não-placeholder. */
export const MIN_SECRET_LENGTH = 8;

export type InsecureReason = 'vazio' | 'curto' | 'placeholder';

/** Classifica segredos por padrão — o valor nunca aparece em findings. */
export function insecureSecretReason(value: string): InsecureReason | null {
  if (value === '') return 'vazio';
  if (isPlaceholderValue(value)) return 'placeholder';
  if (value.length < MIN_SECRET_LENGTH) return 'curto';
  return null;
}

export function checkValue(
  spec: Pick<VarSpec, 'kind'> & Partial<VarSpec>,
  value: string,
  opts: ValidateOptions & { baseDir?: string } = {},
): boolean {
  switch (spec.kind) {
    case 'port':
      return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
    case 'url':
      try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    case 'path': {
      if (!value.trim()) return false;
      if (!opts.checkPaths) return true;
      const p = path.isAbsolute(value) ? value : path.resolve(opts.baseDir ?? '.', value);
      return existsSync(p);
    }
    case 'bool':
      return /^(true|false|0|1|yes|no)$/i.test(value.trim());
    case 'number':
      return value.trim() !== '' && Number.isFinite(Number(value));
    case 'secret':
      return value !== '' && !isPlaceholderValue(value);
    case 'enum':
      return spec.choices?.includes(value) ?? false;
    case 'string':
      break;
  }
  if (spec.pattern && !new RegExp(spec.pattern).test(value)) return false;
  return true;
}

const SEVERE: ReadonlySet<Finding['kind']> = new Set([
  'missing',
  'invalid',
  'insecure',
  'duplicate',
  'conflict',
]);

export interface EnvAnalysis {
  state: 'absent' | 'partial' | 'complete';
  envFile: EnvFile | null;
  schema: EnvSchema;
  findings: Finding[];
  vars: VarStatus[];
  /** Chaves presentes no .env fora do esquema (candidatas a 'obsolete'). */
  obsolete: string[];
}

function duplicateFindings(key: string, entries: EnvEntry[]): Finding[] {
  if (entries.length < 2) return [];
  const lines = entries.map((e) => e.line + 1).join(', ');
  const out: Finding[] = [{ key, kind: 'duplicate', detail: `${S.envVarDuplicate} · ${lines}` }];
  if (entries.some((e) => e.value !== entries[0].value)) {
    out.push({ key, kind: 'conflict', detail: `${S.envVarConflict} · ${lines}` });
  }
  return out;
}

function analyzeKey(
  key: string,
  spec: Pick<VarSpec, 'kind' | 'secret'> & Partial<VarSpec>,
  entries: EnvEntry[] | undefined,
  opts: ValidateOptions & { baseDir: string },
): { status: VarStatus; findings: Finding[] } {
  const findings: Finding[] = [];
  const present = (entries?.length ?? 0) > 0;
  const value = present ? entries![entries!.length - 1].value : undefined;
  if (entries) findings.push(...duplicateFindings(key, entries));
  let valid: boolean | null = null;
  if (present) {
    valid = checkValue(spec, value!, opts);
    if (!valid) findings.push({ key, kind: 'invalid', detail: spec.kind });
    if (spec.secret) {
      const reason = insecureSecretReason(value!);
      if (reason)
        findings.push({ key, kind: 'insecure', detail: `${S.envVarInsecure} · ${reason}` });
    }
  }
  return { status: { key, kind: spec.kind, present, valid, secret: spec.secret }, findings };
}

/** Núcleo compartilhado: usado por inspect/validate/doctor. Nunca emite valores. */
export function analyzeEnv(
  repoDir: string,
  envKeys?: readonly string[],
  opts: ValidateOptions = {},
): EnvAnalysis {
  const schema = deriveSchema(repoDir, envKeys);
  const envPath = path.join(repoDir, '.env');
  const specByKey = new Map(schema.vars.map((v) => [v.key, v]));
  const envFile = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : null;
  const findings: Finding[] = [];
  const vars: VarStatus[] = [];
  const byKey = new Map<string, EnvEntry[]>();
  for (const e of envFile?.entries ?? []) {
    const list = byKey.get(e.key) ?? [];
    list.push(e);
    byKey.set(e.key, list);
  }
  const isSet = (key: string) => (byKey.get(key)?.at(-1)?.value ?? '') !== '';

  for (const spec of schema.vars) {
    const { status, findings: f } = analyzeKey(spec.key, spec, byKey.get(spec.key), {
      ...opts,
      baseDir: repoDir,
    });
    findings.push(...f);
    const empty = status.present && byKey.get(spec.key)!.at(-1)!.value === '';
    if (!status.present || empty) {
      const dep = spec.dependsOn && spec.dependsOn !== spec.key && isSet(spec.dependsOn);
      if (spec.required || dep) {
        findings.push({
          key: spec.key,
          kind: 'missing',
          detail: dep ? `${S.envVarMissing} · ${spec.dependsOn}` : S.envVarMissing,
        });
      }
    }
    vars.push(status);
  }

  const obsolete: string[] = [];
  for (const [key, entries] of byKey) {
    if (specByKey.has(key)) continue;
    if (!obsolete.includes(key)) obsolete.push(key);
    const pseudo = { kind: inferKind(key), secret: looksSecretKey(key) };
    const { status, findings: f } = analyzeKey(key, pseudo, entries, { ...opts, baseDir: repoDir });
    findings.push(...f);
    vars.push(status);
  }

  // Conflito determinístico entre portas: chaves *_PORT distintas com mesmo número.
  const ports = new Map<number, string>();
  for (const v of vars) {
    if (!v.present || v.kind !== 'port') continue;
    const n = Number(byKey.get(v.key)!.at(-1)!.value);
    if (!Number.isInteger(n)) continue;
    const other = ports.get(n);
    if (other) {
      findings.push({ key: v.key, kind: 'conflict', detail: `${S.envVarConflict} · ${other}` });
    } else {
      ports.set(n, v.key);
    }
  }

  const state = !envFile
    ? 'absent'
    : findings.some((f) => SEVERE.has(f.kind))
      ? 'partial'
      : 'complete';
  return { state, envFile, schema, findings, vars, obsolete };
}

export interface ValidateResult {
  ok: boolean;
  findings: Finding[];
  perVar: VarStatus[];
}

export function validateEnv(
  repoDir: string,
  envKeys?: readonly string[],
  opts: ValidateOptions = {},
): ValidateResult {
  const a = analyzeEnv(repoDir, envKeys, opts);
  const findings = a.envFile
    ? a.findings
    : [{ key: '.env', kind: 'missing' as const, detail: S.envFileAbsent }, ...a.findings];
  return { ok: !findings.some((f) => SEVERE.has(f.kind)), findings, perVar: a.vars };
}
