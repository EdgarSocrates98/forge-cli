// compat.ts — forge/EcosystemCompatibility/v1 consumer (Cycle 8, §8.5).
//
// The manifest lives in the-forge checkout (<workspace>/the-forge/
// ecosystem-compatibility.json). The CLI *consumes* it — never duplicates
// compatibility logic into its own source of truth (spec cyc8-05).
// Absent manifest → 'unavailable', reported honestly, never assumed.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const ECOSYSTEM_SCHEMA = 'forge/EcosystemCompatibility/v1';

export type CompatVerdict = 'certified' | 'incompatible' | 'unknown';

export interface ComponentEntry {
  component: string;
  version: string;
  scheme?: 'semver' | 'pep440';
  source?: string;
  distribution?: string | null;
}

export interface ContractRangeEntry {
  family: string;
  contract: string | null;
  min_major?: number | null;
  max_major?: number | null;
}

export interface CompatManifest {
  schema: string;
  release: string;
  components: ComponentEntry[];
  contracts: ContractRangeEntry[];
  /** sha256 of the manifest file actually consulted — evidence, not trust. */
  fileSha256: string;
  /** absolute path the manifest was read from. */
  path: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Strict validation — mirrors install/compatibility.py (load_manifest
// strict=True). A manifest Python rejects must not silently parse here.
const RELEASE_ID_RE = /^[0-9]{4}\.(0[1-9]|1[0-2])$/;
const COMPONENT_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const FAMILY_ID_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const CONTRACT_REF_RE = /^(forge|theforge)\/[A-Z][A-Za-z0-9]*$/;
const PEP440_VERSION_RE = /^[0-9]+(\.[0-9]+)*((a|b|rc)[0-9]+)?(\.post[0-9]+)?$/;
// Mirrors theforge/contracts/semver.py exactly: numeric parts reject leading
// zeros, prerelease ids are non-empty and either numeric-without-leading-zero
// or alphanumeric-with-a-non-digit, build ids are non-empty alphanumerics.
const _SEMVER_NUM = '(?:0|[1-9][0-9]*)';
const _SEMVER_PRE_ID = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const _SEMVER_BUILD_ID = '[0-9A-Za-z-]+';
const SEMVER_VERSION_RE = new RegExp(
  `^${_SEMVER_NUM}\\.${_SEMVER_NUM}\\.${_SEMVER_NUM}` +
    `(?:-${_SEMVER_PRE_ID}(?:\\.${_SEMVER_PRE_ID})*)?` +
    `(?:\\+${_SEMVER_BUILD_ID}(?:\\.${_SEMVER_BUILD_ID})*)?$`,
);
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** Reasons `doc` is not a conforming manifest — empty when it is. */
export function manifestProblems(doc: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(doc)) return ['not an object'];
  if (doc.schema !== ECOSYSTEM_SCHEMA) problems.push(`schema ${String(doc.schema)}`);
  if (typeof doc.release !== 'string' || !RELEASE_ID_RE.test(doc.release)) {
    problems.push('release must be YYYY.MM');
  }
  if (typeof doc.created_at !== 'string' || !DATE_RE.test(doc.created_at)) {
    problems.push('created_at must be ISO date');
  }
  if (!Array.isArray(doc.components) || doc.components.length === 0) {
    problems.push('components must be non-empty');
    return problems;
  }
  if (!Array.isArray(doc.contracts)) {
    problems.push('contracts must be an array');
    return problems;
  }
  const seen = new Set<string>();
  for (const c of doc.components as unknown[]) {
    if (!isRecord(c)) {
      problems.push('component entry not an object');
      continue;
    }
    const id = String(c.component ?? '');
    if (!COMPONENT_ID_RE.test(id)) problems.push(`bad component id ${id}`);
    if (seen.has(id)) problems.push(`duplicate component ${id}`);
    seen.add(id);
    const scheme = c.scheme ?? 'semver';
    if (scheme !== 'semver' && scheme !== 'pep440') {
      problems.push(`${id}: bad scheme ${String(scheme)}`);
    }
    const version = String(c.version ?? '');
    if (version === '' || version === 'latest') {
      problems.push(`${id}: requires a pinned version`);
    } else if (scheme === 'pep440' ? !PEP440_VERSION_RE.test(version)
                                  : !SEMVER_VERSION_RE.test(version)) {
      problems.push(`${id}: version ${version} not ${String(scheme)}-shaped`);
    }
    if (typeof c.source !== 'string' || c.source === '') {
      problems.push(`${id}: requires 'source'`);
    }
  }
  const families = new Set<string>();
  for (const r of doc.contracts as unknown[]) {
    if (!isRecord(r)) {
      problems.push('contract entry not an object');
      continue;
    }
    const family = String(r.family ?? '');
    if (!FAMILY_ID_RE.test(family)) problems.push(`bad contract family ${family}`);
    if (families.has(family)) problems.push(`duplicate family ${family}`);
    families.add(family);
    if (r.contract === null || r.contract === undefined) {
      if ((r.min_major !== undefined && r.min_major !== null) ||
          (r.max_major !== undefined && r.max_major !== null)) {
        problems.push(`${family}: unversioned family must not carry ranges`);
      }
      continue;
    }
    if (typeof r.contract !== 'string' || !CONTRACT_REF_RE.test(r.contract)) {
      problems.push(`${family}: bad contract id`);
      continue;
    }
    const min = r.min_major, max = r.max_major;
    if (typeof min !== 'number' || typeof max !== 'number' || min < 1 || max < min) {
      problems.push(`${family}: invalid major window`);
    }
  }
  return problems;
}

/** Load and shape-check the committed manifest. Returns null when absent
 * or not conforming — callers report 'unavailable' explicitly. */
export function loadCompatManifest(manifestPath: string): CompatManifest | null {
  if (!existsSync(manifestPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (manifestProblems(doc).length > 0) return null;
  const d = doc as Record<string, unknown>;
  return {
    schema: d.schema as string,
    release: d.release as string,
    components: d.components as ComponentEntry[],
    contracts: d.contracts as ContractRangeEntry[],
    fileSha256: createHash('sha256').update(raw).digest('hex'),
    path: manifestPath,
  };
}

/** Default location: <workspace>/the-forge/ecosystem-compatibility.json. */
export function defaultManifestPath(workspaceDir: string): string {
  return path.join(workspaceDir, 'the-forge', 'ecosystem-compatibility.json');
}

/** Is `component@version` part of the certified combination? */
export function compatVerdict(
  manifest: CompatManifest,
  component: string,
  version: string,
): CompatVerdict {
  const entry = manifest.components.find((c) => c.component === component);
  if (!entry) return 'unknown';
  return entry.version === version ? 'certified' : 'incompatible';
}

/** Is `major` inside the declared window of `family`? (unversioned → false) */
export function contractSupported(
  manifest: CompatManifest,
  family: string,
  major: number,
): boolean {
  const r = manifest.contracts.find((c) => c.family === family);
  if (!r || r.min_major == null || r.max_major == null) return false;
  return r.min_major <= major && major <= r.max_major;
}

/** Declared version of an installed repo: package.json first, then
 * pyproject `version = "x.y.z"`. Null when neither declares one. */
export function readDeclaredVersion(repoDir: string): string | null {
  const pkg = path.join(repoDir, 'package.json');
  if (existsSync(pkg)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(pkg, 'utf-8'));
      if (isRecord(parsed) && typeof parsed.version === 'string' && parsed.version) {
        return parsed.version;
      }
    } catch {
      /* fall through */
    }
  }
  const pyproject = path.join(repoDir, 'pyproject.toml');
  if (existsSync(pyproject)) {
    try {
      // Scope to the [project] table — a [tool.*]/[build-system] section
      // declaring `version` earlier would shadow the real one otherwise.
      // The table is every line until the next section header or EOF.
      const table = /^\[project\][^\n]*\n((?:(?!\[)[^\n]*(?:\n|$))*)/m.exec(
        readFileSync(pyproject, 'utf-8'),
      );
      const m = table && /^version\s*=\s*"([^"]+)"/m.exec(table[1]);
      if (m) return m[1];
    } catch {
      /* fall through */
    }
  }
  return null;
}
