/**
 * §6.3 AI mode — digest-keyed proposal cache.
 *
 * Lives under `.forge-cli/ai/cache/`. Entries hold ONLY sanitized,
 * schema-validated proposals keyed by the sha256 of the canonical
 * `{task, context}` payload. TTL is enforced on read; a hard entry cap
 * evicts the oldest entries on write. Everything is deterministic — `now`
 * is injectable.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { artifactsRoot } from '../artifacts.js';
import { writeFileAtomic } from '../safety.js';
import { isAiProposalShape } from './proposal.js';
import type { AiProposal } from './types.js';

export const AI_CACHE_MAX_ENTRIES = 32;

const KEY_RE = /^[a-f0-9]{64}$/;

interface CacheEntry {
  readonly at: number;
  readonly proposal: AiProposal;
}

export function aiCacheDir(rootDir: string): string {
  return path.join(artifactsRoot(rootDir), 'ai', 'cache');
}

/** Canonical JSON (sorted keys) so equivalent payloads hash identically. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 of the canonical sanitized payload ({task, context}). */
export function aiCacheKey(payload: unknown): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

function entryFile(rootDir: string, key: string): string | null {
  if (!KEY_RE.test(key)) return null;
  return path.join(aiCacheDir(rootDir), `${key}.json`);
}

/** Cache read honoring ttl. Returns null on miss, expiry or corrupt entry. */
export function aiCacheGet(
  rootDir: string,
  key: string,
  opts: { readonly ttlMs: number; readonly now?: number },
): AiProposal | null {
  if (opts.ttlMs <= 0) return null;
  const file = entryFile(rootDir, key);
  if (!file || !existsSync(file)) return null;
  try {
    const entry = JSON.parse(readFileSync(file, 'utf8')) as CacheEntry;
    const now = opts.now ?? Date.now();
    if (typeof entry?.at !== 'number' || now - entry.at > opts.ttlMs || now < entry.at) {
      return null;
    }
    return isAiProposalShape(entry.proposal) ? entry.proposal : null;
  } catch {
    return null;
  }
}

/** Cache write + bounded eviction (oldest entries first, filename tiebreak). */
export function aiCacheSet(
  rootDir: string,
  key: string,
  proposal: AiProposal,
  opts: { readonly now?: number; readonly maxEntries?: number } = {},
): void {
  const file = entryFile(rootDir, key);
  if (!file) return;
  const dir = aiCacheDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const entry: CacheEntry = { at: opts.now ?? Date.now(), proposal };
  writeFileAtomic(file, JSON.stringify(entry));
  evictOldest(dir, opts.maxEntries ?? AI_CACHE_MAX_ENTRIES);
}

function evictOldest(dir: string, maxEntries: number): void {
  if (maxEntries < 1) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => KEY_RE.test(path.basename(f, '.json')));
  } catch {
    return;
  }
  if (files.length <= maxEntries) return;
  const aged = files
    .map((file) => ({ file, at: entryAge(path.join(dir, file)) }))
    .sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
  for (const { file } of aged.slice(0, aged.length - maxEntries)) {
    rmSync(path.join(dir, file), { force: true });
  }
}

function entryAge(file: string): number {
  try {
    const entry = JSON.parse(readFileSync(file, 'utf8')) as CacheEntry;
    return typeof entry?.at === 'number' ? entry.at : 0;
  } catch {
    return 0;
  }
}
