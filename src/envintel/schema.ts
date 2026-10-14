import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ENV_KEY_RE, parseEnv } from './parse.js';
import type { EnvSchema, VarKind, VarSpec } from './model.js';

/**
 * Inferência determinística de kind a partir do nome da chave.
 * Ordem importa: PORT (segmento exato) → URL/ENDPOINT → DIR/_PATH/FILE →
 * segredos → booleanos → número via default → string.
 */
const SECRET_RE = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/;

const KIND_RULES: Array<{ kind: VarKind; re: RegExp }> = [
  { kind: 'port', re: /(^|_)PORT($|_)/ },
  { kind: 'url', re: /(URL|ENDPOINT|URI)(_|$)/ },
  { kind: 'path', re: /DIR|_PATH|^PATH_|FILE/ },
  { kind: 'secret', re: SECRET_RE },
  { kind: 'bool', re: /ENABLE|FLAG|DEBUG|_BOOL/ },
];

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

export function looksSecretKey(key: string): boolean {
  return SECRET_RE.test(key);
}

export function inferKind(key: string, exampleValue?: string): VarKind {
  for (const rule of KIND_RULES) {
    if (rule.re.test(key)) return rule.kind;
  }
  if (exampleValue !== undefined && NUMERIC_RE.test(exampleValue.trim())) return 'number';
  return 'string';
}

const PLACEHOLDER_RE =
  /^(changeme|change[-_]me|xxx+|your[-_][a-z0-9_-]*|todo|tbd|fixme|placeholder|example|sample|dummy|test|null|none|secret|password)$/i;

/** Placeholders conhecidos e templates — classificado por padrão, nunca por valor real. */
export function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (/^<[^>]*>$/.test(v) || /^\$\{[^}]*\}$/.test(v) || /^\{\{.*\}\}$/.test(v)) return true;
  return PLACEHOLDER_RE.test(v);
}

interface RawVar {
  key?: unknown;
  kind?: unknown;
  required?: unknown;
  secret?: unknown;
  default?: unknown;
  choices?: unknown;
  pattern?: unknown;
  dependsOn?: unknown;
}

const KINDS = new Set<VarKind>([
  'secret',
  'path',
  'port',
  'url',
  'bool',
  'number',
  'string',
  'enum',
]);

function validPattern(p: unknown): p is string {
  if (typeof p !== 'string' || !p) return false;
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
}

/** forge.env.schema.json é não-confiável: entradas malformadas são descartadas, nunca quebram. */
function readSchemaFile(repoDir: string): RawVar[] {
  const file = path.join(repoDir, 'forge.env.schema.json');
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { vars?: unknown }).vars)
        ? ((parsed as { vars: unknown[] }).vars as RawVar[])
        : parsed && typeof parsed === 'object'
          ? Object.entries(parsed as Record<string, unknown>).map(([key, v]) => ({
              key,
              ...(v && typeof v === 'object' ? (v as Record<string, unknown>) : {}),
            }))
          : [];
    return list.filter((v): v is RawVar => v !== null && typeof v === 'object');
  } catch {
    return [];
  }
}

/**
 * Esquema derivado de `.env.example` + `envKeys` do catálogo + `forge.env.schema.json`.
 * required = declarado de alguma fonte e sem default utilizável no exemplo
 * (schema.json pode forçar via `required` explícito).
 */
export function deriveSchema(repoDir: string, envKeys?: readonly string[]): EnvSchema {
  const specs = new Map<string, VarSpec>();
  const exampleFile = path.join(repoDir, '.env.example');
  if (existsSync(exampleFile)) {
    for (const entry of parseEnv(readFileSync(exampleFile, 'utf8')).entries) {
      if (specs.has(entry.key)) continue;
      const kind = inferKind(entry.key, entry.value || undefined);
      const secret = kind === 'secret';
      const usable = entry.value !== '' && !isPlaceholderValue(entry.value);
      specs.set(entry.key, {
        key: entry.key,
        kind,
        required: !usable,
        secret,
        // Defaults de segredos jamais são propagados para o esquema.
        ...(usable && !secret ? { default: entry.value } : {}),
      });
    }
  }
  for (const key of envKeys ?? []) {
    if (!ENV_KEY_RE.test(key) || specs.has(key)) continue;
    const kind = inferKind(key);
    specs.set(key, { key, kind, required: true, secret: kind === 'secret' });
  }
  for (const raw of readSchemaFile(repoDir)) {
    if (typeof raw.key !== 'string' || !ENV_KEY_RE.test(raw.key)) continue;
    const existing = specs.get(raw.key);
    const kind =
      typeof raw.kind === 'string' && KINDS.has(raw.kind as VarKind)
        ? (raw.kind as VarKind)
        : (existing?.kind ?? inferKind(raw.key));
    const secret =
      typeof raw.secret === 'boolean' ? raw.secret : (existing?.secret ?? kind === 'secret');
    const merged: VarSpec = {
      key: raw.key,
      kind,
      required: typeof raw.required === 'boolean' ? raw.required : (existing?.required ?? false),
      secret,
      ...(typeof raw.default === 'string' && !secret
        ? { default: raw.default }
        : existing?.default !== undefined
          ? { default: existing.default }
          : {}),
      ...(Array.isArray(raw.choices) && raw.choices.every((c) => typeof c === 'string')
        ? { choices: raw.choices as string[] }
        : existing?.choices !== undefined
          ? { choices: existing.choices }
          : {}),
      ...(validPattern(raw.pattern)
        ? { pattern: raw.pattern }
        : existing?.pattern !== undefined
          ? { pattern: existing.pattern }
          : {}),
      ...(typeof raw.dependsOn === 'string' && ENV_KEY_RE.test(raw.dependsOn)
        ? { dependsOn: raw.dependsOn }
        : existing?.dependsOn !== undefined
          ? { dependsOn: existing.dependsOn }
          : {}),
    };
    if (kind === 'enum' && !merged.choices?.length) merged.kind = 'string';
    specs.set(raw.key, merged);
  }
  return { vars: [...specs.values()] };
}
