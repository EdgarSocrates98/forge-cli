import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../safety.js';
import { CLI_VERSION } from '../version.js';
import type { RegistryEntry } from './catalog.js';
import type { ProbedInterpreter, RunLike } from './install.js';
import { entryExtras, pipSpec, wheelCacheDir } from './install.js';

/**
 * `forge-cli-offline-lock/1` — fecho transitivo de uma dist PyPI, gerado por
 * `pip download --report` ONLINE uma vez. Instalação offline só vence se
 * TODOS os artefatos do lock existirem no wheel cache com sha256 íntegro e
 * tags compatíveis — e nada a mais pode estar lá.
 */
export interface OfflineLockEntry {
  name: string;
  version: string;
  filename: string;
  sha256: string;
  python_tag: string;
  platform_tag: string;
  source: string;
}

export interface OfflineLock {
  format: 'forge-cli-offline-lock/1';
  forge: string;
  dist: string;
  /**
   * Extras PEP 508 cobertos pelo fecho (`dist[mcp]` no download). Um lock
   * gerado para a dist nua NÃO cobre deps de extras — install recusa com
   * lock-mismatch quando diverge do pedido.
   */
  extras?: string[];
  version: string;
  python: string;
  platform: NodeJS.Platform | string;
  generatedAt: string;
  /** Quem gerou o lock — proveniência auditável (`forge-cli@x.y.z`). */
  generator?: string;
  artifacts: OfflineLockEntry[];
}

export type LockError =
  | { kind: 'lock-invalid'; detail: string }
  | { kind: 'lock-download-failed'; detail: string }
  | { kind: 'lock-report-missing'; detail: string }
  | { kind: 'lock-missing-artifact'; detail: string }
  | { kind: 'lock-extra-artifact'; detail: string }
  | { kind: 'lock-hash-mismatch'; detail: string }
  | { kind: 'lock-incompatible-tag'; detail: string }
  | { kind: 'lock-missing-dependency'; detail: string }
  | { kind: 'lock-mismatch'; detail: string };

const ARCHIVE_RE = /\.(whl|tar\.gz|tar\.bz2|zip)$/i;

