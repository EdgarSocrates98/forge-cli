/**
 * Resolver de releases contra o índice JSON do PyPI, com cache local para
 * o modo `--offline`. O manifesto externo é tratado como dado não
 * confiável: tipos checados em cada campo usado e falha honesta quando a
 * resposta não tem o formato esperado.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { latestStable, parseVersion } from './versions.js';

export interface ReleaseFile {
  filename: string;
  url: string;
  sha256?: string;
  packagetype?: string;
  requiresPython?: string;
}

export interface ResolvedRelease {
  dist: string;
  version: string;
  requiresPython?: string;
  files: ReleaseFile[];
  /** Como a versão foi escolhida — vai para o receipt. */
  source: 'pinned' | 'latest-stable' | 'cache';
}

export type ResolveError =
  | { kind: 'network'; detail: string }
  | { kind: 'not-found'; dist: string }
  | { kind: 'version-not-found'; dist: string; requested: string; available: string[] }
  | { kind: 'python-incompatible'; dist: string; version: string; requires: string; have: string }
  | { kind: 'specifier-unknown'; dist: string; version: string; requires: string }
  | { kind: 'offline-miss'; dist: string }
  | { kind: 'malformed'; dist: string; detail: string };

export type FetchLike = (url: string) => Promise<{ status: number; body: string }>;

const PYPI_JSON = 'https://pypi.org/pypi';
const CACHE_TTL_MS = 60 * 60 * 1000;

export function pypiCacheFile(cacheDir: string, dist: string): string {
  return path.join(cacheDir, `${dist}.json`);
}

interface PypiPayload {
  info?: { requires_python?: unknown };
  releases?: Record<string, unknown>;
  urls?: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

function parseFiles(raw: unknown): ReleaseFile[] {
  if (!Array.isArray(raw)) return [];
  const out: ReleaseFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const filename = asString(rec.filename);
    const url = asString(rec.url);
    if (!filename || !url) continue;
    const digests = rec.digests as Record<string, unknown> | undefined;
    out.push({
      filename,
      url,
      sha256: digests ? asString(digests.sha256) : undefined,
      packagetype: asString(rec.packagetype),
      requiresPython: asString(rec.requires_python) ?? undefined,
    });
  }
  return out;
}

function readCache(
  cacheDir: string,
  dist: string,
): { payload: PypiPayload; fresh: boolean } | null {
  try {
    const raw = readFileSync(pypiCacheFile(cacheDir, dist), 'utf8');
    const wrap = JSON.parse(raw) as { fetchedAt?: number; payload?: PypiPayload };
    if (typeof wrap.fetchedAt !== 'number' || !wrap.payload) return null;
    return { payload: wrap.payload, fresh: Date.now() - wrap.fetchedAt < CACHE_TTL_MS };
  } catch {
    return null;
  }
}

function writeCache(cacheDir: string, dist: string, payload: PypiPayload): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      pypiCacheFile(cacheDir, dist),
      JSON.stringify({ fetchedAt: Date.now(), payload }),
      'utf8',
    );
  } catch {
    // cache é melhoria, nunca bloqueia
  }
}

export interface ResolveOptions {
  /** Versão pinada (`--version`/`--ref`); quando ausente escolhe a estável mais nova. */
  pin?: string;
  offline?: boolean;
  cacheDir: string;
  fetchImpl?: FetchLike;
}

async function defaultFetch(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.text() };
}

export async function resolveRelease(
  dist: string,
  opts: ResolveOptions,
): Promise<ResolvedRelease | ResolveError> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  let payload: PypiPayload | null;
  let fromCache = false;

  if (!opts.offline) {
    try {
      const res = await fetchImpl(`${PYPI_JSON}/${encodeURIComponent(dist)}/json`);
      if (res.status === 404) return { kind: 'not-found', dist };
      if (res.status !== 200) {
        return { kind: 'network', detail: `PyPI respondeu HTTP ${res.status}` };
      }
      const parsed = JSON.parse(res.body) as PypiPayload;
      writeCache(opts.cacheDir, dist, parsed);
      payload = parsed;
    } catch (error) {
      const cached = readCache(opts.cacheDir, dist);
      if (cached) {
        payload = cached.payload;
        fromCache = true;
      } else {
        return {
          kind: 'network',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
  } else {
    const cached = readCache(opts.cacheDir, dist);
    if (!cached) return { kind: 'offline-miss', dist };
    payload = cached.payload;
    fromCache = true;
  }

  const releases = payload?.releases;
  if (!payload || typeof releases !== 'object' || !releases) {
    return { kind: 'malformed', dist, detail: 'resposta sem campo releases' };
  }

  const version = opts.pin ?? latestStable(Object.keys(releases));
  if (!version) {
    return { kind: 'malformed', dist, detail: 'nenhuma versão estável disponível' };
  }
  if (!(version in releases)) {
    return {
      kind: 'version-not-found',
      dist,
      requested: version,
      available: Object.keys(releases).filter((v) => parseVersion(v)),
    };
  }

  const files = parseFiles(releases[version]);
  // `info.requires_python` é o piso do projeto; os arquivos do release podem
  // declarar `requires_python` próprio que se sobrepõe.
  const requiresPython =
    files.find((f) => f.requiresPython)?.requiresPython ?? asString(payload.info?.requires_python);

  return {
    dist,
    version,
    requiresPython,
    files,
    source: opts.pin ? 'pinned' : fromCache ? 'cache' : 'latest-stable',
  };
}
