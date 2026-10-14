import { createHash } from 'node:crypto';
import { canonicalJson } from '../planner.js';

// ---------------------------------------------------------------------------
// §6.6 — forge/IntegrityManifest/v1.
// A manifest is a deterministic document: entries sorted by path, a sha256 per
// entry, and one overall digest over the canonical entry list. Verification
// never throws — missing or tampered payloads are reported, pathological
// entries (traversal, absolute paths) are refused before any read.
// ---------------------------------------------------------------------------

export const INTEGRITY_MANIFEST_SCHEMA = 'forge/IntegrityManifest/v1' as const;

export interface IntegrityEntry {
  /** Relative path inside the bundle, posix separators, no traversal. */
  readonly path: string;
  /** Byte length of the payload. */
  readonly bytes: number;
  readonly sha256: string;
}

export interface IntegrityManifest {
  readonly schema: typeof INTEGRITY_MANIFEST_SCHEMA;
  readonly generatedAt: string;
  readonly algorithm: 'sha256';
  /** sha256 over the canonical JSON of the sorted entry list. */
  readonly digest: string;
  readonly entries: readonly IntegrityEntry[];
}

export type ManifestInput =
  | { readonly path: string; readonly bytes: Uint8Array }
  | { readonly path: string; readonly content: string };

export type IntegrityVerification = { ok: true } | { ok: false; mismatches: string[] };

const SAFE_ENTRY_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Bundle paths are relative, dot-segment free, posix-separated. */
export function isSafeEntryPath(p: unknown): p is string {
  return typeof p === 'string' && SAFE_ENTRY_PATH.test(p) && !p.split('/').includes('..');
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function entryDigest(entries: readonly IntegrityEntry[]): string {
  return sha256(canonicalJson({ entries }));
}

export function buildIntegrityManifest(
  inputs: readonly ManifestInput[],
  opts?: { now?: string },
): IntegrityManifest {
  const byPath = new Map<string, IntegrityEntry>();
  for (const input of inputs) {
    const data = 'bytes' in input ? input.bytes : input.content;
    const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
    byPath.set(input.path, { path: input.path, bytes, sha256: sha256(data) });
  }
  const entries = [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    schema: INTEGRITY_MANIFEST_SCHEMA,
    generatedAt: opts?.now ?? new Date().toISOString(),
    algorithm: 'sha256',
    digest: entryDigest(entries),
    entries,
  };
}

/**
 * Verify a manifest against a `read(path)` resolver. Returns every entry that
 * is missing, has the wrong size/hash, or carries an unsafe path — plus
 * `<manifest>` when the document itself is malformed and `<digest>` when the
 * overall digest does not match the listed entries. Never throws.
 */
export function verifyIntegrityManifest(
  manifest: IntegrityManifest | null | undefined,
  read: (path: string) => Uint8Array | string | null | undefined,
): IntegrityVerification {
  if (
    !manifest ||
    manifest.schema !== INTEGRITY_MANIFEST_SCHEMA ||
    !Array.isArray(manifest.entries)
  ) {
    return { ok: false, mismatches: ['<manifest>'] };
  }
  const mismatches: string[] = [];
  for (const entry of manifest.entries) {
    if (!entry || !isSafeEntryPath(entry.path)) {
      mismatches.push(typeof entry?.path === 'string' ? entry.path : '<entry>');
      continue;
    }
    let data: Uint8Array | string | null | undefined;
    try {
      data = read(entry.path);
    } catch {
      data = null;
    }
    if (data === null || data === undefined) {
      mismatches.push(entry.path);
      continue;
    }
    const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
    if (bytes !== entry.bytes || sha256(data) !== entry.sha256) {
      mismatches.push(entry.path);
    }
  }
  if (entryDigest(manifest.entries) !== manifest.digest) mismatches.push('<digest>');
  return mismatches.length ? { ok: false, mismatches: mismatches.sort() } : { ok: true };
}