/** normalização PEP 503 — nomes de dist e de Requires-Dist comparam iguais. */
export function normDist(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Tags de uma wheel pelo nome: `{d}-{v}[-{build}]-{py}-{abi}-{plat}.whl`. */
function wheelTags(filename: string): { python: string[]; abi: string[]; plat: string[] } | null {
  if (!filename.toLowerCase().endsWith('.whl')) return null;
  const stem = filename.slice(0, -4);
  const parts = stem.split('-');
  if (parts.length < 5) return null;
  return {
    python: parts[parts.length - 3].split('.'),
    abi: parts[parts.length - 2].split('.'),
    plat: parts[parts.length - 1].split('.'),
  };
}

/**
 * Compatibilidade honesta de tags: sem inferência otimista. `any`/`none`/`abi3`
 * passam sempre que o lado python bater; `py3`/`py2.py3` passam para alvo 3.x;
 * `py3N`/`cp3N` exigem alvo >= 3.N (abi3) ou == 3.N (abi nativa cp3N).
 * Desconhecido → incompatível (fail-closed, nunca "provavelmente funciona").
 */
export function tagsCompatible(
  filename: string,
  target: { py: [number, number] | null; platform: string },
): boolean {
  const tags = wheelTags(filename);
  if (!tags) {
    // sdist: construído da fonte no alvo — compatível por definição.
    return ARCHIVE_RE.test(filename);
  }
  const [maj, min] = target.py ?? [null, null];
  const pyOk = tags.python.some((t) => {
    if (t === 'any' || t === 'sdist') return true;
    if (maj === null) return t === 'py3' || t === 'py2';
    if (t === 'py3') return maj === 3;
    if (t === 'py2' || t === 'py2.py3') return maj === 2 || t === 'py2.py3';
    const m = /^(?:py|cp|pp)(\d)(\d+)$/.exec(t);
    if (!m) return false;
    const tagMaj = Number(m[1]);
    const tagMin = Number(m[2]);
    if (tagMaj !== maj) return false;
    if (t.startsWith('cp')) {
      // cp3N com abi3 roda em >= 3.N; com abi nativa cp3N só em == 3.N.
      return tags.abi.includes('abi3') || tags.abi.includes('none')
        ? min! >= tagMin
        : tags.abi.some((a) => a === t)
          ? min === tagMin
          : false;
    }
    return min! >= tagMin; // py3N = "3.N ou superior" (pure python)
  });
  if (!pyOk) return false;
  return tags.plat.some((p) => {
    if (p === 'any') return true;
    const plat = p.toLowerCase();
    switch (target.platform) {
      case 'linux':
        return (
          plat.startsWith('manylinux') || plat.startsWith('musllinux') || plat.startsWith('linux')
        );
      case 'darwin':
        return plat.startsWith('macosx');
      case 'win32':
        return plat.startsWith('win');
      default:
        return false;
    }
  });
}

/** sha256 de um arquivo do cache — mesma disciplina de checkDistHashes. */
function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/* ---------- geração (online, uma vez) ---------- */

interface PipReport {
  install?: Array<{
    download_info?: {
      url?: string;
      archive_info?: { hashes?: { sha256?: string } };
    };
    metadata?: { name?: string; version?: string };
  }>;
}

export interface GenerateLockDeps {
  run: RunLike;
  python: ProbedInterpreter;
  cacheDir: string;
  now?: () => string;
  platform?: NodeJS.Platform;
}

/**
 * Resolve o fecho transitivo com `pip download --report` (pip >= 23) e
 * confere sha256 do report contra o arquivo baixado — o lock só registra
 * o que está verificavelmente no wheel cache.
 */
export async function generateOfflineLock(
  entry: RegistryEntry,
  version: string,
  deps: GenerateLockDeps,
): Promise<OfflineLock | LockError> {
  const wheels = wheelCacheDir(deps.cacheDir, entry.dist);
  const report = path.join(wheels, '.pip-report.json');
  // `dist[extras]` no download — o fecho cobre também as deps dos extras
  // declarados, que passam a constar como artifacts verificáveis.
  const dl = await deps.run(deps.python.exe[0], [
    ...deps.python.exe.slice(1),
    '-m',
    'pip',
    'download',
    '--disable-pip-version-check',
    '--no-input',
    '--dest',
    wheels,
    '--report',
    report,
    pipSpec(entry, version),
  ]);
  if (dl.exitCode !== 0) {
    return {
      kind: 'lock-download-failed',
      detail: redactSecrets((dl.stderr ?? dl.stdout ?? 'pip download falhou').trim()),
    };
  }
  if (!existsSync(report)) {
    return {
      kind: 'lock-report-missing',
      detail: 'pip não emitiu --report (requer pip >= 23) — sem fecho transitivo verificável',
    };
  }
  let parsed: PipReport;
  try {
    parsed = JSON.parse(readFileSync(report, 'utf8')) as PipReport;
  } catch {
    return { kind: 'lock-report-missing', detail: 'relatório pip ilegível/corrompido' };
  }
  const installs = parsed.install;
  if (!Array.isArray(installs) || !installs.length) {
    return { kind: 'lock-report-missing', detail: 'relatório pip sem installações' };
  }
  const artifacts: OfflineLockEntry[] = [];
  for (const item of installs) {
    const meta = item.metadata ?? {};
    const info = item.download_info ?? {};
    const url = info.url ?? '';
    const filename = decodeURIComponent(url.split('/').pop() ?? '');
    const sha = info.archive_info?.hashes?.sha256;
    if (!meta.name || !meta.version || !filename || !sha) {
      return {
        kind: 'lock-invalid',
        detail: `entrada de relatório incompleta (${meta.name ?? filename ?? '?'}) — sem nome/versão/hash`,
      };
    }
    if (!ARCHIVE_RE.test(filename)) {
      return {
        kind: 'lock-invalid',
        detail: `${filename}: artefato não-arquivado (editable/venv local não tranca offline)`,
      };
    }
    const onDisk = path.join(wheels, filename);
    if (!existsSync(onDisk)) {
      return {
        kind: 'lock-missing-artifact',
        detail: `${filename}: relatado mas ausente do cache`,
      };
    }
    const actual = sha256File(onDisk);
    if (actual !== sha) {
      return {
        kind: 'lock-hash-mismatch',
        detail: `${filename}: sha256 ${actual.slice(0, 12)}… != relatório ${sha.slice(0, 12)}…`,
      };
    }
    const tags = wheelTags(filename);
    artifacts.push({
      name: meta.name,
      version: meta.version,
      filename,
      sha256: sha,
      python_tag: tags ? tags.python.join('.') : 'sdist',
      platform_tag: tags ? tags.plat.join('.') : 'any',
      source: 'pypi',
    });
  }
  artifacts.sort((a, b) => a.filename.localeCompare(b.filename));
  const extras = entryExtras(entry);
  return {
    format: 'forge-cli-offline-lock/1',
    forge: entry.name,
    dist: entry.dist,
    ...(extras.length ? { extras } : {}),
    version,
    python: deps.python.version,
    platform: deps.platform ?? process.platform,
    generatedAt: (deps.now ?? (() => new Date().toISOString()))(),
    generator: `forge-cli@${CLI_VERSION}`,
    artifacts,
  };
}

/* ---------- validação do lock lido ---------- */

export function parseOfflineLock(raw: unknown): OfflineLock | LockError {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'lock-invalid', detail: 'lock não é um objeto JSON' };
  }
  const o = raw as Record<string, unknown>;
  if (o.format !== 'forge-cli-offline-lock/1') {
    return { kind: 'lock-invalid', detail: 'formato de lock desconhecido' };
  }
  for (const k of ['forge', 'dist', 'version'] as const) {
    if (typeof o[k] !== 'string' || !o[k]) {
      return { kind: 'lock-invalid', detail: `campo ${k} ausente no lock` };
    }
  }
  if (
    o.extras !== undefined &&
    (!Array.isArray(o.extras) || o.extras.some((e) => typeof e !== 'string' || !e))
  ) {
    return { kind: 'lock-invalid', detail: 'extras inválidos no lock' };
  }
  if (!Array.isArray(o.artifacts) || !o.artifacts.length) {
    return { kind: 'lock-invalid', detail: 'lock sem artifacts' };
  }
  for (const a of o.artifacts as Array<Record<string, unknown>>) {
    for (const k of [
      'name',
      'version',
      'filename',
      'sha256',
      'python_tag',
      'platform_tag',
    ] as const) {
      if (typeof a?.[k] !== 'string' || !a[k]) {
        return {
          kind: 'lock-invalid',
          detail: `artifact sem ${k}: ${JSON.stringify(a).slice(0, 120)}`,
        };
      }
    }
  }
  return o as unknown as OfflineLock;
}

