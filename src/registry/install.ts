/**
 * Instalação registry-first: venv isolada por Forja em
 * `~/.forge-cli/forges/<nome>/`, `pip install` pinado na versão resolvida,
 * verify do console script e receipt auditável — tudo com runner/fetch
 * injetáveis para teste determinístico.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { isSafeRepoName, redactSecrets, resolveInside, writeFileAtomic } from '../safety.js';
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
    if (typeof raw.forges !== 'object' || !raw.forges || Array.isArray(raw.forges)) {
      return { forges: {} };
    }
    // Valores não-objeto (state editado ou corrompido por dentro) são
    // descartados — leitores assumem receipt-shaped e não devem crashar.
    const forges: ForgeState['forges'] = {};
    for (const [k, v] of Object.entries(raw.forges)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) forges[k] = v;
    }
    return { ...raw, forges };
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
  // Escrita atômica (convenção do codebase) — kill no meio não corrompe.
  writeFileAtomic(forgeStatePath(home), `${JSON.stringify(state, null, 2)}\n`);
}

export function wheelCacheDir(cacheDir: string, dist: string): string {
  return path.join(path.dirname(cacheDir), 'wheels', dist);
}

/** Wheel cache da dist derivado do home — usado no uninstall. */
export function wheelCacheForHome(home: string, dist: string): string {
  return path.join(home, '.forge-cli', 'cache', 'wheels', dist);
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
    // Timeout preserva o stderr real quando o processo já escreveu algo.
    stderr: res.timedOut
      ? `timeout após ${opts.timeoutMs ?? 300_000}ms${res.stderr ? `: ${res.stderr}` : ''}`
      : res.stderr,
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
  | { stage: 'already-installed'; detail: string }
  | { stage: 'pip'; detail: string }
  | { stage: 'verify'; detail: string };

/**
 * Interpretador mais novo que satisfaz `requires_python` E o piso do
 * catálogo — max implícito das duas restrições. `requires_python` é a
 * fonte autoritativa do release, mas `minPython` é o mínimo que a
 * forge-cli suporta operacionalmente: uma release que alargue o spec
 * para baixo do nosso piso não habilita interpretadores sem suporte.
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
            requires: [resolved.requiresPython, `>=${entry.minPython} (piso forge-cli)`]
              .filter(Boolean)
              .join(' e '),
            have: pythons.map((p) => p.version).join(', '),
          },
    };
  }
  return { python: candidates[0] };
}

/** sha256 dos artefatos da dist no wheel cache contra o digest do PyPI. */
function checkDistHashes(
  distFiles: { filename: string; sha256?: string; packagetype?: string }[],
  wheels: string,
): { verifiedHash?: string; verifiedFile?: string } | { detail: string } {
  const have = existsSync(wheels) ? readdirSync(wheels) : [];
  // Verifica TODOS os artefatos da dist presentes no cache (wheel + sdist
  // quando ambos existem) — não para no primeiro.
  let verifiedHash: string | undefined;
  let verifiedFile: string | undefined;
  for (const f of distFiles) {
    if (!have.includes(f.filename) || !f.sha256) continue;
    const digest = createHash('sha256')
      .update(readFileSync(path.join(wheels, f.filename)))
      .digest('hex');
    if (digest !== f.sha256) {
      // Quarentena: renomeia para `.rejected` — preserva evidência,
      // desbloqueia a retry e nunca é selecionável pelo pip (extensão
      // fora de .whl/.tar.gz/.zip não entra em --find-links).
      const culprit = path.join(wheels, f.filename);
      try {
        rmSync(`${culprit}.rejected`, { force: true });
        renameSync(culprit, `${culprit}.rejected`);
      } catch {
        // melhor esforço: o erro primário é a divergência
      }
      return {
        detail: `${f.filename}: sha256 ${digest.slice(0, 12)}… != PyPI ${f.sha256.slice(0, 12)}… — artefato movido para ${f.filename}.rejected`,
      };
    }
    // A wheel verificada é o que o pip instala — prefere-a para o receipt
    // e para o alvo da instalação (caminho explícito, não resolução por nome).
    if (f.packagetype === 'bdist_wheel' || verifiedFile === undefined) {
      verifiedFile = f.filename;
      verifiedHash = digest;
    }
  }
  return { verifiedHash, verifiedFile };
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

  const venvDir = forgeVenv(deps.home, entry.name);
  // Reinstall sobre venv existente sem --clean destruiria a instalação
  // boa se uma etapa posterior falhar — recusa ANTES da resolução PyPI
  // (fail fast, inclusive offline, sem gastar a chamada de rede).
  if (!deps.clean && existsSync(venvDir)) {
    return {
      stage: 'already-installed',
      detail: `${entry.name}: já instalado em ${venvDir} — reinstale com --clean`,
    };
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
  const forgeDir = path.join(forgesRoot(deps.home), entry.name);
  // venv é o único conteúdo criado nesta tentativa — se o dir da Forja
  // ficou vazio após remover a venv, remove o dir também (sem órfãos).
  const cleanup = () => {
    rmSync(venvDir, { recursive: true, force: true });
    if (existsSync(forgeDir) && !readdirSync(forgeDir).length) {
      rmSync(forgeDir, { recursive: true, force: true });
    }
  };
  const venv = await run(python.exe[0], [...python.exe.slice(1), '-m', 'venv', venvDir]);
  if (venv.exitCode !== 0) {
    cleanup();
    return {
      stage: 'venv',
      detail: redactSecrets(venv.stderr ?? venv.stdout ?? 'falha ao criar venv'),
    };
  }

  const vpy = venvPython(venvDir, platform);
  const spec = `${entry.dist}==${resolved.version}`;
  mkdirSync(wheels, { recursive: true });

  // Artefatos: online baixa para o wheel cache (popula o modo offline);
  // offline exige artefatos presentes — nunca finge instalar sem rede.
  const distFiles = distArtifactFiles(resolved.files, entry.dist);
  let verifiedHash: string | undefined;
  let verifiedFile: string | undefined;
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
    verifiedFile = check.verifiedFile;
  } else {
    const dl = await run(vpy, [
      '-m',
      'pip',
      'download',
      '--disable-pip-version-check',
      '--no-input',
      '--dest',
      wheels,
      spec,
    ]);
    if (dl.exitCode !== 0) {
      cleanup();
      return {
        stage: 'download',
        // stderr do pip pode ecoar credenciais de PIP_INDEX_URL — redação
        // vale para stdout-JSON, --report e log humano.
        detail: redactSecrets((dl.stderr ?? dl.stdout ?? 'falha no pip download').trim()),
      };
    }
    // Integridade do artefato da própria dist contra o digest publicado no PyPI.
    const check = checkDistHashes(distFiles, wheels);
    if ('detail' in check) {
      cleanup();
      return { stage: 'hash-mismatch', detail: check.detail };
    }
    verifiedHash = check.verifiedHash;
    verifiedFile = check.verifiedFile;
  }

  // Sem artefato verificado não há instalação — um arquivo plantado no
  // cache (fora dos metadados) jamais pode vencer a resolução do pip.
  if (!verifiedFile) {
    cleanup();
    return {
      stage: 'hash-mismatch',
      detail: `${spec}: nenhum artefato da dist com sha256 verificável nos metadados`,
    };
  }

  const pipArgs = [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-input',
    // `--find-links` só no offline: online as dependências resolvem no
    // índice, não em wheels cacheadas potencialmente velhas/adulteradas.
    // Limite conhecido (§11.2): offline, deps transitivas resolvem por
    // nome no --find-links sem pin de hash.
    ...(deps.offline ? ['--no-index', '--find-links', wheels] : []),
    // Caminho explícito do artefato verificado — pip não resolve por nome,
    // então um arquivo plantado com a mesma dist==versão nunca é escolhido.
    path.join(wheels, verifiedFile),
  ];
  const pip = await run(vpy, pipArgs);
  if (pip.exitCode !== 0) {
    cleanup();
    return {
      stage: 'pip',
      detail: redactSecrets((pip.stderr ?? pip.stdout ?? 'falha no pip install').trim()),
    };
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
  writeFileAtomic(receiptPath(deps.home, entry.name), `${JSON.stringify(receipt, null, 2)}\n`);
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
  target: { name: string; dist?: string },
  deps: RegistryUninstallDeps,
): { removed: boolean; receiptRemoved: boolean; cacheRemoved: boolean; refused?: string } {
  // name/dist podem vir de state.json (alvo fora do catálogo) — dado não
  // confiável. `resolveInside`/`isSafeRepoName` é a convenção do codebase
  // para caminhos destrutivos: recusa traversal em vez de rmSync cego.
  const dir = resolveInside(forgesRoot(deps.home), target.name);
  if (!dir)
    return { removed: false, receiptRemoved: false, cacheRemoved: false, refused: 'unsafe-name' };
  const removed = existsSync(dir);
  if (removed) rmSync(dir, { recursive: true, force: true });
  // Wheel cache também sai — sem reclaim de disco o cache acumularia
  // artefatos de Forjas desinstaladas. Dist inválida/maliciosa é ignorada
  // (venv+state ainda são removidos — o nome é quem identifica a Forja).
  const wheels =
    target.dist && isSafeRepoName(target.dist)
      ? resolveInside(path.join(deps.home, '.forge-cli', 'cache', 'wheels'), target.dist)
      : null;
  const cacheRemoved = wheels !== null && existsSync(wheels);
  if (wheels) rmSync(wheels, { recursive: true, force: true });
  const state = loadForgeState(deps.home);
  // own-property: state é dado não confiável — 'constructor' e afins
  // não podem casar membros do Object.prototype.
  const hadReceipt = Object.hasOwn(state.forges, target.name);
  if (hadReceipt) delete state.forges[target.name];
  saveForgeState(deps.home, state);
  return { removed, receiptRemoved: hadReceipt, cacheRemoved };
}
