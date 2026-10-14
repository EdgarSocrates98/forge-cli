/**
 * §6.3 AI mode — proposal parsing and deterministic re-validation.
 *
 * Model output is UNTRUSTED input. This module turns raw bridge stdout into
 * a display-only AiProposal: strict JSON parse, schema check (exact task
 * enum, typed fields), then a deterministic catalog re-check — every `ref`
 * must name something we already know. Unknown refs are rejected, never
 * guessed.
 *
 * There is intentionally NO execution capability here: a proposal is data
 * for display, never a command.
 */

import { AI_PROPOSAL_SCHEMA, type AiProposal } from './types.js';

export const AI_TASKS = [
  'explain-error',
  'recommend-alternatives',
  'suggest-tasks',
  'summarize-diagnosis',
] as const satisfies readonly AiProposal['task'][];

/** Known entities a proposal `ref` may point at — supplied by the caller. */
export interface AiRefCatalog {
  readonly forjas: readonly string[];
  readonly hosts: readonly string[];
  readonly verbs: readonly string[];
}

export type AiParseResult = AiProposal | { readonly error: string };

export type AiValidation =
  | { readonly ok: true; readonly proposal: AiProposal }
  | { readonly ok: false; readonly reasons: string[] };

const REF_KINDS = ['forja', 'host', 'verb'] as const;
type RefKind = (typeof REF_KINDS)[number];

function isTask(value: unknown): value is AiProposal['task'] {
  return typeof value === 'string' && (AI_TASKS as readonly string[]).includes(value);
}

function isItem(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.title !== 'string' || !item.title.trim()) return false;
  if (typeof item.detail !== 'string') return false;
  if (item.ref !== undefined && (typeof item.ref !== 'string' || !item.ref.trim())) return false;
  return true;
}

/** Structural check of an already-parsed value against forge/AiProposal/v1. */
export function isAiProposalShape(value: unknown): value is AiProposal {
  return checkShape(value) === true;
}

function checkShape(value: unknown): true | { readonly error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'not-an-object' };
  }
  const p = value as Record<string, unknown>;
  if (p.schema !== AI_PROPOSAL_SCHEMA) return { error: 'bad-schema' };
  if (!isTask(p.task)) return { error: 'bad-task' };
  if (typeof p.summary !== 'string' || !p.summary.trim()) return { error: 'bad-summary' };
  if (!Array.isArray(p.items)) return { error: 'bad-items' };
  for (let i = 0; i < p.items.length; i++) {
    if (!isItem(p.items[i])) return { error: `bad-item:${i}` };
  }
  return true;
}

/** Strict JSON parse + schema check. Returns the proposal or {error}. */
export function parseProposal(raw: string): AiParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'invalid-json' };
  }
  const shape = checkShape(parsed);
  return shape === true ? (parsed as AiProposal) : shape;
}

function refKnown(ref: string, known: Record<RefKind, ReadonlySet<string>>): boolean {
  const sep = ref.indexOf(':');
  if (sep <= 0) {
    return known.forja.has(ref) || known.host.has(ref) || known.verb.has(ref);
  }
  const kind = ref.slice(0, sep);
  const name = ref.slice(sep + 1);
  if (!(REF_KINDS as readonly string[]).includes(kind)) return false;
  return name.length > 0 && known[kind as RefKind].has(name);
}

/**
 * Deterministic re-validation: every item `ref` must resolve against the
 * supplied catalog (bare name or `forja:|host:|verb:` prefixed). Unknown refs
 * are rejected — the model never gets to invent entities.
 */
export function validateProposal(proposal: AiProposal, catalog: AiRefCatalog): AiValidation {
  const known: Record<RefKind, ReadonlySet<string>> = {
    forja: new Set(catalog.forjas),
    host: new Set(catalog.hosts),
    verb: new Set(catalog.verbs),
  };
  const reasons = new Set<string>();
  proposal.items.forEach((item, index) => {
    const ref = item.ref;
    if (ref === undefined) return;
    if (!refKnown(ref, known)) {
      reasons.add(`item ${index}: unknown ref "${ref}"`);
    }
  });
  if (reasons.size) return { ok: false, reasons: [...reasons].sort() };
  return { ok: true, proposal };
}