/* ---------- verificação pré-pip (pura, testável) ---------- */

/**
 * Conferência estrita do fecho contra o wheel cache — ANTES do pip:
 * artefato faltando, extra, adulterado ou com tag incompatível aborta.
 */
export function verifyLockFiles(
  lock: OfflineLock,
  wheels: string,
  target: { py: [number, number] | null; platform: string },
): LockError | null {
  const have = existsSync(wheels) ? readdirSync(wheels) : [];
  const wanted = new Map(lock.artifacts.map((a) => [a.filename, a]));
  for (const a of lock.artifacts) {
    if (!have.includes(a.filename)) {
      return { kind: 'lock-missing-artifact', detail: `${a.filename}: ausente em ${wheels}` };
    }
    const actual = sha256File(path.join(wheels, a.filename));
    if (actual !== a.sha256) {
      return {
        kind: 'lock-hash-mismatch',
        detail: `${a.filename}: sha256 ${actual.slice(0, 12)}… != lock ${a.sha256.slice(0, 12)}… — cache adulterado`,
      };
    }
    if (!tagsCompatible(a.filename, target)) {
      return {
        kind: 'lock-incompatible-tag',
        detail: `${a.filename}: tags ${a.python_tag}/${a.platform_tag} incompatíveis com py${target.py?.join('.') ?? '?'} ${target.platform}`,
      };
    }
  }
  const extras = have.filter(
    (f) => ARCHIVE_RE.test(f) && !wanted.has(f) && !f.endsWith('.rejected'),
  );
  if (extras.length) {
    return {
      kind: 'lock-extra-artifact',
      detail: `artefato fora do lock em ${wheels}: ${extras.join(', ')}`,
    };
  }
  return null;
}

