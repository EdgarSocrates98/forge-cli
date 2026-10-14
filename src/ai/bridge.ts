/**
 * §6.3 AI mode — optional local bridge.
 *
 * The bridge is a user-configured, pre-authorized command (BYOK) resolved
 * ONLY from `cfg.command` — never hardcoded. Flow:
 *   sanitize context → assert no secrets → cache lookup → bound context
 *   bytes → write .forge-cli/ai/context-<digest>.json → spawn bridge →
 *   strict parse → sanitize proposal → deterministic catalog validation →
 *   cache store → display-only result.
 *
 * Model output is untrusted input: it is parsed and re-checked, and it is
 * NEVER executed. Proposal content is never passed to any spawn/run call.
 * Fully testable via injected `spawnFn`/`now` — tests spawn nothing real.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { artifactsRoot } from '../artifacts.js';
import { redactSecrets, writeFileAtomic } from '../safety.js';
import { errorDetail } from '../utils/system.js';
import { aiCacheGet, aiCacheKey, aiCacheSet } from './cache.js';
import {
  isAiProposalShape,
  parseProposal,
  validateProposal,
  type AiRefCatalog,
} from './proposal.js';
import { assertNoSecrets, sanitizeForAi } from './sanitize.js';
import type { AiBridgeConfig, AiRequest, AiResult } from './types.js';

/** What a bridge invocation returns — injected fakes use the same shape. */
export interface AiSpawnResult {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode: number;
  readonly timedOut?: boolean;
}

export type AiSpawnFn = (
  argv: readonly string[],
  opts: { readonly timeoutMs: number; readonly cwd: string },
) => Promise<AiSpawnResult>;

export interface AiBridgeDeps {
  /** Known entities — every proposal `ref` is re-checked against this. */
  readonly catalog: AiRefCatalog;
  /** Injectable spawn — tests MUST use this; the default uses execa. */
  readonly spawnFn?: AiSpawnFn;
  /** Injectable clock for deterministic cache/expiry tests. */
  readonly now?: () => number;
  /** State root — `.forge-cli/ai/` lives under it. Defaults to cwd. */
  readonly rootDir?: string;
}

const DETAIL_CAP = 300;

/** Default spawn via execa — the only place a subprocess can start. */
const execaSpawn: AiSpawnFn = async (argv, opts) => {
  const [bin, ...args] = argv;
  const res = await execa(bin, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    reject: false,
  });
  return {
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : res.shortMessage,
    exitCode: res.exitCode ?? 1,
    timedOut: res.timedOut === true,
  };
};

function cap(detail: string): string {
  const trimmed = detail.trim();
  return trimmed.length > DETAIL_CAP ? `${trimmed.slice(0, DETAIL_CAP)}…` : trimmed;
}

/**
 * Run one AI task through the configured bridge. Display-only: the returned
 * proposal is data, never a command — nothing from it is spawned or run.
 */
export async function runAiBridge(
  req: AiRequest,
  cfg: AiBridgeConfig,
  deps: AiBridgeDeps,
): Promise<AiResult> {
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  const command = cfg.command.filter((part) => part.trim().length > 0);
  if (command.length === 0) return { ok: false, reason: 'no-bridge' };

  const context = sanitizeForAi(req.context);
  const leaks = assertNoSecrets(context);
  if (leaks.length > 0) {
    return { ok: false, reason: 'bridge-error', detail: `context-not-clean: ${leaks.join(',')}` };
  }

  const rootDir = deps.rootDir ?? process.cwd();
  const now = deps.now ?? (() => Date.now());
  const payload = { task: req.task, context };
  const digest = aiCacheKey(payload);

  if (cfg.cacheTtlMs > 0) {
    const hit = aiCacheGet(rootDir, digest, { ttlMs: cfg.cacheTtlMs, now: now() });
    if (hit) {
      // Catalogs may have changed since the entry was stored — re-check.
      const revalidated = validateProposal(hit, deps.catalog);
      if (revalidated.ok) return { ok: true, proposal: revalidated.proposal, cached: true };
    }
  }

  const body = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(body, 'utf8') > cfg.maxContextBytes) {
    return { ok: false, reason: 'bridge-error', detail: 'context-too-large' };
  }

  const aiDir = path.join(artifactsRoot(rootDir), 'ai');
  mkdirSync(aiDir, { recursive: true });
  const contextFile = path.join(aiDir, `context-${digest}.json`);
  writeFileAtomic(contextFile, body);

  const argv = command.map((part) => (part === '{context}' ? contextFile : part));
  if (!command.includes('{context}')) argv.push(contextFile);

  const spawn = deps.spawnFn ?? execaSpawn;
  let res: AiSpawnResult;
  try {
    res = await spawn(argv, { timeoutMs: cfg.timeoutMs, cwd: rootDir });
  } catch (error) {
    return { ok: false, reason: 'bridge-error', detail: cap(errorDetail(error)) };
  }
  if (res.timedOut) return { ok: false, reason: 'timeout' };
  if (res.exitCode !== 0) {
    const detail = redactSecrets(res.stderr?.trim() || `exit ${res.exitCode}`);
    return { ok: false, reason: 'bridge-error', detail: cap(detail) };
  }

  const parsed = parseProposal(res.stdout);
  if ('error' in parsed) return { ok: false, reason: 'invalid-output', detail: parsed.error };

  // Model output is untrusted: sanitize it too, and reject anything that
  // lost required fields or still carries secret-looking content.
  const clean = sanitizeForAi(parsed);
  if (!isAiProposalShape(clean)) {
    return { ok: false, reason: 'invalid-output', detail: 'proposal-redacted-fields' };
  }
  const cleanLeaks = assertNoSecrets(clean);
  if (cleanLeaks.length > 0) {
    return {
      ok: false,
      reason: 'invalid-output',
      detail: `proposal-leaks-secrets: ${cleanLeaks.join(',')}`,
    };
  }

  const valid = validateProposal(clean, deps.catalog);
  if (!valid.ok) {
    return { ok: false, reason: 'invalid-output', detail: cap(valid.reasons.join('; ')) };
  }

  if (cfg.cacheTtlMs > 0) {
    aiCacheSet(rootDir, digest, valid.proposal, { now: now() });
  }
  return { ok: true, proposal: valid.proposal, cached: false };
}
