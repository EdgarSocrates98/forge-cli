/**
 * Instalação registry-first: venv isolada por Forja em
 * `~/.forge-cli/forges/<nome>/`, `pip install` pinado na versão resolvida,
 * verify do console script e receipt auditável — tudo com runner/fetch
 * injetáveis para teste determinístico.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import type { RegistryEntry } from './catalog.js';
import { resolveRelease, type FetchLike, type ResolveError, type ResolvedRelease } from './pypi.js';
import {
  compareVersions,
  isPrerelease,
  parseVersion,
  satisfiesRequiresPython,
  type ParsedVersion,
} from './versions.js';

export interface RegistryInstallReceipt {
  forge: string;
  method: 'pypi';
  dist: string;
  version: string;
  requiresPython?: string;
  python: string;
  source: ResolvedRelease['source'];
  venv: string;
  bin: string;
  installedAt: string;
  verify: { command: string[]; ok: boolean };
  files: { filename: string; sha256?: string; packagetype?: string }[];
  /** sha256 do artefato da dist conferido byte a byte após o download. */
  verifiedHash?: string;
  yanked?: boolean;
  staleCache?: boolean;
}

export interface ForgeState {
  forges: Record<string, RegistryInstallReceipt>;
}

export function forgesRoot(home: string): string {
  return path.join(home, '.forge-cli', 'forges');
}

export function forgeStatePath(home: string): string {
  return path.join(forgesRoot(home), 'state.json');
}

export function forgeVenv(home: string, name: string): string {
  return path.join(forgesRoot(home), name, 'venv');
}

export function receiptPath(home: string, name: string): string {
  return path.join(forgesRoot(home), name, 'install.json');
}

export function loadForgeState(home: string): ForgeState {
  const file = forgeStatePath(home);
  if (!existsSync(file)) return { forges: {} };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as ForgeState;
    return typeof raw.forges === 'object' && raw.forges ? raw : { forges: {} };
  } catch {
    // estado corrompido não é silenciosamente sobrescrito — preserva evidência
    try {
      writeFileSync(`${file}.corrupt`, readFileSync(file), { flag: 'wx' });
    } catch {
      // melhor esforço: o erro primário é o parse
    }
    return { forges: {} };
  }
}