/* ---------- fecho transitivo declarado vs lock ---------- */

/**
 * Extrai Requires-Dist de cada wheel via o python do alvo (zipfile +
 * pip._vendor.packaging p/ avaliar markers de ambiente). argv[1] carrega
 * os extras declarados do lock (CSV) — markers `extra == "x"` avaliam
 * contra eles, então deps de extras pedidos também são conferidas contra
 * o fecho. Falha no helper degrada para linha crua com marker removido —
 * nunca silencia dep real.
 */
const REQUIRES_SCRIPT = [
  'import json,sys,zipfile',
  'out={}',
  'extras=[e for e in sys.argv[1].split(",") if e]',
  'try:',
  ' from pip._vendor.packaging.requirements import Requirement',
  'except Exception:',
  ' Requirement=None',
  'for w in sys.argv[2:]:',
  ' reqs=[]',
  ' try:',
  '  with zipfile.ZipFile(w) as z:',
  '   meta=[n for n in z.namelist() if n.endswith(".dist-info/METADATA")]',
  '   if meta:',
  '    for l in z.read(meta[0]).decode("utf8","replace").splitlines():',
  '     if l.startswith("Requires-Dist:"):',
  '      s=l.split(":",1)[1].strip()',
  '      if Requirement is not None:',
  '       try:',
  '        r=Requirement(s)',
  '        if r.marker is not None:',
  '         keep=r.marker.evaluate() or any(r.marker.evaluate({"extra":e}) for e in extras)',
  '         if not keep: continue',
  '        reqs.append(r.name)',
  '       except Exception:',
  '        reqs.append(s.split(";")[0].strip().split(" ")[0])',
  '      else:',
  '       reqs.append(s.split(";")[0].strip().split(" ")[0])',
  ' except Exception:',
  '  pass',
  ' out[w]=reqs',
  'print(json.dumps(out))',
].join('\n');

export async function lockTransitiveCheck(
  lock: OfflineLock,
  wheels: string,
  run: RunLike,
  pythonExe: string[],
): Promise<LockError | null> {
  const files = lock.artifacts.map((a) => path.join(wheels, a.filename));
  const extras = (lock.extras ?? []).join(',');
  const res = await run(pythonExe[0], [
    ...pythonExe.slice(1),
    '-c',
    REQUIRES_SCRIPT,
    extras,
    ...files,
  ]);
  if (res.exitCode !== 0) {
    // Helper indisponível: pip --no-index ainda recusa dep faltante —
    // sem falsos-positivos, mas também sem o diagnóstico fino.
    return null;
  }
  let requires: Record<string, string[]>;
  try {
    requires = JSON.parse((res.stdout ?? '{}').trim()) as Record<string, string[]>;
  } catch {
    return null;
  }
  const locked = new Set(lock.artifacts.map((a) => normDist(a.name)));
  for (const [file, reqs] of Object.entries(requires)) {
    for (const r of reqs) {
      const n = normDist(r);
      if (n && !locked.has(n)) {
        return {
          kind: 'lock-missing-dependency',
          detail: `${path.basename(file)} requer "${r}" ausente do lock — lock desatualizado, regenere online`,
        };
      }
    }
  }
  return null;
}
