/**
 * §6 Forge Intelligence Engine — shared contracts.
 *
 * Every intelligence answer carries evidence + confidence + explanation.
 * Deterministic paths never require a key, a network, or a model.
 */

export type Confidence = 'high' | 'medium' | 'low' | 'unknown';

export interface Evidence {
  /** What was observed — path, probe, manifest field, check id. */
  readonly source: string;
  /** The observed fact, already redacted. */
  readonly fact: string;
}

export interface IntelAnswer {
  /** The question being answered (echoed for receipts/context). */
  readonly question: string;
  /** Deterministic answer text — never model-generated prose. */
  readonly answer: string;
  readonly confidence: Confidence;
  readonly evidence: readonly Evidence[];
  /** Why this answer — rule ids / reasoning chain, deterministic. */
  readonly explanation: readonly string[];
  /** What we could NOT verify — honest limits. */
  readonly limitations: readonly string[];
}

/** §6.4 bounded structured context — the ONLY thing AI mode may see. */
export const FORGE_CONTEXT_SCHEMA = 'forge/ForgeContext/v1' as const;

export interface ForgeContext {
  readonly schema: typeof FORGE_CONTEXT_SCHEMA;
  readonly generatedAt: string;
  readonly stack: {
    readonly detected: readonly string[];
    readonly runtimes: Record<string, string>;
  };
  readonly capabilities: Record<string, string>;
  readonly forjas: ReadonlyArray<{
    readonly name: string;
    readonly state: string;
    readonly version: string | null;
  }>;
  readonly hosts: ReadonlyArray<{
    readonly id: string;
    readonly state: string;
    readonly auth: 'true' | 'false' | 'unknown';
  }>;
  /** Non-secret config only — denylist-filtered, redacted values. */
  readonly config: Record<string, string>;
  readonly diagnostics: ReadonlyArray<{
    readonly id: string;
    readonly result: string;
    readonly severity: string;
  }>;
  readonly plans: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
  readonly budget: { readonly bytes: number; readonly truncated: boolean };
}

/** §6.5 predictive compatibility finding — evidence + version + certainty. */
export type Certainty = 'high' | 'medium' | 'low';

export type PredictionKind =
  | 'breaking-change'
  | 'runtime-incompat'
  | 'host-version'
  | 'obsolete'
  | 'renamed-var'
  | 'schema-change'
  | 'install-conflict';

export interface Prediction {
  readonly id: string;
  readonly kind: PredictionKind;
  readonly subject: string;
  readonly certainty: Certainty;
  /** Version the prediction is anchored to (from/to where applicable). */
  readonly version: { readonly from: string | null; readonly to: string | null };
  readonly evidence: readonly Evidence[];
  readonly explanation: string;
}