function saveForgeState(home: string, state: ForgeState): void {
  mkdirSync(forgesRoot(home), { recursive: true });
  writeFileSync(forgeStatePath(home), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function wheelCacheDir(cacheDir: string, dist: string): string {
  return path.join(path.dirname(cacheDir), 'wheels', dist);
}

export function venvBin(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.join(venvDir, 'Scripts') : path.join(venvDir, 'bin');
}

export function venvPython(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(venvBin(venvDir, platform), platform === 'win32' ? 'python.exe' : 'python');
}

export interface RunResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}
export interface RunOpts {
  /** Timeout do subprocesso em ms (default 5min — pip pode ser lento). */
  timeoutMs?: number;
}
export type RunLike = (cmd: string, args: string[], opts?: RunOpts) => Promise<RunResult>;

async function execaRun(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const res = await execa(cmd, args, {
    reject: false,
    timeout: opts.timeoutMs ?? 300_000,
  });
  return {
    exitCode: res.exitCode ?? 1,
    stdout: res.stdout,
    stderr: res.timedOut ? `timeout após ${opts.timeoutMs ?? 300_000}ms` : res.stderr,
  };
}

export interface ProbedInterpreter {
  exe: string[];
  version: string;
  parsed: ParsedVersion;
}

export interface RegistryInstallDeps {
  run?: RunLike;
  home: string;
  cacheDir: string;
  offline?: boolean;
  /** Interpretadores detectados; o mais novo que satisfaz requires_python vence. */
  pythons: ProbedInterpreter[];
  /** Injetável em testes; default = PyPI real. */
  fetchImpl?: FetchLike;
  platform?: NodeJS.Platform;
  now?: () => string;
  /** `--clean`: remove venv/receipt existentes antes de instalar. */
  clean?: boolean;
}

export type InstallError =
  | { stage: 'resolve'; error: ResolveError }
  | { stage: 'no-python'; detail: string }
  | { stage: 'venv'; detail: string }
  | { stage: 'download'; detail: string }
  | { stage: 'offline-missing-artifact'; detail: string }
  | { stage: 'hash-mismatch'; detail: string }
  | { stage: 'pip'; detail: string }
  | { stage: 'verify'; detail: string };

/**
 * Interpretador mais novo que satisfaz `requires_python` (+ piso do catálogo).
 * Interpretadores pré-release só vencem quando nenhum estável satisfaz —
 * `packaging` também os exclui de specs estáveis.
 * `null` no especificador = fora do subconjunto — diagnóstico distinto.
 */
export function selectInterpreter(
  entry: RegistryEntry,
  resolved: Pick<ResolvedRelease, 'requiresPython' | 'version'>,
  pythons: ProbedInterpreter[],
): { python: ProbedInterpreter } | { error: ResolveError } {
  const floor = parseVersion(entry.minPython);
  let sawUnknownSpec = false;
  const usable = pythons.filter((p) => {
    if (floor && compareVersions(p.parsed, floor) < 0) return false;
    if (!resolved.requiresPython) return true;
    const sat = satisfiesRequiresPython(resolved.requiresPython, p.parsed);
    if (sat === null) {
      sawUnknownSpec = true;
      return false;
    }
    return sat;
  });
  // Ordena internamente (mais novo primeiro) — não depende do chamador.
  usable.sort((a, b) => compareVersions(b.parsed, a.parsed));
  const stable = usable.filter((p) => !isPrerelease(p.parsed));
  const candidates = stable.length ? stable : usable;
  if (!candidates.length) {
    return {
      error: sawUnknownSpec
        ? {
            kind: 'specifier-unknown',
            dist: entry.dist,
            version: resolved.version,
            requires: resolved.requiresPython!,
          }
        : {
            kind: 'python-incompatible',
            dist: entry.dist,
            version: resolved.version,
            requires: resolved.requiresPython ?? `>=${entry.minPython}`,
            have: pythons.map((p) => p.version).join(', '),
          },
    };
  }
  return { python: candidates[0] };
}

/** sha256 do arquivo no wheel cache contra o digest publicado no PyPI. */
function checkDistHashes(
  distFiles: { filename: string; sha256?: string; packagetype?: string }[],
  wheels: string,
): { verifiedHash?: string } | { detail: string } {
  const have = existsSync(wheels) ? readdirSync(wheels) : [];
  // Verifica TODOS os artefatos da dist presentes no cache (wheel + sdist
  // quando ambos existem) — não para no primeiro.
  let verifiedHash: string | undefined;
  for (const f of distFiles) {
    if (!have.includes(f.filename) || !f.sha256) continue;
    const digest = createHash('sha256')
      .update(readFileSync(path.join(wheels, f.filename)))
      .digest('hex');
    if (digest !== f.sha256) {
      return {
        detail: `${f.filename}: sha256 ${digest.slice(0, 12)}… != PyPI ${f.sha256.slice(0, 12)}…`,
      };
    }
    verifiedHash = f.packagetype === 'bdist_wheel' ? digest : (verifiedHash ?? digest);
  }
  return { verifiedHash };
}

/** Arquivos da própria dist (wheel `dist_…` e sdist `dist-…` legado). */
export function distArtifactFiles(
  files: { filename: string; sha256?: string; packagetype?: string }[],
  dist: string,
): typeof files {
  const norm = dist.toLowerCase();
  const prefixes = [`${norm.replace(/[-_.]/g, '_')}-`, `${norm.replace(/[-_.]/g, '-')}-`];
  return files.filter((f) => prefixes.some((p) => f.filename.toLowerCase().startsWith(p)));
}

export async function registryInstall(
  entry: RegistryEntry,
  pin: string | undefined,
  deps: RegistryInstallDeps,
): Promise<RegistryInstallReceipt | InstallError> {
  const run = deps.run ?? execaRun;
  const platform = deps.platform ?? process.platform;
  if (!deps.pythons.length) {
    return { stage: 'no-python', detail: 'nenhum interpretador Python detectado' };
  }

  const resolved = await resolveRelease(entry.dist, {
    pin,
    offline: deps.offline,
    cacheDir: deps.cacheDir,
    fetchImpl: deps.fetchImpl,
  });
  if ('kind' in resolved) return { stage: 'resolve', error: resolved };

  const picked = selectInterpreter(entry, resolved, deps.pythons);
  if ('error' in picked) return { stage: 'resolve', error: picked.error };
  const python = picked.python;

  const venvDir = forgeVenv(deps.home, entry.name);
  if (deps.clean) {
    rmSync(path.join(forgesRoot(deps.home), entry.name), { recursive: true, force: true });
    // state também é limpo — senão uma falha depois deixa versão antiga
    // registrada sem venv/bin correspondentes.
    const st = loadForgeState(deps.home);
    if (st.forges[entry.name]) {
      delete st.forges[entry.name];
      saveForgeState(deps.home, st);
    }
  }
  const wheels = wheelCacheDir(deps.cacheDir, entry.dist);
  const cleanup = () => rmSync(venvDir, { recursive: true, force: true });
  const venv = await run(python.exe[0], [...python.exe.slice(1), '-m', 'venv', venvDir]);
  if (venv.exitCode !== 0) {
    cleanup();
    return { stage: 'venv', detail: venv.stderr ?? venv.stdout ?? 'falha ao criar venv' };
  }

  const vpy = venvPython(venvDir, platform);
  const spec = `${entry.dist}==${resolved.version}`;
  mkdirSync(wheels, { recursive: true });

  // Artefatos: online baixa para o wheel cache (popula o modo offline);
  // offline exige artefatos presentes — nunca finge instalar sem rede.
  const distFiles = distArtifactFiles(resolved.files, entry.dist);
  let verifiedHash: string | undefined;
  if (deps.offline) {
    const have = existsSync(wheels) ? readdirSync(wheels) : [];
    if (!distFiles.length || !distFiles.some((f) => have.includes(f.filename))) {
      cleanup();
      return {
        stage: 'offline-missing-artifact',
        detail: `${spec}: sem wheel/sdist em ${wheels} — instale online uma vez`,
      };
    }
    // Cache local também é verificado — artefato adulterado aborta o install.
    const check = checkDistHashes(distFiles, wheels);
    if ('detail' in check) {
      cleanup();
      return { stage: 'hash-mismatch', detail: check.detail };
    }
    verifiedHash = check.verifiedHash;
  } else {
    const dl = await run(vpy, [
      '-m',
      'pip',
      'download',
      '--disable-pip-version-check',
      '--dest',
      wheels,
      spec,
    ]);
    if (dl.exitCode !== 0) {
      cleanup();
      return {
        stage: 'download',
        detail: (dl.stderr ?? dl.stdout ?? 'falha no pip download').trim(),
      };
    }
    // Integridade do artefato da própria dist contra o digest publicado no PyPI.
    const check = checkDistHashes(distFiles, wheels);
    if ('detail' in check) {
      cleanup();
      return { stage: 'hash-mismatch', detail: check.detail };
    }
    verifiedHash = check.verifiedHash;
  }

  const pipArgs = [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--find-links',
    wheels,
    ...(deps.offline ? ['--no-index'] : []),
    spec,
  ];
  const pip = await run(vpy, pipArgs);
  if (pip.exitCode !== 0) {
    cleanup();
    return { stage: 'pip', detail: (pip.stderr ?? pip.stdout ?? 'falha no pip install').trim() };
  }

  const binPath = path.join(
    venvBin(venvDir, platform),
    platform === 'win32' ? `${entry.bin}.exe` : entry.bin,
  );
  const verifyCmd = [binPath, '--help'];
  const verify = await run(binPath, ['--help']);

  const receipt: RegistryInstallReceipt = {
    forge: entry.name,
    method: 'pypi',
    dist: entry.dist,
    version: resolved.version,
    requiresPython: resolved.requiresPython,
    python: python.version,
    source: resolved.source,
    venv: venvDir,
    bin: binPath,
    installedAt: (deps.now ?? (() => new Date().toISOString()))(),
    verify: { command: verifyCmd, ok: verify.exitCode === 0 },
    files: resolved.files.map((f) => ({
      filename: f.filename,
      sha256: f.sha256,
      packagetype: f.packagetype,
    })),
    verifiedHash,
    yanked: resolved.yanked,
    staleCache: resolved.staleCache,
  };

  mkdirSync(path.dirname(receiptPath(deps.home, entry.name)), { recursive: true });
  writeFileSync(
    receiptPath(deps.home, entry.name),
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8',
  );
  const state = loadForgeState(deps.home);
  state.forges[entry.name] = receipt;
  saveForgeState(deps.home, state);

  if (verify.exitCode !== 0) {
    return { stage: 'verify', detail: `${entry.bin} --help saiu com código ${verify.exitCode}` };
  }
  return receipt;
}

export interface RegistryUninstallDeps {
  home: string;
  platform?: NodeJS.Platform;
}

export function registryUninstall(
  entry: RegistryEntry,
  deps: RegistryUninstallDeps,
): { removed: boolean; receiptRemoved: boolean } {
  const dir = path.join(forgesRoot(deps.home), entry.name);
  const removed = existsSync(dir);
  if (removed) rmSync(dir, { recursive: true, force: true });
  const state = loadForgeState(deps.home);
  const hadReceipt = Boolean(state.forges[entry.name]);
  delete state.forges[entry.name];
  saveForgeState(deps.home, state);
  return { removed, receiptRemoved: hadReceipt };
}
