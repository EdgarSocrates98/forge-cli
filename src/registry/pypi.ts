/**
 * Resolver de releases contra o índice JSON do PyPI, com cache local para
 * o modo `--offline`. O manifesto externo é tratado como dado não
 * confiável: tipos checados em cada campo usado e falha honesta quando a
 * resposta não tem o formato esperado.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../safety.js';
import { compareVersions, latestStable, parseVersion } from './versions.js';

export interface ReleaseFile {
  filename: string;
  url: string;
  sha256?: string;
  packagetype?: string;
  requiresPython?: string;
  yanked?: boolean;
}

export interface ResolvedRelease {
  dist: string;
  version: string;
  requiresPython?: string;
  files: ReleaseFile[];
  /** Como a versão foi escolhida — vai para o receipt. */
  source: 'pinned' | 'latest-stable' | 'cache';
  /** Cache usado além do TTL — metadados podem estar velhos. */
  staleCache?: boolean;
  /** Release retirado do índice (PEP 592); só instala por pin explícito. */
  yanked?: boolean;
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
      yanked: rec.yanked === true || typeof rec.yanked === 'string' ? true : undefined,
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
    // timestamp futuro (clock skew) → não é "fresh", é suspeito
    const age = Date.now() - wrap.fetchedAt;
    return { payload: wrap.payload, fresh: age >= 0 && age < CACHE_TTL_MS };
  } catch {
    return null;
  }
}

function writeCache(cacheDir: string, dist: string, payload: PypiPayload): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileAtomic(
      pypiCacheFile(cacheDir, dist),
      JSON.stringify({ fetchedAt: Date.now(), payload }),
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

/** Payload PyPI é pequeno — cap defensivo contra resposta inflada. */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

async function defaultFetch(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  // Cap antes de bufar o corpo inteiro — content-length declara,
  // e o reader aborta se o stream exceder mesmo sem header honesto.
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_PAYLOAD_BYTES) {
    void res.body?.cancel();
    throw new Error(`payload excede ${MAX_PAYLOAD_BYTES} bytes`);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const body = await res.text();
    if (body.length > MAX_PAYLOAD_BYTES) {
      throw new Error(`payload excede ${MAX_PAYLOAD_BYTES} bytes`);
    }
    return { status: res.status, body };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAYLOAD_BYTES) {
      await reader.cancel();
      throw new Error(`payload excede ${MAX_PAYLOAD_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return { status: res.status, body: new TextDecoder().decode(Buffer.concat(chunks)) };
}

export async function resolveRelease(
  dist: string,
  opts: ResolveOptions,
): Promise<ResolvedRelease | ResolveError> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  let payload: PypiPayload | null;
  let fromCache = false;
  let staleCache = false;

  if (!opts.offline) {
    try {
      const res = await fetchImpl(`${PYPI_JSON}/${encodeURIComponent(dist)}/json`);
      if (res.status === 404) return { kind: 'not-found', dist };
      if (res.status !== 200) {
        const cached = readCache(opts.cacheDir, dist);
        if (cached) {
          payload = cached.payload;
          fromCache = true;
          staleCache = !cached.fresh;
        } else {
          return { kind: 'network', detail: `PyPI respondeu HTTP ${res.status}` };
        }
      } else {
        const parsed = JSON.parse(res.body) as PypiPayload;
        // Valida ANTES de cachear — um 200 malformado não pode
        // envenenar o cache local que sustenta o modo offline.
        if (typeof parsed?.releases !== 'object' || !parsed.releases) {
          const cached = readCache(opts.cacheDir, dist);
          if (cached) {
            payload = cached.payload;
            fromCache = true;
            staleCache = !cached.fresh;
          } else {
            return { kind: 'malformed', dist, detail: 'resposta sem campo releases' };
          }
        } else {
          writeCache(opts.cacheDir, dist, parsed);
          payload = parsed;
        }
      }
    } catch (error) {
      const cached = readCache(opts.cacheDir, dist);
      if (cached) {
        payload = cached.payload;
        fromCache = true;
        staleCache = !cached.fresh;
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
    staleCache = !cached.fresh;
  }

  const releases = payload?.releases;
  if (!payload || typeof releases !== 'object' || !releases) {
    return { kind: 'malformed', dist, detail: 'resposta sem campo releases' };
  }

  const installable = Object.keys(releases).filter((v) => {
    const files = parseFiles(releases[v]);
    if (!files.length) return false;
    return files.some((f) => !f.yanked);
  });
  const latest = latestStable(installable);
  let version = opts.pin ?? latest;
  if (!version) {
    return { kind: 'malformed', dist, detail: 'nenhuma versão estável instalável' };
  }
  // `in` aceitaria membros do prototype ('toString', 'constructor') —
  // membership deve ser own-property. Quando o pin não é uma chave exata,
  // tenta equivalência parseada: pip aceita `==0.1` para a chave `0.1.0`
  // (PEP 440 zero-padding), então o pin casa a chave real da release.
  if (!Object.hasOwn(releases, version) && opts.pin) {
    const pinned = parseVersion(version);
    if (pinned) {
      const canonical = Object.keys(releases)
        .filter((k) => {
          const parsed = parseVersion(k);
          return parsed !== null && compareVersions(parsed, pinned) === 0;
        })
        .sort()
        .at(0);
      if (canonical) version = canonical;
    }
  }
  if (!Object.hasOwn(releases, version)) {
    return {
      kind: 'version-not-found',
      dist,
      requested: opts.pin ?? version,
      available: Object.keys(releases)
        .filter((v) => parseVersion(v))
        .sort((a, b) => compareVersions(parseVersion(a)!, parseVersion(b)!)),
    };
  }

  const files = parseFiles(releases[version]);
  // `requires_python`: prefere a wheel (o que o pip instala) → sdist → info.
  // `info.requires_python` descreve a release MAIS NOVA — só é fallback
  // quando a versão resolvida é ela, senão aplicaria o spec novo a um
  // pin antigo cujos arquivos não declaram o campo.
  const requiresPython =
    files.find((f) => f.packagetype === 'bdist_wheel' && f.requiresPython)?.requiresPython ??
    files.find((f) => f.requiresPython)?.requiresPython ??
    (version === latest ? asString(payload.info?.requires_python) : undefined);

  return {
    dist,
    version,
    requiresPython,
    files,
    source: opts.pin ? 'pinned' : fromCache ? 'cache' : 'latest-stable',
    staleCache: staleCache || undefined,
    yanked: files.length && files.every((f) => f.yanked) ? true : undefined,
  };
}
