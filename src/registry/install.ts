/**
 * Instalação registry-first: venv isolada por Forja em
 * `~/.forge-cli/forges/<nome>/`, `pip install` pinado na versão resolvida,
 * verify do console script e receipt auditável — tudo com runner/fetch
 * injetáveis para teste determinístico.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { isSafeRepoName, redactSecrets, resolveInside, writeFileAtomic } from '../safety.js';
import type { RegistryEntry } from './catalog.js';
import {
  lockTransitiveCheck,
  normDist,
  parseOfflineLock,
  verifyLockFiles,
  type LockError,
  type OfflineLock,
} from './lock.js';
import { emitForgeShim, removeForgeShim } from './shims.js';
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
  /** Extras PEP 508 pedidos junto da dist (`dist[extra]`) — proveniência. */
  extras?: string[];
  version: string;
  requiresPython?: string;
  python: string;
  source: ResolvedRelease['source'];
  venv: string;
  bin: string;
  /** Launcher em `~/.forge-cli/bin/<cli>` — ausente se a emissão recusar. */
  shim?: string;
  /** Por que o shim não foi emitido (permissão, nome inseguro, …). */
  shimRefused?: string;
  installedAt: string;
  verify: { command: string[]; ok: boolean };
  files: { filename: string; sha256?: string; packagetype?: string }[];
  /** sha256 do artefato da dist conferido byte a byte após o download. */
  verifiedHash?: string;
  yanked?: boolean;
  staleCache?: boolean;
  /** Proveniência do artefato instalado — URL publicada no índice + via de resolução. */
  provenance?: {
    registry: 'pypi.org';
    file?: string;
    url?: string;
    resolvedVia: 'pypi' | 'offline-cache';
  };
  /** Versão travada por `pin --method registry` — update a respeita. */
  pinned?: string;
  /** Versões anteriores (mais antiga → mais recente) — alimenta `rollback`. */
  history?: { version: string; installedAt: string }[];
  /** Delegação ao instalador nativo da Forja (fase 2) — evidência honesta. */
  native?: {
    argv: string[];
    ran: boolean;
    dryRun?: boolean;
    exitCode?: number;
    skipped?: string;
    ignored?: string[];
  };
  /** Instalação offline travada — arquivo do lock + fecho verificado. */
  offlineLock?: { file: string; artifacts: number };
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
    // Leitura é pura: NUNCA grava aqui — um load em --plan/--check não pode
    // produzir mutação. O arquivo corrompido já é a evidência; a quarentena
    // `.corrupt` acontece em saveForgeState, antes de sobrescrevê-lo.
    return { forges: {} };
  }
}

/**
 * Entrada sintética para Forja presente no state mas fora do catálogo:
 * o receipt é a única fonte confiável — dist/bin por ele, piso derivado
 * do interpretador que instalou (único com prova de compatibilidade).
 */
export function ghostEntry(name: string, receipt: RegistryInstallReceipt): RegistryEntry {
  return {
    name,
    dist: receipt.dist,
    bin: path.basename(receipt.bin).replace(/\.exe$/i, ''),
    minPython: receipt.python.split('.').slice(0, 2).join('.'),
    origin: 'official',
    // Extras instalados junto — reinstall/update/rollback do ghost pedem o
    // mesmo `dist[extra]` do receipt em vez de regredir para a dist nua.
    ...(receipt.extras?.length ? { extras: receipt.extras } : {}),
  };
}

/**
 * Quarentena de state corrompido: preserva `<file>.corrupt` ANTES da
 * sobrescrita — nunca no load (read-only). `.corrupt` é uma cópia da
 * evidência que a escrita nova apagaria; `flag: 'wx'` não regrava.
 */
function quarantineCorruptState(file: string): void {
  if (!existsSync(file)) return;
  try {
    JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    try {
      writeFileSync(`${file}.corrupt`, readFileSync(file), { flag: 'wx' });
    } catch {
      // melhor esforço: o erro primário é a escrita do state
    }
  }
}

