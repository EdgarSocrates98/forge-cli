/**
 * §6.3 AI-Assisted Mode — contracts.
 *
 * Hard rules (spec 007 §6.3/§8):
 *  - opt-in only: nothing here runs unless `forge config ai on`
 *  - BYOK / pre-authorized local bridge command — never a hardwired provider
 *  - model output is UNTRUSTED input: parsed + schema-validated +
 *    deterministically re-checked before any use; NEVER executed
 *  - secrets are redacted BEFORE any prompt is built (sanitize.ts)
 */

import type { ForgeContext } from '../intel/contracts.js';

/** A model proposal — the only shape AI mode may return. */
export const AI_PROPOSAL_SCHEMA = 'forge/AiProposal/v1' as const;

export interface AiProposal {
  readonly schema: typeof AI_PROPOSAL_SCHEMA;
  readonly task:
    'explain-error' | 'summarize-diagnosis' | 'recommend-alternatives' | 'suggest-tasks';
  readonly summary: string;
  readonly items: ReadonlyArray<{
    readonly title: string;
    readonly detail: string;
    /** Optional referenced entity — must exist in our catalog to be shown. */
    readonly ref?: string;
  }>;
}

/**
 * Pre-authorized local AI bridge — a user-configured command (e.g.
 * `claude -p`, `codex exec`, or an approved proxy) invoked via spawn.
 * No network imports in src/: the bridge process owns transport.
 */
export interface AiBridgeConfig {
  readonly enabled: boolean;
  /** Command + args template; `{context}` is replaced by context file path. */
  readonly command: readonly string[];
  /** Hard cap on context bytes sent to the bridge. */
  readonly maxContextBytes: number;
  /** Hard cap on bridge wall-time. */
  readonly timeoutMs: number;
  /** Cache TTL for identical context digests (0 disables). */
  readonly cacheTtlMs: number;
}

export interface AiRequest {
  readonly task: AiProposal['task'];
  readonly context: ForgeContext;
}

export type AiResult =
  | { readonly ok: true; readonly proposal: AiProposal; readonly cached: boolean }
  | {
      readonly ok: false;
      readonly reason: 'disabled' | 'no-bridge' | 'invalid-output' | 'bridge-error' | 'timeout';
      readonly detail?: string;
    };
