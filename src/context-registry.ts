/**
 * Forge Context (install-2.0) — leitor read-only do registry de contexto.
 *
 * O installkit (`forge_context.py`, vendored em cada Forja) mantém
 * `.forge/context/registry.json` (`forge/context-registry/v1`) na raiz do
 * workspace com uma entrada por Forja instalada em scope project|workspace,
 * apontando para o manifest `forge/context/v1` em
 * `.forge/context/capabilities/<forge-id>.json`.
 *
 * Este módulo projeta os estados GRANULARES que o engine produz —
 * `state` do manifesto (available|degraded|unavailable) e
 * `health.status` (healthy|degraded|unverified|broken) — para as
 * superfícies de status/doctor. Tudo é bounded e tolerante: conteúdo
 * malformado é pulado por entrada, nunca inventado; a ausência do
 * registry é um estado nomeado ('absent'), não um erro.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const CONTEXT_DIR = path.join('.forge', 'context');
const REGISTRY_FILE = 'registry.json';
const REGISTRY_SCHEMA = 'forge/context-registry/v1';
const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ENTRIES = 256;
const MAX_REASONS = 16;
const MAX_REASON_CHARS = 200;

export type ManifestState = 'available' | 'degraded' | 'unavailable';
export type HealthStatus = 'healthy' | 'degraded' | 'unverified' | 'broken';

const MANIFEST_STATES = new Set<string>(['available', 'degraded', 'unavailable']);
const HEALTH_STATUSES = new Set<string>(['healthy', 'degraded', 'unverified', 'broken']);

export interface ContextForgeState {
  /** `state` do manifesto forge/context/v1 (fallback: entrada do registry). */
  state: ManifestState;
  /** `health.status` do manifesto — null quando o manifesto não pôde ser lido. */
  health: HealthStatus | null;
  /** `degraded_reasons` declaradas (bounded). */
  degradedReasons: string[];
  /** `scope` registrado na entrada — project|workspace|user (string crua). */
  scope: string | null;
  /** `kind` ecossistêmico opcional (install-2.0 §4.0) — string crua. */
  kind: string | null;
  /** Proveniência do estado projetado: manifesto lido ou só o registry. */
  source: 'manifest' | 'registry';
}

export interface ContextRegistry {
  /** 'absent' = sem `.forge/context/registry.json`; 'invalid' = presente mas ilegível/fora do schema. */
  status: 'absent' | 'invalid' | 'ok';
  /** Primeira razão estrutural quando 'invalid' (evidência, nunca stack). */
  detail?: string;
  /** Estados por forge_id — só entradas com `state` válido entram. */
  forges: Record<string, ContextForgeState>;
  /** Entradas puladas por malformação — honestidade sobre cobertura parcial. */
  skipped: number;
  truncated: boolean;
}

function readJsonBounded(file: string, maxBytes: number): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > maxBytes) {
      return { ok: false, error: `tamanho fora do limite (${st.size}B > ${maxBytes}B)` };
    }
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolve `rel` (POSIX relativo, como `capabilities/<fid>.json`) dentro do
 * diretório de contexto. Rejeita absoluto, `..`, NUL e escape do base dir —
 * o registry é conteúdo gerado mas tratado como não confiável.
 */
function resolveContextPath(contextDir: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  if (path.isAbsolute(rel) || rel.startsWith('~')) return null;
  const base = path.resolve(contextDir);
  const target = path.resolve(base, rel);
  const delta = path.relative(base, target);
  if (!delta || delta.startsWith('..') || path.isAbsolute(delta)) return null;
  return target;
}

function manifestStateFor(contextDir: string, rel: unknown): {
  state: ManifestState | null;
  health: HealthStatus | null;
  degradedReasons: string[];
} {
  const none = { state: null, health: null, degradedReasons: [] };
  const file = resolveContextPath(contextDir, rel);
  if (!file || !existsSync(file)) return none;
  const parsed = readJsonBounded(file, MAX_MANIFEST_BYTES);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return none;
  }
  const doc = parsed.value as Record<string, unknown>;
  const state = MANIFEST_STATES.has(doc.state as string) ? (doc.state as ManifestState) : null;
  const health =
    doc.health &&
    typeof doc.health === 'object' &&
    !Array.isArray(doc.health) &&
    HEALTH_STATUSES.has((doc.health as Record<string, unknown>).status as string)
      ? ((doc.health as Record<string, unknown>).status as HealthStatus)
      : null;
  const degradedReasons = Array.isArray(doc.degraded_reasons)
    ? doc.degraded_reasons
        .filter((r): r is string => typeof r === 'string')
        .slice(0, MAX_REASONS)
        .map((r) => r.slice(0, MAX_REASON_CHARS))
    : [];
  return { state, health, degradedReasons };
}

/**
 * Lê `.forge/context/registry.json` + os manifests referenciados.
 * Nunca lança — parcial é reportado com `skipped`/`truncated`.
 */
export function loadContextStates(rootInput: string): ContextRegistry {
  const root = path.resolve(rootInput);
  const contextDir = path.join(root, CONTEXT_DIR);
  const registryFile = path.join(contextDir, REGISTRY_FILE);
  if (!existsSync(registryFile)) {
    return { status: 'absent', forges: {}, skipped: 0, truncated: false };
  }
  const parsed = readJsonBounded(registryFile, MAX_REGISTRY_BYTES);
  if (!parsed.ok) {
    return { status: 'invalid', detail: `JSON ilegível: ${parsed.error}`, forges: {}, skipped: 0, truncated: false };
  }
  const doc = parsed.value;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { status: 'invalid', detail: 'registry não é um objeto JSON', forges: {}, skipped: 0, truncated: false };
  }
  const header = doc as Record<string, unknown>;
  if (header.schema !== REGISTRY_SCHEMA) {
    return {
      status: 'invalid',
      detail: `schema=${typeof header.schema === 'string' ? header.schema : 'ausente'} (esperado ${REGISTRY_SCHEMA})`,
      forges: {},
      skipped: 0,
      truncated: false,
    };
  }
  if (!Array.isArray(header.forges)) {
    return { status: 'invalid', detail: 'forges ausente ou não é array', forges: {}, skipped: 0, truncated: false };
  }
  const forges: Record<string, ContextForgeState> = {};
  let skipped = 0;
  const truncated = header.forges.length > MAX_ENTRIES;
  for (const raw of header.forges.slice(0, MAX_ENTRIES)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped += 1;
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const forgeId = typeof entry.forge_id === 'string' ? entry.forge_id : null;
    const entryState = MANIFEST_STATES.has(entry.state as string)
      ? (entry.state as ManifestState)
      : null;
    if (!forgeId || !entryState) {
      skipped += 1;
      continue;
    }
    const man = entry.manifest;
    const manPath =
      man && typeof man === 'object' && !Array.isArray(man)
        ? (man as Record<string, unknown>).path
        : undefined;
    const fromManifest = manifestStateFor(contextDir, manPath);
    forges[forgeId] = {
      state: fromManifest.state ?? entryState,
      health: fromManifest.health,
      degradedReasons: fromManifest.degradedReasons,
      scope: typeof entry.scope === 'string' ? entry.scope : null,
      kind: typeof entry.kind === 'string' ? entry.kind : null,
      source: fromManifest.state !== null ? 'manifest' : 'registry',
    };
  }
  return { status: 'ok', forges, skipped, truncated };
}