export function saveForgeState(home: string, state: ForgeState): void {
  mkdirSync(forgesRoot(home), { recursive: true });
  // Receipts carregam paths internos + hashes — o dir de estado é privado
  // ao usuário (POSIX; Windows usa ACL do perfil — chmod é no-op honesto).
  if (process.platform !== 'win32') {
    try {
      chmodSync(forgesRoot(home), 0o700);
      chmodSync(path.dirname(forgesRoot(home)), 0o700);
    } catch {
      // fs sem chmod (ex.: alguns mounts) — não bloqueia o write
    }
  }
  const file = forgeStatePath(home);
  quarantineCorruptState(file);
  // Escrita atômica (convenção do codebase) — kill no meio não corrompe.
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function wheelCacheDir(cacheDir: string, dist: string): string {
  return path.join(path.dirname(cacheDir), 'wheels', dist);
}

/** Extras PEP 508 normalizados (dedup + sort) — contrato do spec e do lock. */
export function entryExtras(entry: RegistryEntry): string[] {
  return [...new Set(entry.extras ?? [])].sort();
}

/** Sufixo `[extra,…]` do requerimento PEP 508 — '' quando sem extras. */
export function extrasSuffix(entry: RegistryEntry): string {
  const ex = entryExtras(entry);
  return ex.length ? `[${ex.join(',')}]` : '';
}

/**
 * `dist[extras]==version` — o que o pip resolve/baixa de fato. A dist nua
 * não puxa deps de extras (E2E 11.2.1: `sparkforge-aws` instalado sem
 * `[mcp]` deixou o servidor MCP sem as dependências).
 */
export function pipSpec(entry: RegistryEntry, version: string): string {
  return `${entry.dist}${extrasSuffix(entry)}==${version}`;
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

// ---------------------------------------------------------------------------
// Lifecycle lock — serializa install/uninstall/pin/update sobre state.json.
// Dois lifecycle concorrentes (mesmo processo ou CLIs distintos) não podem
// intercalar escritas: `mkdir` é a operação atômica multi-processo.
// Recuperação documentada de lock velho: titular com pid morto (SIGKILL) é
// quebrado imediatamente; lock sem info legível só é quebrado quando a
// mtime excede `staleMs` (holder pode estar entre mkdir e a info).
// Remoção manual documentada: apagar `.forge-lifecycle.lock` destrava.
// ---------------------------------------------------------------------------

export interface ForgeLockOpts {
  /** Deadline de espera pelo lock (ms) — default 5min (escala do pip). */
  timeoutMs?: number;
  /** Lock sem info mais velho que isto (ms) é abandonado — default 10min. */
  staleMs?: number;
  /** Intervalo de polling (ms). */
  pollMs?: number;
  /** Relógio injetável (testes). */
  now?: () => number;
  /** Verificação de pid injetável (testes). */
  pidAlive?: (pid: number) => boolean;
}

export interface ForgeLock {
  dir: string;
  release: () => void;
}

export type ForgeLockResult =
  { ok: true; lock: ForgeLock } | { ok: false; reason: 'busy' | 'error'; detail: string };

/** Diretório-lock único do lifecycle registry — não é uma Forja (dotfile). */
export function forgeLockDir(home: string): string {
  return path.join(forgesRoot(home), '.forge-lifecycle.lock');
}

function pidAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function acquireForgeLock(
  home: string,
  opts: ForgeLockOpts = {},
): Promise<ForgeLockResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const staleMs = opts.staleMs ?? 600_000;
  const pollMs = opts.pollMs ?? 100;
  const now = opts.now ?? Date.now;
  const alive = opts.pidAlive ?? pidAliveDefault;
  const dir = forgeLockDir(home);
  const info = path.join(dir, 'info.json');
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(forgesRoot(home), { recursive: true });
      mkdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { ok: false, reason: 'error', detail: `lifecycle lock: ${String(error)}` };
      }
      // Lock existe — decide entre titular vivo e abandono.
      let holder: { pid?: unknown; at?: unknown } | null = null;
      try {
        holder = JSON.parse(readFileSync(info, 'utf8')) as { pid?: unknown; at?: unknown };
      } catch {
        // info ainda não gravada ou ilegível — decide por mtime abaixo
      }
      const pid = typeof holder?.pid === 'number' ? holder.pid : null;
      // pid morto (SIGKILL/crash) → quebra imediata, mesmo recente.
      const stale = pid !== null && pid !== process.pid && !alive(pid);
      const broken =
        stale ||
        (holder === null &&
          (() => {
            try {
              return now() - statSync(dir).mtimeMs > staleMs;
            } catch {
              return true; // dir sumiu entre checks — tenta de novo
            }
          })());
      if (stale || broken) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // outro waiter quebrou primeiro — próxima tentativa resolve
        }
        continue;
      }
      if (now() >= deadline) {
        return {
          ok: false,
          reason: 'busy',
          detail:
            `lifecycle lock ocupado em ${dir}${pid !== null ? ` (pid ${pid})` : ''} — ` +
            'outra operação install/uninstall/update está em curso; se o processo morreu, remova o diretório do lock',
        };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    // Adquirido — info é melhor esforço: staleness por mtime cobre ausência.
    try {
      writeFileSync(info, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }));
    } catch {
      // sem info o lock ainda protege via mtime de diretório
    }
    return {
      ok: true,
      lock: {
        dir,
        release: () => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // release é melhor esforço — lock velho é recuperável
          }
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Consistência state ↔ receipt ↔ venv — uma instalação quebrada por crash
// (SIGKILL entre pip e as escritas atômicas) NUNCA pode se apresentar como
// saudável: o cheque nomeia a divergência e o reparo (`reinstall --clean`
// ou `uninstall --method registry` + novo install).
// ---------------------------------------------------------------------------

export type InstallConsistencyStatus =
  | 'ok'
  | 'not-installed'
  | 'orphaned'
  | 'missing-receipt'
  | 'unreadable-receipt'
  | 'forge-mismatch'
  | 'version-mismatch'
  | 'missing-venv';

export interface InstallConsistency {
  ok: boolean;
  status: InstallConsistencyStatus;
  detail: string;
}

const REPAIR_HINT =
  'repare com `reinstall --method registry --clean` ou remova com `uninstall --method registry`';

export function installConsistency(home: string, name: string): InstallConsistency {
  const entry = loadForgeState(home).forges[name];
  const dir = resolveInside(forgesRoot(home), name);
  const venv = forgeVenv(home, name);
  if (!entry) {
    const leftover = (dir !== null && existsSync(dir)) || existsSync(venv);
    return leftover
      ? {
          ok: false,
          status: 'orphaned',
          detail: `${name}: venv/diretório presente sem registro no state — instalação interrompida; ${REPAIR_HINT}`,
        }
      : { ok: false, status: 'not-installed', detail: `${name}: não instalado via registry` };
  }
  const rfile = receiptPath(home, name);
  if (!existsSync(rfile)) {
    return {
      ok: false,
      status: 'missing-receipt',
      detail: `${name}: state registra ${entry.version} mas install.json está ausente — escrita interrompida; ${REPAIR_HINT}`,
    };
  }
  let receipt: RegistryInstallReceipt | null = null;
  try {
    receipt = JSON.parse(readFileSync(rfile, 'utf8')) as RegistryInstallReceipt;
  } catch {
    // tratado abaixo como unreadable-receipt
  }
  if (!receipt || typeof receipt.version !== 'string') {
    return {
      ok: false,
      status: 'unreadable-receipt',
      detail: `${name}: install.json ilegível/corrompido — ${REPAIR_HINT}`,
    };
  }
  if (typeof receipt.forge === 'string' && receipt.forge !== name) {
    return {
      ok: false,
      status: 'forge-mismatch',
      detail: `${name}: install.json pertence a ${receipt.forge} — ${REPAIR_HINT}`,
    };
  }
  if (receipt.version !== entry.version) {
    return {
      ok: false,
      status: 'version-mismatch',
      detail: `${name}: state=${entry.version} mas receipt=${receipt.version} — escrita interrompida no meio; ${REPAIR_HINT}`,
    };
  }
  if (!existsSync(entry.venv ?? venv)) {
    return {
      ok: false,
      status: 'missing-venv',
      detail: `${name}: venv ausente (${entry.venv ?? venv}) — instalação danificada; ${REPAIR_HINT}`,
    };
  }
  return { ok: true, status: 'ok', detail: '' };
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

export async function execaRun(
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<RunResult> {
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
  /**
   * `--lock <file>` (só com offline): instalação travada — o fecho
   * transitivo inteiro é conferido (hash, tags, extras, deps declaradas)
   * antes do `pip install --no-index`.
   */
  lockFile?: string;
  /**
   * Lifecycle (update/reinstall/rollback): ajusta o receipt — history,
   * pinned — ANTES das escritas atômicas de install.json + state.json.
   * Sem o hook, o chamador mutava o receipt depois da persistência: um
   * crash nesse intervalo perdia o histórico e deixava install.json
   * divergente do state para sempre.
   */
  receiptPatch?: (receipt: RegistryInstallReceipt) => void;
  /** Ajustes do lifecycle lock (timeouts/poll/relógio — testes). */
  lifecycleLock?: ForgeLockOpts;
}

export type InstallError =
  | { stage: 'resolve'; error: ResolveError }
  | { stage: 'no-python'; detail: string }
  | { stage: 'venv'; detail: string }
  | { stage: 'download'; detail: string }
  | { stage: 'offline-missing-artifact'; detail: string }
  | { stage: 'hash-mismatch'; detail: string }
  | { stage: 'already-installed'; detail: string }
  | { stage: 'lock'; error: LockError }
  | { stage: 'pip'; detail: string }
  | { stage: 'verify'; detail: string }
  /** Lifecycle lock ocupado — recusa nomeada, nunca intercala escritas. */
  | { stage: 'busy'; detail: string }
  /**
   * pip instalou mas a persistência (install.json/state.json) falhou —
   * a instalação existe e NÃO está saudável: installConsistency a nombra
   * como incompleta até `reinstall --clean` ou `uninstall`.
   */
  | { stage: 'persist'; detail: string }
  /** Estado/recibo divergentes detectados (crash anterior) — recusa. */
  | { stage: 'incomplete'; detail: string };

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
  // A venv existir também exige state+receipt coerentes: um crash que
  // deixou a instalação pela metade NÃO se apresenta como saudável —
  // a resposta é 'incomplete' com o reparo, não 'already-installed'.
  const consistencyGate = (): InstallError => {
    const c = installConsistency(deps.home, entry.name);
    if (c.ok) {
      return {
        stage: 'already-installed',
        detail: `${entry.name}: já instalado em ${venvDir} — reinstale com --clean`,
      };
    }
    return { stage: 'incomplete', detail: c.detail };
  };
  if (!deps.clean && existsSync(venvDir)) return consistencyGate();

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

  const wheels = wheelCacheDir(deps.cacheDir, entry.dist);

  // Modo travado (--offline --lock): o lock inteiro é validado ANTES de
  // qualquer mutação — faltando artefato, hash divergente, extra no cache
  // ou tag incompatível → recusa pura, sem criar venv nem tocar o disco.
  let lock: OfflineLock | null = null;
  if (deps.lockFile !== undefined) {
    if (!deps.offline) {
      return {
        stage: 'lock',
        error: { kind: 'lock-invalid', detail: '--lock só vale junto de --offline' },
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(deps.lockFile, 'utf8'));
    } catch (e) {
      return {
        stage: 'lock',
        error: {
          kind: 'lock-invalid',
          detail: `lock ilegível ${deps.lockFile}: ${e instanceof Error ? e.message : e}`,
        },
      };
    }
    const parsed = parseOfflineLock(raw);
    if ('kind' in parsed) return { stage: 'lock', error: parsed };
    // Extras são parte do contrato do lock: um lock gerado para `dist` nua
    // não cobre as deps de `dist[mcp]` — recusa nomeada, nunca sub-instala.
    const lockExtras = [...(parsed.extras ?? [])].sort();
    const wantExtras = entryExtras(entry);
    if (
      parsed.forge !== entry.name ||
      parsed.dist !== entry.dist ||
      parsed.version !== resolved.version ||
      lockExtras.join(',') !== wantExtras.join(',')
    ) {
      const covered = `${parsed.dist}${lockExtras.length ? `[${lockExtras.join(',')}]` : ''}`;
      return {
        stage: 'lock',
        error: {
          kind: 'lock-mismatch',
          detail: `lock cobre ${covered}==${parsed.version}; pedido foi ${pipSpec(entry, resolved.version)}`,
        },
      };
    }
    const fileErr = verifyLockFiles(parsed, wheels, {
      py: [python.parsed.release[0] ?? 0, python.parsed.release[1] ?? 0],
      platform,
    });
    if (fileErr) return { stage: 'lock', error: fileErr };
    lock = parsed;
  }

  // Lifecycle lock — a janela mutante inteira (backup → venv → pip →
  // receipt/state) roda sob o lock: duas instalações concorrentes da
  // mesma Forja não intercalam escritas nem dividem state.json. Lock
  // ocupado é recusa nomeada ('busy'), nunca espera cega nem corrupção.
  const lockRes = await acquireForgeLock(deps.home, deps.lifecycleLock);
  if (!lockRes.ok) {
    return { stage: 'busy', detail: `${entry.name}: ${lockRes.detail}` };
  }
  try {
    // Re-cheque sob o lock: outra instalação pode ter completado enquanto
    // esta esperava — a semântica é a mesma do gate pré-lock.
    if (!deps.clean && existsSync(venvDir)) return consistencyGate();

    const forgeDir = path.join(forgesRoot(deps.home), entry.name);
    // `--clean`/lifecycle: a instalação anterior é movida para backup ANTES de
    // qualquer etapa destrutiva — falha restaura o estado anterior em vez de
    // deixar a Forja sem install (venv + receipt voltam inteiros pelo rename).
    let backupDir: string | null = null;
    if (deps.clean && existsSync(forgeDir)) {
      backupDir = `${forgeDir}.restore-${process.pid}`;
      renameSync(forgeDir, backupDir);
    }
    // venv é o único conteúdo criado nesta tentativa — se o dir da Forja
    // ficou vazio após remover a venv, remove o dir também (sem órfãos).
    // Com backup pendente, a restauração devolve a instalação anterior.
    const cleanup = () => {
      rmSync(venvDir, { recursive: true, force: true });
      if (existsSync(forgeDir) && !readdirSync(forgeDir).length) {
        rmSync(forgeDir, { recursive: true, force: true });
      }
      if (backupDir) {
        rmSync(forgeDir, { recursive: true, force: true });
        renameSync(backupDir, forgeDir);
        backupDir = null;
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
    const spec = pipSpec(entry, resolved.version);
    mkdirSync(wheels, { recursive: true });

    // Artefatos: online baixa para o wheel cache (popula o modo offline);
    // offline exige artefatos presentes — nunca finge instalar sem rede.
    const distFiles = distArtifactFiles(resolved.files, entry.dist);
    let verifiedHash: string | undefined;
    let verifiedFile: string | undefined;
    if (lock) {
      // Fecho inteiro já conferido (verifyLockFiles). O artefato primário vem
      // do próprio lock — nunca de um arquivo plantado com nome parecido.
      const primary =
        lock.artifacts.find(
          (a) =>
            normDist(a.name) === normDist(entry.dist) &&
            a.version === resolved.version &&
            a.filename.toLowerCase().endsWith('.whl'),
        ) ??
        lock.artifacts.find(
          (a) => normDist(a.name) === normDist(entry.dist) && a.version === resolved.version,
        );
      if (!primary) {
        cleanup();
        return {
          stage: 'lock',
          error: {
            kind: 'lock-mismatch',
            detail: `lock ${deps.lockFile} não contém artefato de ${entry.dist}==${resolved.version}`,
          },
        };
      }
      verifiedHash = primary.sha256;
      verifiedFile = primary.filename;
      // Requires-Dist de cada wheel ⊆ nomes do lock — dependência transitiva
      // nova (lock desatualizado) falha com diagnóstico antes do pip.
      const depErr = await lockTransitiveCheck(lock, wheels, run, [vpy]);
      if (depErr) {
        cleanup();
        return { stage: 'lock', error: depErr };
      }
    } else if (deps.offline) {
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
      // Com lock: o fecho INTEIRO é passado por caminho explícito — o pip não
      // resolve nada por nome e --no-index bloqueia qualquer queda pra rede.
      // Sem lock: caminho explícito do artefato da dist verificado — um
      // arquivo plantado com a mesma dist==versão nunca é escolhido.
      ...(lock
        ? // Lock já enumera o fecho inteiro — inclusive as deps dos extras
          // declarados — então os artefatos entram por caminho puro.
          lock.artifacts.map((a) => path.join(wheels, a.filename))
        : // `[extras]` no caminho do artefato: pip instala a wheel verificada
          // E resolve as deps do extra no índice/--find-links (PEP 508).
          [`${path.join(wheels, verifiedFile)}${extrasSuffix(entry)}`]),
    ];
    const pip = await run(vpy, pipArgs);
    if (pip.exitCode !== 0) {
      cleanup();
      return {
        stage: 'pip',
        detail: redactSecrets((pip.stderr ?? pip.stdout ?? 'falha no pip install').trim()),
      };
    }
    // Ponto de não retorno: pip install ok ⇒ nova instalação venceu. O
    // backup só é descartado DEPOIS do commit (receipt+state) — uma falha
    // de persistência ainda pode restaurar a instalação anterior.
    const commitBackup = backupDir;
    backupDir = null;

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
      ...(entryExtras(entry).length ? { extras: entryExtras(entry) } : {}),
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
      provenance: {
        registry: 'pypi.org',
        file: verifiedFile,
        url: resolved.files.find((f) => f.filename === verifiedFile)?.url,
        resolvedVia: deps.offline ? 'offline-cache' : 'pypi',
      },
      yanked: resolved.yanked,
      staleCache: resolved.staleCache,
      offlineLock: lock ? { file: deps.lockFile!, artifacts: lock.artifacts.length } : undefined,
    };
    // Patch do lifecycle (history/pinned) antes das duas escritas atômicas —
    // crash entre install e pós-persistência do chamador não perde histórico.
    deps.receiptPatch?.(receipt);

    // Commit: install.json + state.json são as duas escritas atômicas.
    // Falha aqui deixa a venv instalada SEM registro coerente — o erro
    // 'persist' nomeia isso e installConsistency a marca 'incomplete'
    // (nunca saudável). O backup restaura a instalação anterior.
    try {
      mkdirSync(path.dirname(receiptPath(deps.home, entry.name)), { recursive: true });
      writeFileAtomic(receiptPath(deps.home, entry.name), `${JSON.stringify(receipt, null, 2)}\n`);
      const state = loadForgeState(deps.home);
      state.forges[entry.name] = receipt;
      saveForgeState(deps.home, state);
      // Launcher em ~/.forge-cli/bin (dir já no PATH do self-install do
      // forge-cli). Recusa não derruba a instalação — fica registrada no
      // receipt e a nota final ainda mostra o bin da venv.
      try {
        receipt.shim = emitForgeShim(deps.home, binPath, platform);
      } catch (shimError) {
        receipt.shimRefused = shimError instanceof Error ? shimError.message : String(shimError);
      }
      writeFileAtomic(receiptPath(deps.home, entry.name), `${JSON.stringify(receipt, null, 2)}\n`);
      state.forges[entry.name] = receipt;
      saveForgeState(deps.home, state);
    } catch (error) {
      if (commitBackup) {
        rmSync(forgeDir, { recursive: true, force: true });
        try {
          renameSync(commitBackup, forgeDir);
        } catch {
          // restauração melhor esforço — o erro primário é o persist
        }
      }
      const why = error instanceof Error ? error.message : String(error);
      const consistency = installConsistency(deps.home, entry.name);
      return {
        stage: 'persist',
        detail:
          `${entry.name}: pip instalou mas o receipt/state falhou (${why}) — ` +
          `instalação INCOMPLETA (${consistency.status}): ${consistency.detail || 'reexecute install'}`,
      };
    }
    // Commit feito — o backup da instalação anterior é descartado agora.
    if (commitBackup) rmSync(commitBackup, { recursive: true, force: true });

    if (verify.exitCode !== 0) {
      return { stage: 'verify', detail: `${entry.bin} --help saiu com código ${verify.exitCode}` };
    }
    return receipt;
  } finally {
    lockRes.lock.release();
  }
}

export interface RegistryUninstallDeps {
  home: string;
  platform?: NodeJS.Platform;
}

export function registryUninstall(
  target: { name: string; dist?: string },
  deps: RegistryUninstallDeps,
): {
  removed: boolean;
  receiptRemoved: boolean;
  cacheRemoved: boolean;
  shimRemoved?: boolean;
  refused?: string;
} {
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
  // Preferir o shim gravado no receipt — um `bin` movido deixaria um
  // launcher órfão em ~/.forge-cli/bin se derivássemos o nome dele.
  const shimRemoved = removeForgeShim(
    deps.home,
    hadReceipt ? (state.forges[target.name].shim ?? state.forges[target.name].bin) : undefined,
    deps.platform ?? process.platform,
  );
  if (hadReceipt) delete state.forges[target.name];
  saveForgeState(deps.home, state);
  return { removed, receiptRemoved: hadReceipt, cacheRemoved, shimRemoved };
}
