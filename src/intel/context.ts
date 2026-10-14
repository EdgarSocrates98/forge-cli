/**
 * §6.4 — bounded structured context (forge/ForgeContext/v1).
 *
 * This is the ONLY payload AI mode may see. It is assembled exclusively
 * from deterministic facts (discovery report, manifests, host adapters,
 * doctor2 checks, plan ids) — never raw .env values, logs or schemas.
 *
 * Secrets are provably absent by construction:
 *  - config keys matching the denylist are dropped outright;
 *  - any surviving value that `redactSecrets` would change is dropped too
 *    (a secret-looking value under an innocuous key never leaks);
 *  - manifest-derived strings (versions, capability ids/states) go through
 *    the same filter — an untrusted forge.json cannot smuggle a token in.
 *
 * Budget: the serialized payload is capped at maxBytes (default 8 KiB).
 * When over, the lowest-priority sections are emptied first, in a fixed
 * order, and `budget.truncated` is set — never silently cut mid-field.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { artifactsRoot } from '../artifacts.js';
import { discoverEnvironment } from '../discovery.js';
import { runDoctor2 } from '../doctor2/index.js';
import { hostAdapters } from '../hosts/index.js';
import type { HostAdapter, HostDetection } from '../hosts/types.js';
import { verifyPlan, type OperationPlan } from '../planner.js';
import { redactSecrets } from '../safety.js';
import type { ForgeRepo } from '../types.js';
import { FORGE_CONTEXT_SCHEMA, type ForgeContext } from './contracts.js';

export const DEFAULT_CONTEXT_BYTES = 8192;
export const DEFAULT_MAX_DIAGNOSTICS = 10;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PLAN_FILES = 32;
const MAX_CAPABILITY_KEYS = 64;

export interface ForgeContextOptions {
  /** Serialized payload cap in bytes (default {@link DEFAULT_CONTEXT_BYTES}). */
  maxBytes?: number;
  /** Injected ISO timestamp — `generatedAt` and plan expiry come from it. */
  now?: string;
  /** Home dir for host adapters / doctor2 (default: os.homedir()). */
  home?: string;
  /** Host adapters — tests inject hostAdapters(fakeProbe). */
  adapters?: readonly HostAdapter[];
  /** Top-N doctor2 checks kept in `diagnostics` (default 10). */
  maxDiagnostics?: number;
  /** Skip host probing entirely (empty hosts section). */
  skipHosts?: boolean;
}

// ---------------------------------------------------------------------------
// Secret hygiene — denylist on key names, redactSecrets on every value.
// ---------------------------------------------------------------------------

const SECRET_KEY_RE = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH/i;

/** Code-unit compare — identical order on every machine (localeCompare isn't). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Secret-shaped values redactSecrets doesn't need a key name for:
 * token prefixes (GitHub, OpenAI/Anthropic-style sk-*, AWS AKIA, Slack xox*)
 * and JWTs (eyJ…). A value matching this never enters the context, even
 * under an innocuous key name.
 */
