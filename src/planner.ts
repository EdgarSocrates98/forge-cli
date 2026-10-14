import { createHash } from 'node:crypto';
import type { ForgeRepo } from './types.js';

// ForgeOperationPlan/v1 emitter (contracts/CONTRACTS.md).
// A plan is a deterministic document: hash = sha256 of canonical JSON
// (sorted keys, no `hash` field). Mutating an approved plan changes the
// hash — verification refuses replays and expired plans.

export const PLAN_TTL_MS = 15 * 60 * 1000;

export type PlanActionKind =
  | 'clone'
  | 'sync'
  | 'env'
  | 'config'
  | 'prereq'
  | 'script'
  | 'npm'
  | 'verify'
  | 'native'
  | 'binary'
  | 'skills'
  | 'agents'
  | 'mcp'
  | 'host-integration'
  | 'backup'
  | 'uninstall';

// The six step types individually selectable in the wizard (§2.6).
export const SELECTABLE_STEPS = [
  'clone',
  'binary',
  'skills',
  'agents',
  'mcp',
  'host-integration',
] as const;
export type SelectableStep = (typeof SELECTABLE_STEPS)[number];

export interface PlanAction {
  kind: PlanActionKind;
  label: string;
  argv?: readonly string[];
  paths?: readonly string[];
  scripts?: readonly string[];
  reversible: boolean;
  preconditions?: readonly string[];
  /** efeitos que rollback NÃO cobre — honestidade obrigatória (§2.7). */
  non_reversible_effects?: readonly string[];
}

export interface PlanForge {
  forge_id: string;
  repo: string;
  target_dir: string;
  actions: PlanAction[];
}

export interface OperationPlan {
  schema: 'forge/ForgeOperationPlan/v1';
  plan_id: string;
  created_at: string;
  expires_at: string;
  source: 'cli' | 'portal' | 'wizard';
  forges: PlanForge[];
  native?: {
    scope?: string;
    profile?: string;
    components?: readonly string[];
    host?: string;
    approve: boolean;
  };
  selected_steps?: readonly SelectableStep[];
  hash: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] !== undefined) out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(doc: object): string {
  return JSON.stringify(canonicalize(doc));
}

export function planHash(plan: Omit<OperationPlan, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex');
}

export function buildPlan(input: {
  plan_id?: string;
  source?: OperationPlan['source'];
  forges: PlanForge[];
  native?: OperationPlan['native'];
  selected_steps?: readonly SelectableStep[];
  now?: Date;
  ttlMs?: number;
}): OperationPlan {
  const now = input.now ?? new Date();
  const ttl = input.ttlMs ?? PLAN_TTL_MS;
  const doc: Omit<OperationPlan, 'hash'> = {
    schema: 'forge/ForgeOperationPlan/v1',
    plan_id: input.plan_id ?? `plan-${now.toISOString().replace(/[:.]/g, '')}`,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl).toISOString(),
    source: input.source ?? 'cli',
    forges: input.forges,
    ...(input.native ? { native: input.native } : {}),
    ...(input.selected_steps ? { selected_steps: input.selected_steps } : {}),
  };
  return { ...doc, hash: planHash(doc) };
}

export type PlanVerification =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'hash-mismatch' | 'malformed' };

/** Verifica integridade + validade de um plano aprovado antes de executar. */
export function verifyPlan(plan: OperationPlan, now = new Date()): PlanVerification {
  if (!plan || typeof plan !== 'object' || typeof plan.hash !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  const { hash, ...doc } = plan;
  if (planHash(doc as Omit<OperationPlan, 'hash'>) !== hash) {
    return { ok: false, reason: 'hash-mismatch' };
  }
  if (Date.parse(plan.expires_at) <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

/** Ações do plano filtradas pelos passos selecionáveis — §2.6. */
export function filterSteps(
  actions: readonly PlanAction[],
  selected: readonly SelectableStep[] | undefined,
): PlanAction[] {
  if (!selected) return [...actions];
  const sel = new Set<PlanActionKind>(selected);
  // passos não-selecionáveis (env, prereq, verify…) sempre permanecem;
  // só os seis selecionáveis podem ser desligados.
  return actions.filter((a) => !SELECTABLE_STEPS.includes(a.kind as SelectableStep) || sel.has(a.kind as SelectableStep));
}

/** Resumo de mudanças previstas por Forja (para review antes de aprovar). */
export function predictedChanges(forge: PlanForge): {
  files: string[];
  commands: string[];
  reversible: boolean;
} {
  const files = new Set<string>();
  const commands: string[] = [];
  let reversible = true;
  for (const action of forge.actions) {
    for (const p of action.paths ?? []) files.add(p);
    if (action.argv?.length) commands.push(action.argv.join(' '));
    for (const s of action.scripts ?? []) commands.push(s);
    if (!action.reversible) reversible = false;
  }
  return { files: [...files].sort(), commands, reversible };
}
