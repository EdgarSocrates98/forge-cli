/**
 * Subconjunto determinístico do PEP 440 para resolver `requires_python`
 * e ordenar releases do PyPI. Cobre o vocabulário real das nossas dists:
 * release N(.N)*, pre (a|b|rc), post (.postN), dev (.devN) e especificadores
 * ~=, == (com .*), !=, >=, >, <=, < — nada além disso é aceito.
 */

export interface ParsedVersion {
  release: number[];
  pre?: { tag: 'a' | 'b' | 'rc'; n: number };
  post?: number;
  dev?: number;
}

const VERSION_RE = /^(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?(?:\.dev(\d+))?$/i;

/** Retorna `null` para versões fora do subconjunto suportado (epoch, local). */
export function parseVersion(input: string): ParsedVersion | null {
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  const release = m[1].split('.').map((x) => Number.parseInt(x, 10));
  if (release.some((n) => !Number.isFinite(n))) return null;
  const out: ParsedVersion = { release };
  if (m[2]) out.pre = { tag: m[2].toLowerCase() as 'a' | 'b' | 'rc', n: Number.parseInt(m[3], 10) };
  if (m[4]) out.post = Number.parseInt(m[4], 10);
  if (m[5]) out.dev = Number.parseInt(m[5], 10);
  return out;
}

const PRE_ORDER = { a: 0, b: 1, rc: 2 } as const;

function cmpRelease(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Comparação PEP 440 dentro do subconjunto:
 * `X.devN < XaN < XbN < XrcN < X < X.postN` (ordenação por fase do release).
 */
function phaseRank(v: ParsedVersion): number {
  if (v.dev !== undefined && !v.pre && v.post === undefined) return 0;
  if (v.pre) return 1;
  if (v.post !== undefined) return 3;
  return v.dev !== undefined ? 0 : 2;
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const rel = cmpRelease(a.release, b.release);
  if (rel !== 0) return rel;
  const aPhase = phaseRank(a);
  const bPhase = phaseRank(b);
  if (aPhase !== bPhase) return aPhase < bPhase ? -1 : 1;
  if (aPhase === 0) return (a.dev ?? 0) - (b.dev ?? 0);
  if (aPhase === 1) {
    const tag = PRE_ORDER[a.pre!.tag] - PRE_ORDER[b.pre!.tag];
    if (tag !== 0) return tag;
    return a.pre!.n - b.pre!.n;
  }
  if (aPhase === 3) return (a.post ?? 0) - (b.post ?? 0);
  return 0;
}

export function isPrerelease(v: ParsedVersion): boolean {
  return v.pre !== undefined || v.dev !== undefined;
}

export type SpecOp = '~=' | '==' | '!=' | '>=' | '>' | '<=' | '<';

export interface Specifier {
  op: SpecOp;
  version: ParsedVersion;
  wildcard: boolean;
}

const SPEC_RE = /^(~=|==|!=|>=|<=|>|<)\s*([0-9][0-9a-zA-Z.]*?)(\.\*)?$/;

/** Uma cláusula de `requires-python`; `null` quando fora do subconjunto. */
export function parseSpecifier(input: string): Specifier | null {
  const m = SPEC_RE.exec(input.trim());
  if (!m) return null;
  const version = parseVersion(m[2]);
  if (!version) return null;
  const wildcard = Boolean(m[3]);
  if (wildcard && m[1] !== '==' && m[1] !== '!=') return null;
  // `~=X` (um componente só) não define fronteira superior — fora do subconjunto.
  if (m[1] === '~=' && version.release.length < 2) return null;
  return { op: m[1] as SpecOp, version, wildcard };
}

function matchWildcard(candidate: number[], spec: number[]): boolean {
  if (candidate.length < spec.length) return false;
  return spec.every((n, i) => candidate[i] === n);
}

/** Avalia um especificador contra uma versão já parseada. */
export function evalSpecifier(candidate: ParsedVersion, spec: Specifier): boolean {
  if (spec.wildcard) {
    const hit = matchWildcard(candidate.release, spec.version.release);
    return spec.op === '==' ? hit : !hit;
  }
  const cmp = compareVersions(candidate, spec.version);
  switch (spec.op) {
    case '==':
      return cmp === 0;
    case '!=':
      return cmp !== 0;
    case '>=':
      return cmp >= 0;
    case '>':
      return cmp > 0;
    case '<=':
      return cmp <= 0;
    case '<':
      return cmp < 0;
    case '~=': {
      // ~=X.Y[.Z] ≡ >= spec e < próxima fronteira superior do release
      if (cmp < 0) return false;
      const bound = [...spec.version.release];
      bound.pop();
      bound[bound.length - 1] += 1;
      return cmpRelease(candidate.release, bound) < 0;
    }
  }
}

/**
 * Avalia um `requires_python` ("~=", "==", …, separado por vírgula) contra
 * uma versão concreta. `null` = especificador fora do subconjunto suportado.
 */
export function satisfiesRequiresPython(
  requiresPython: string,
  candidate: ParsedVersion,
): boolean | null {
  const parts = requiresPython
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return true;
  let anyUnknown = false;
  for (const part of parts) {
    const spec = parseSpecifier(part);
    if (!spec) {
      anyUnknown = true;
      continue;
    }
    if (!evalSpecifier(candidate, spec)) return false;
  }
  return anyUnknown ? null : true;
}

/** Maior versão estável de uma lista; `null` quando só há pré-releases. */
export function latestStable(versions: string[]): string | null {
  let best: string | null = null;
  let bestParsed: ParsedVersion | null = null;
  for (const raw of versions) {
    const parsed = parseVersion(raw);
    if (!parsed || isPrerelease(parsed)) continue;
    if (!bestParsed || compareVersions(parsed, bestParsed) > 0) {
      best = raw;
      bestParsed = parsed;
    }
  }
  return best;
}