const SECRET_VALUE_RE =
  /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-(?:live|test|proj|ant)-[A-Za-z0-9_-]{6,}|AKIA[0-9A-Z]{16}|xox[bapors]-[A-Za-z0-9-]{6,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/;

/** Scalar → string, or null when non-scalar, redactable, or secret-shaped. */
function safeScalar(value: unknown): string | null {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  if (SECRET_VALUE_RE.test(value)) return null;
  return redactSecrets(value) === value ? value : null;
}

/** forge-cli.config.json — only non-secret scalar keys survive. */
function safeConfig(targetDir: string): Record<string, string> {
  const file = path.join(targetDir, 'forge-cli.config.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(raw as Record<string, unknown>).sort()) {
    if (SECRET_KEY_RE.test(key)) continue;
    const value = safeScalar((raw as Record<string, unknown>)[key]);
    if (value !== null) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manifest reads (untrusted input — bounded, filtered)
// ---------------------------------------------------------------------------

function readManifestObject(repoDir: string): Record<string, unknown> | null {
  const file = path.join(repoDir, 'forge.json');
  try {
    if (!existsSync(file) || statSync(file).size > MAX_MANIFEST_BYTES) return null;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function manifestVersion(repoDir: string): string | null {
  const v = readManifestObject(repoDir)?.version;
  return typeof v === 'string' ? safeScalar(v) : null;
}

function manifestCapabilities(
  repoDir: string,
  repoName: string,
  out: Record<string, string>,
): void {
  const caps = readManifestObject(repoDir)?.capabilities;
  if (Array.isArray(caps)) {
    for (const c of caps) {
      if (Object.keys(out).length >= MAX_CAPABILITY_KEYS) return;
      if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
      const id = (c as Record<string, unknown>).id;
      if (typeof id !== 'string' || SECRET_KEY_RE.test(id)) continue;
      const state = safeScalar((c as Record<string, unknown>).state);
      if (state !== null) out[`${repoName}.${id}`] = state;
    }
    return;
  }
  if (caps && typeof caps === 'object') {
    for (const id of Object.keys(caps).sort()) {
      if (Object.keys(out).length >= MAX_CAPABILITY_KEYS) return;
      if (SECRET_KEY_RE.test(id)) continue;
      const state = safeScalar((caps as Record<string, unknown>)[id]);
      if (state !== null) out[`${repoName}.${id}`] = state;
    }
  }
}

// ---------------------------------------------------------------------------
// Active plans — hash-verified, unexpired ForgeOperationPlan files only.
// ---------------------------------------------------------------------------

function activePlans(targetDir: string, nowIso: string): { id: string; kind: string }[] {
  const dir = path.join(artifactsRoot(targetDir), 'plans');
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
  const now = new Date(Number.isFinite(Date.parse(nowIso)) ? Date.parse(nowIso) : 0);
  const out: { id: string; kind: string }[] = [];
  for (const name of names.slice(0, MAX_PLAN_FILES)) {
    try {
      const doc: unknown = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
      const plan = doc as Partial<OperationPlan>;
      if (typeof plan.plan_id !== 'string' || !plan.plan_id) continue;
      // "active" means provable: hash-verified and not expired at `now`.
      if (!verifyPlan(plan as OperationPlan, now).ok) continue;
      const kind = typeof plan.source === 'string' ? plan.source : 'operation';
      out.push({ id: plan.plan_id, kind });
    } catch {
      continue;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diagnostics — top-N doctor2 checks, severity-first deterministic order.
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
const RESULT_RANK: Record<string, number> = { fail: 0, warn: 1, unverified: 2, skip: 3, pass: 4 };

async function collectDiagnostics(
  targetDir: string,
  repos: readonly ForgeRepo[],
  nowIso: string,
  opts: ForgeContextOptions,
): Promise<ForgeContext['diagnostics'][number][]> {
  const report = await runDoctor2(targetDir, {
    now: () => nowIso,
    catalog: repos,
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
  });
  const cap = Math.max(0, opts.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS);
  return [...report.checks]
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
        (RESULT_RANK[a.result] ?? 9) - (RESULT_RANK[b.result] ?? 9) ||
        cmp(a.id, b.id),
    )
    .slice(0, cap)
    .map((c) => ({ id: c.id, result: c.result, severity: c.severity }));
}

// ---------------------------------------------------------------------------
// Hosts — adapter detection, auth tri-state, never a token.
// ---------------------------------------------------------------------------

const AUTH_TRI: Record<HostDetection['auth'], 'true' | 'false' | 'unknown'> = {
  verified: 'true',
  absent: 'false',
  unknown: 'unknown',
};

async function collectHosts(opts: ForgeContextOptions): Promise<ForgeContext['hosts'][number][]> {
  if (opts.skipHosts) return [];
  const adapters = opts.adapters ?? hostAdapters();
  const detections = await Promise.all(
    [...adapters]
      .sort((a, b) => cmp(a.id, b.id))
      .map(async (a) => {
        try {
          return await a.detect(opts.home);
        } catch {
          return null;
        }
      }),
  );
  return detections
    .filter((d): d is HostDetection => d !== null)
    .map((d) => ({ id: d.host, state: d.state, auth: AUTH_TRI[d.auth] }));
}

// ---------------------------------------------------------------------------
// §6.4 — the builder
// ---------------------------------------------------------------------------

export async function buildForgeContext(
  targetDir: string,
  repos: readonly ForgeRepo[],
  opts: ForgeContextOptions = {},
): Promise<ForgeContext> {
  const nowIso = opts.now ?? new Date().toISOString();
  const report = await discoverEnvironment(targetDir, {
    now: () => {
      const t = Date.parse(nowIso);
      return Number.isFinite(t) ? t : 0;
    },
  });
  const [diagnostics, hosts] = await Promise.all([
    collectDiagnostics(targetDir, repos, nowIso, opts),
    collectHosts(opts),
  ]);

  const runtimes: Record<string, string> = {};
  for (const t of report.tools) {
    if (t.found) runtimes[t.name] = t.version ?? 'present';
  }
  const byName = new Map(report.forges.map((f) => [f.name, f]));
  const capabilities: Record<string, string> = {};
  const forjas = [...repos]
    .sort((a, b) => cmp(a.name, b.name))
    .map((repo) => {
      const dir = path.join(targetDir, repo.name);
      manifestCapabilities(dir, repo.name, capabilities);
      const discovered = byName.get(repo.name);
      return {
        name: repo.name,
        state: discovered?.state ?? 'unknown',
        version: manifestVersion(dir),
      };
    });

  // Mutable draft — section droppers empty whole sections, never partial fields.
  const draft = {
    schema: FORGE_CONTEXT_SCHEMA,
    generatedAt: nowIso,
    stack: { detected: [...report.signals], runtimes } as ForgeContext['stack'],
    capabilities,
    forjas,
    hosts,
    config: safeConfig(targetDir),
    diagnostics,
    plans: activePlans(targetDir, nowIso),
  };

  const cap = Math.max(0, opts.maxBytes ?? DEFAULT_CONTEXT_BYTES);
  const size = () => Buffer.byteLength(JSON.stringify(draft), 'utf8');
  // Drop order: least critical for an AI proposal first, identity last.
  const droppers: Array<() => void> = [
    () => {
      draft.config = {};
    },
    () => {
      draft.plans = [];
    },
    () => {
      draft.capabilities = {};
    },
    () => {
      draft.diagnostics = [];
    },
    () => {
      draft.hosts = [];
    },
    () => {
      draft.stack = { detected: [], runtimes: {} };
    },
    () => {
      draft.forjas = [];
    },
  ];
  let truncated = false;
  while (size() > cap && droppers.length) {
    droppers.shift()?.();
    truncated = true;
  }

  return { ...draft, budget: { bytes: size(), truncated } };
}
