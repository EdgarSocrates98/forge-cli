/**
 * Fonte local — install/update/repair/uninstall sobre diretórios do
 * usuário (ciclo 12.1). O diretório é classificado por
 * `forge/LocalForgeSourceDetection/v1` e o bootstrap roda NO lugar —
 * nunca `git init`/`clone`/`pull`, nunca rede no caminho gitless, e o
 * diretório-fonte nunca é deletado (só os `managed_artifacts`
 * registrados saem no uninstall; arquivos do usuário são intocáveis).
 *
 * Recusas carregam o código FORGE-* + causa + remédio (PT-BR); um
 * `LocalFailure` sem `code` é falha operacional (script saiu não-zero)
 * — não é uma recusa nomeada e não deve ganhar código inventado.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { copyConfigExamples } from '../configs.js';
import { FORGE_REPOS } from '../constants/repos.js';
import { ensureEnvFile } from '../env.js';
import type { LocalFailure } from '../errors.js';
import {
  acquireForgeLock,
  execaRun,
  forgesRoot,
  loadForgeState,
  receiptPath,
  saveForgeState,
  venvBin,
  type ForgeLockOpts,
  type InstallReceipt,
  type LocalInstallReceipt,
  type RunLike,
} from '../registry/install.js';
import { emitForgeShim, removeForgeShim } from '../registry/shims.js';
import { parseVersion, satisfiesRequiresPython } from '../registry/versions.js';
import { resolveInside, writeFileAtomic } from '../safety.js';
import { normalizePythonFloor } from '../env/python.js';
import { errorDetail, findSetupScript, type WinSetupShells } from '../utils/system.js';
import { detectSource, type SourceDetection } from './detect.js';

/**
 * Interpretador para o bootstrap Python — seleção do pipeline lf-0017
 * (`discoverPythons().selected`) ou injeção direta em testes. `argv` é
 * o único campo exigido; `version` ausente = não sondado (sem prova).
 */
export interface LocalPython {
  argv: string[];
  /** Versão executada (`--version`); null/undefined = injetado sem sonda. */
  version?: string | null;
  /** Origem no pipeline ('env', 'flag', 'venv', 'path'…). */
  source?: string;
  /** Forma de exibição — default `argv.join(' ')`. */
  executable?: string;
  selection_reason?: string;
}

export interface LocalDeps {
  home: string;
  run?: RunLike;
  platform?: NodeJS.Platform;
  now?: () => string;
  /**
   * Shells Windows verificadas pela descoberta (lf-0016): `ps` conduz
   * `.ps1`, `bash` (Git Bash verificado) a `.sh`/`install.windows.sh`.
   * `undefined` = não sondado (legado só-PowerShell); `{}` = sondado e
   * nenhuma rota → FORGE-SHELL-NOT-FOUND quando nada executa.
   */
  winShells?: WinSetupShells;
  /**
   * Interpretador selecionado (pipeline lf-0017) para o fallback
   * `scripts/forge_bootstrap.py` — o instalador nativo real das Forjas
   * que roda sem `.git` desde que forge.json seja válido.
   * `null`/ausente = fallback indisponível (descoberta recusou).
   * `string[]` (argv nu) permanece aceito — testes e chamadores legados
   * injetam `['python3']` sem sonda (normalizado por {@link localPythonOf}).
   */
  python?: LocalPython | string[] | null;
  /** Detalhe da recusa da descoberta — enriquece o relatório/falha. */
  pythonIssue?: { code?: string; cause: string; remedy?: string } | null;
  /** Confirmação interativa para fonte parcial — omitida = não-interativo. */
  confirm?: () => Promise<boolean>;
  /** `--yes` já é a confirmação explícita do spec. */
  yes?: boolean;
  /** Ajustes do lifecycle lock (testes). */
  lifecycleLock?: ForgeLockOpts;
  /** Timeout do bootstrap (ms) — default 5min como os demais spawns. */
  timeoutMs?: number;
}

export type LocalOutcome =
  | { ok: true; receipt: LocalInstallReceipt; detection: SourceDetection }
  | { ok: false; failure: LocalFailure; detection?: SourceDetection };

const fail = (failure: LocalFailure, detection?: SourceDetection): LocalOutcome => ({
  ok: false,
  failure,
  detection,
});

/** Receipts locais indexados por nome — dado de state (não confiável). */
export function localReceipts(home: string): Record<string, LocalInstallReceipt> {
  const out: Record<string, LocalInstallReceipt> = {};
  for (const [name, r] of Object.entries(loadForgeState(home).forges)) {
    if (r.method === 'local') out[name] = r;
  }
  return out;
}

/** A Forja `name` tem receipt de fonte local? Roteamento by-name depende disso. */
export function hasLocalReceipt(home: string, name: string): boolean {
  const r = loadForgeState(home).forges[name];
  return r?.method === 'local';
}

/** O receipt do state é de fonte local? Guarda de roteamento by-name. */
export function isLocalEntry(entry: InstallReceipt | undefined): entry is LocalInstallReceipt {
  return entry?.method === 'local';
}

/**
 * `rel` resolvido dentro de `dir` — null se escapar (traversal, drive
 * diferente, caminho absoluto). Diferente de `resolveInside` (nomes de
 * Forja), aceita subcaminhos com '/' e nomes iniciados em '.' — o que
 * source_files/managed_artifacts exigem (`.venv`, `src/x/y.py`).
 */
export function safeJoinInside(dir: string, rel: string): string | null {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const root = path.resolve(dir);
  const target = path.resolve(root, ...rel.split('/'));
  const delta = path.relative(root, target);
  if (!delta || delta.startsWith('..') || path.isAbsolute(delta)) return null;
  return target;
}

/** Entradas de topo do diretório — snapshot pré/pós-bootstrap. */
function topLevelEntries(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir));
  } catch {
    return new Set();
  }
}

/**
 * Prefixos excluídos do snapshot de arquivos da fonte — artefatos de
 * runtime nunca viram "arquivo da fonte" (o update por substituição os
 * reconciliaria errado e o uninstall já os cobre via managed_artifacts).
 */
const SNAPSHOT_EXCLUDED = new Set([
  '.git',
  '.venv',
  'venv',
  'node_modules',
  '__pycache__',
  '.env',
  '.forge-cli',
  '.forge',
]);

const SNAPSHOT_MAX_FILES = 50_000;

/**
 * Lista determinística dos arquivos da fonte (relativos, separador '/').
 * Diretórios vazios não são registrados — o reconciliador de update só
 * precisa de arquivos para copiar/remover.
 */
export function snapshotSourceFiles(dir: string, managedTop: Set<string>): string[] {
  const out: string[] = [];
  const walk = (rel: string): boolean => {
    const abs = path.join(dir, rel);
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return true;
    }
    for (const name of names.sort()) {
      if (out.length >= SNAPSHOT_MAX_FILES) return false;
      const childRel = rel ? `${rel}/${name}` : name;
      if (SNAPSHOT_EXCLUDED.has(name)) continue;
      let st;
      try {
        st = statSync(path.join(dir, childRel));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!walk(childRel)) return false;
      } else if (st.isFile()) {
        out.push(childRel);
      }
    }
    return true;
  };
  // Entradas gerenciadas ficam de fora: o snapshot da fonte registra o
  // que o usuário forneceu, não o que o instalador gerou (o diff de
  // update remove só source_files registrados — artefato gerenciado
  // jamais entra na lista de remoção).
  for (const name of [...topLevelEntries(dir)].sort()) {
    if (managedTop.has(name) || SNAPSHOT_EXCLUDED.has(name)) continue;
    let st;
    try {
      st = statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!walk(name)) break;
    } else if (st.isFile()) {
      if (out.length >= SNAPSHOT_MAX_FILES) break;
      out.push(name);
    }
  }
  return out.sort();
}

/**
 * Normaliza a injeção de interpretador: `LocalPython` do pipeline ou
 * argv nu legado (`['python3']` — sem versão/origem, nunca sondado).
 */
function localPythonOf(python: LocalPython | string[] | null | undefined): LocalPython | null {
  if (Array.isArray(python)) return python.length ? { argv: python } : null;
  return python ?? null;
}

/**
 * Seleção do script de bootstrap — o MESMO caminho do fluxo git:
 * `findSetupScript` (POSIX setup.sh/install.sh via `sh -c`; Windows:
 * `.ps1` via powershell/pwsh quando `winShells.ps` existe, senão `.sh`
 * via Git Bash com `install.windows.sh` primeiro na cadeia — lf-0016).
 * Sem script, `scripts/forge_bootstrap.py` com interpretador conhecido
 * é o fallback nativo do ecossistema (roda via Python, sem shell).
 */
export function selectSetup(
  det: SourceDetection,
  platform: NodeJS.Platform,
  python?: LocalPython | string[] | null,
  winShells?: WinSetupShells,
): { file: string; command: string; args: string[] } | null {
  const script = findSetupScript(det.path, platform, winShells);
  if (script) return script;
  const bootstrap = path.join('scripts', 'forge_bootstrap.py');
  const argv = localPythonOf(python)?.argv;
  if (argv?.length && existsSync(path.join(det.path, bootstrap))) {
    return {
      file: bootstrap,
      command: argv[0],
      args: [...argv.slice(1), bootstrap],
    };
  }
  return null;
}

/**
 * Piso do manifesto: forge.json `python` (`'>=3.10'` ou `'3.11'` nu)
 * contra a versão EXECUTADA do interpretador selecionado. `null` =
 * satisfeito/indeterminado; recusa nomeada quando provado incompatível.
 */
export function pythonFloorFailure(
  det: SourceDetection,
  python: LocalPython | string[] | null | undefined,
): LocalFailure | null {
  const spec = det.manifest?.python?.trim();
  const py = localPythonOf(python);
  const version = py?.version;
  if (!spec || !version) return null;
  const parsed = parseVersion(version);
  if (!parsed) return null;
  const floor = normalizePythonFloor(spec);
  if (satisfiesRequiresPython(floor, parsed) !== false) return null;
  return {
    code: 'FORGE-PYTHON-INCOMPATIBLE',
    cause: `${det.path}: forge.json exige python ${spec} mas o interpretador selecionado é ${version} (${py?.executable ?? py?.argv.join(' ')})`,
    remedy:
      'aponte um interpretador compatível com --python/FORGE_PYTHON ou corrija o campo `python` do forge.json',
  };
}

/**
 * `.env` + configs de exemplo — mesmo provisionamento do fluxo git.
 * `envKeys` do catálogo só aplicam quando o forge_id é Forja conhecida:
 * fonte desconhecida recebe .env.example copiado (nunca stub inventado).
 */
async function provisionEnvironment(dir: string, forgeId?: string): Promise<void> {
  const envKeys = FORGE_REPOS.find((r) => r.name === forgeId)?.envKeys;
  if (
    envKeys?.length ||
    existsSync(path.join(dir, '.env')) ||
    existsSync(path.join(dir, '.env.example'))
  ) {
    await ensureEnvFile(dir, envKeys);
  }
  await copyConfigExamples(dir);
}

/** venv criada pelo bootstrap vive na própria fonte (convenção .venv). */
function sourceVenv(det: SourceDetection, platform: NodeJS.Platform): string | undefined {
  const venv = path.join(det.path, '.venv');
  return existsSync(venvBin(venv, platform)) ? venv : undefined;
}

/**
 * Persistência do receipt local — as DUAS escritas atômicas
 * (install.json + state.json) sob o lifecycle lock, mesma convenção do
 * receipt registry. Forjas locais não têm venv em ~/.forge-cli/forges —
 * o dir do registry vira só o envelope do receipt.
 */
async function persistLocalReceipt(
  home: string,
  receipt: LocalInstallReceipt,
  opts?: ForgeLockOpts,
): Promise<void> {
  const envelope = resolveInside(forgesRoot(home), receipt.forge);
  if (!envelope) throw new Error(`forge_id inseguro para o receipt: ${receipt.forge}`);
  const res = await acquireForgeLock(home, opts);
  if (!res.ok) throw new Error(res.detail);
  try {
    mkdirSync(envelope, { recursive: true });
    writeFileAtomic(receiptPath(home, receipt.forge), `${JSON.stringify(receipt, null, 2)}\n`);
    const state = loadForgeState(home);
    state.forges[receipt.forge] = receipt;
    saveForgeState(home, state);
  } finally {
    res.lock.release();
  }
}

function buildReceipt(
  det: SourceDetection,
  deps: LocalDeps,
  script: { file: string; command: string; args: string[] },
  managed: string[],
  sourceFiles: string[],
  prior?: LocalInstallReceipt,
): LocalInstallReceipt {
  const platform = deps.platform ?? process.platform;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const manifest = det.manifest;
  const venv = sourceVenv(det, platform);
  const cliName = manifest?.cli;
  const binCandidate = venv && cliName ? path.join(venvBin(venv, platform), cliName) : undefined;
  const bin = binCandidate && existsSync(binCandidate) ? binCandidate : cliName;
  const py = localPythonOf(deps.python);
  return {
    forge: det.forge_id!,
    method: 'local',
    install_method: 'local',
    dist: manifest?.distribution ?? manifest?.package ?? det.forge_id!,
    version: manifest?.version ?? prior?.version ?? '0.0.0-local',
    // Objeto de proveniência lf-0017 — mesma forma do receipt registry.
    ...(py?.argv.length
      ? {
          python: {
            source: py.source ?? 'manual',
            version: py.version ?? null,
            executable: py.executable ?? py.argv.join(' '),
            selection_reason:
              py.selection_reason ?? 'interpretador injetado pelo chamador (sem sonda do pipeline)',
          },
        }
      : {}),
    ...(venv ? { venv } : {}),
    ...(bin ? { bin } : {}),
    installedAt: prior?.installedAt ?? now,
    ...(prior ? { updatedAt: now } : {}),
    // verify é preenchido pelo chamador após o probe do cli.
    verify: { command: [], ok: true },
    files: [],
    ...(prior?.pinned ? { pinned: prior.pinned } : {}),
    source_dir: det.path,
    is_git: det.is_git,
    source_trust: det.source_trust,
    manifest_valid: det.manifest_valid,
    integrity: det.integrity,
    execution_environment: {
      platform,
      arch: process.arch,
      node: process.version,
      shell: script.command,
    },
    source_state: det.state,
    setup_script: script.file,
    managed_artifacts: managed,
    source_files: sourceFiles,
  };
}

/** Verify pós-bootstrap: `<cli> --help` — o probe é o mesmo do registry. */
async function runVerify(
  receipt: LocalInstallReceipt,
  det: SourceDetection,
  deps: LocalDeps,
  run: RunLike,
): Promise<void> {
  const cliName = det.manifest?.cli;
  if (!cliName) return;
  const verifyArgv = [receipt.bin ?? cliName, '--help'];
  const verify = await run(verifyArgv[0], verifyArgv.slice(1), {
    cwd: det.path,
    timeoutMs: deps.timeoutMs,
  });
  receipt.verify = { command: verifyArgv, ok: verify.exitCode === 0 };
}

/** Gate do spec: fonte parcial só instala com confirmação explícita. */
async function partialGate(det: SourceDetection, deps: LocalDeps): Promise<LocalFailure | null> {
  if (det.state !== 'GITLESS_PARTIAL_FORGE' || deps.yes) return null;
  const ok = deps.confirm ? await deps.confirm() : false;
  if (ok) return null;
  return {
    code: 'FORGE-SOURCE-GITLESS',
    cause: `${det.path}: fonte parcial (estrutura incompleta — integridade 'partial') exige confirmação explícita`,
    remedy: 'reexecute com --yes para confirmar a instalação de fonte parcial',
  };
}

/** Recusa nomeada quando a sonda de shells não achou rota nativa (win32). */
function winShellNotFound(dir: string): LocalFailure {
  return {
    code: 'FORGE-SHELL-NOT-FOUND',
    cause: `${dir}: nenhuma shell de instalação utilizável no Windows (powershell.exe/pwsh ausentes e Git Bash não executa)`,
    remedy:
      'instale PowerShell 7+ (`winget install Microsoft.PowerShell`), habilite o powershell.exe 5.1 do Windows ou instale Git for Windows — o Git Bash vira a rota de `install.windows.sh`. WSL nunca substitui shell nativo',
  };
}

/**
 * `provisionEnvironment` falhando é persistência de ambiente quebrada —
 * ganha código próprio (FORGE-ENV-PERSISTENCE-FAILED), nunca exceção solta.
 */
async function provisionOrRefuse(dir: string, forgeId?: string): Promise<LocalFailure | null> {
  try {
    await provisionEnvironment(dir, forgeId);
    return null;
  } catch (error) {
    return {
      code: 'FORGE-ENV-PERSISTENCE-FAILED',
      cause: `${dir}: falha ao provisionar ambiente (.env/configs): ${errorDetail(error)}`,
      remedy:
        'verifique a permissão de escrita no diretório da fonte e reexecute — o instalador grava .env e copia os configs de exemplo',
    };
  }
}

/** Sem script selecionável: distingue "sem rota de shell" de "fonte inválida". */
function noScriptFailure(
  det: SourceDetection,
  platform: NodeJS.Platform,
  winShells: WinSetupShells | undefined,
  pythonIssue?: { code?: string; cause: string; remedy?: string } | null,
): LocalFailure {
  if (platform === 'win32' && winShells !== undefined && !winShells.ps && !winShells.bash) {
    return winShellNotFound(det.path);
  }
  // A recusa da descoberta de Python vai junto: "sem bootstrap" causado
  // por pipeline FORGE-PYTHON-* é diagnóstico distinto de fonte quebrada.
  const pythonDetail = pythonIssue
    ? ` — descoberta de interpretador: ${pythonIssue.code ? `${pythonIssue.code}: ` : ''}${pythonIssue.cause}`
    : '';
  return {
    // O código FORGE-PYTHON-* da descoberta é preservado quando existe —
    // "sem bootstrap porque nenhum python executa" não é fonte inválida.
    code: (pythonIssue?.code as LocalFailure['code']) ?? 'FORGE-SOURCE-INVALID',
    cause:
      `${det.path}: sem script de setup executável (${platform === 'win32' ? 'setup.ps1/install.ps1/install.windows.sh' : 'setup.sh/install.sh'}) e sem fallback scripts/forge_bootstrap.py + interpretador` +
      pythonDetail,
    remedy:
      pythonIssue?.remedy ??
      'forneça o script de setup na fonte ou instale manualmente via scripts/forge_bootstrap.py',
  };
}

/**
 * `install <dir>` — classifica, confirma fonte parcial quando exigido,
 * provisiona .env/configs, roda o bootstrap no lugar e persiste o
 * receipt auditável. Recusas (estados não-instaláveis, sem script,
 * conflito com receipt registry) escrevem ZERO bytes.
 */
export async function localInstall(dir: string, deps: LocalDeps): Promise<LocalOutcome> {
  const run = deps.run ?? execaRun;
  const det = detectSource(dir);
  if (det.refusal) return fail(det.refusal, det);
  const gate = await partialGate(det, deps);
  if (gate) return fail(gate, det);
  const prior = loadForgeState(deps.home).forges[det.forge_id!];
  if (prior && prior.method === 'pypi') {
    return fail(
      {
        code: 'FORGE-SOURCE-CONFLICT',
        cause: `${det.forge_id}: já instalada via registry (PyPI) — uma fonte local não sobrescreve o receipt`,
        remedy: `remova primeiro com \`uninstall --method registry ${det.forge_id}\` ou atualize com \`update --method registry ${det.forge_id}\``,
      },
      det,
    );
  }
  // Piso do manifesto contra o interpretador SELECIONADO (lf-0017) —
  // antes de provisionar/escrever qualquer byte.
  const floorFailure = pythonFloorFailure(det, deps.python);
  if (floorFailure) return fail(floorFailure, det);

  const before = topLevelEntries(det.path);
  const envFailure = await provisionOrRefuse(det.path, det.forge_id);
  if (envFailure) return fail(envFailure, det);

  const platform = deps.platform ?? process.platform;
  const script = selectSetup(det, platform, deps.python, deps.winShells);
  if (!script) {
    return fail(noScriptFailure(det, platform, deps.winShells, deps.pythonIssue), det);
  }
  const res = await run(script.command, script.args, {
    cwd: det.path,
    timeoutMs: deps.timeoutMs,
  });
  if (res.exitCode !== 0) {
    return fail(
      {
        cause: `${script.file} saiu com código ${res.exitCode}${res.stderr ? ` — ${res.stderr.slice(0, 400)}` : ''}`,
        remedy: `rode ${script.file} manualmente em ${det.path} para ver o erro`,
      },
      det,
    );
  }

  const managed = [...topLevelEntries(det.path)].filter((e) => !before.has(e)).sort();
  const sourceFiles = snapshotSourceFiles(det.path, new Set(managed));
  const receipt = buildReceipt(
    det,
    deps,
    script,
    managed,
    sourceFiles,
    prior?.method === 'local' ? prior : undefined,
  );
  await runVerify(receipt, det, deps, run);

  try {
    await persistLocalReceipt(deps.home, receipt, deps.lifecycleLock);
    if (receipt.bin && existsSync(receipt.bin)) {
      try {
        receipt.shim = emitForgeShim(deps.home, receipt.bin, platform);
      } catch (shimError) {
        receipt.shimRefused = shimError instanceof Error ? shimError.message : String(shimError);
      }
      await persistLocalReceipt(deps.home, receipt, deps.lifecycleLock);
    }
  } catch (error) {
    return fail(
      {
        cause: `bootstrap executou mas o receipt/state falhou (${error instanceof Error ? error.message : error}) — instalação INCOMPLETA`,
        remedy: `reexecute \`install ${det.path}\` — o estado é regravado idempotentemente`,
      },
      det,
    );
  }
  if (!receipt.verify.ok) {
    return fail(
      {
        code: 'FORGE-INSTALL-VERIFICATION-FAILED',
        cause: `${det.forge_id}: \`${receipt.verify.command.join(' ')}\` saiu não-zero após o bootstrap`,
        remedy: `verifique a instalação em ${det.path} e rode o cli manualmente`,
      },
      det,
    );
  }
  return { ok: true, receipt, detection: det };
}

/**
 * `update <dir>` — o diretório É a fonte mais nova. Com `source_dir`
 * diferente do registrado, os arquivos da fonte são reconciliados por
 * substituição na fonte ORIGINAL (novos/alterados copiados; removidos
 * só os que o receipt registrou e a fonte nova não traz — arquivo do
 * usuário não registrado NUNCA é apagado). Sem fonte mais nova, o
 * caller recusa com FORGE-SOURCE-GITLESS antes de chegar aqui.
 */
export async function localUpdate(dir: string, deps: LocalDeps): Promise<LocalOutcome> {
  const run = deps.run ?? execaRun;
  const det = detectSource(dir);
  if (det.refusal) return fail(det.refusal, det);
  const forgeId = det.forge_id!;
  const prior = loadForgeState(deps.home).forges[forgeId];
  if (!prior || prior.method !== 'local') {
    return fail(
      {
        code: 'FORGE-SOURCE-NOT-FOUND',
        cause: `${forgeId}: nenhuma instalação local registrada para esta fonte`,
        remedy:
          prior?.method === 'pypi'
            ? `instalada via registry — use \`update --method registry ${forgeId}\``
            : `instale primeiro com \`install ${det.path}\``,
      },
      det,
    );
  }
  const gate = await partialGate(det, deps);
  if (gate) return fail(gate, det);

  const targetDir = prior.source_dir;
  // Fonte mais nova ≠ fonte registrada: reconciliação por substituição —
  // copia o que a nova traz e remove só o que o RECEIPT registrou e a
  // nova não tem. Arquivo plantado pelo usuário não está em
  // source_files → nunca é tocado.
  if (path.resolve(targetDir) !== det.path) {
    if (!existsSync(targetDir)) {
      return fail(
        {
          code: 'FORGE-SOURCE-NOT-FOUND',
          cause: `${forgeId}: fonte instalada ausente (${targetDir})`,
          remedy: `reinstale com \`install ${det.path}\` ou remova o registro com \`uninstall ${forgeId}\``,
        },
        det,
      );
    }
    const newFiles = snapshotSourceFiles(det.path, new Set());
    const keep = new Set(newFiles);
    for (const rel of newFiles) {
      const from = safeJoinInside(det.path, rel);
      const to = safeJoinInside(targetDir, rel);
      if (!from || !to) continue;
      mkdirSync(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    }
    for (const rel of prior.source_files) {
      if (keep.has(rel)) continue;
      const target = safeJoinInside(targetDir, rel);
      if (target && existsSync(target)) rmSync(target, { force: true });
    }
  }
  return runUpdateAt(targetDir, prior, deps, run);
}

async function runUpdateAt(
  dir: string,
  prior: LocalInstallReceipt,
  deps: LocalDeps,
  run: RunLike,
): Promise<LocalOutcome> {
  // Re-detecta na fonte que recebe o bootstrap (a registrada, já reconciliada).
  const det = detectSource(dir);
  if (det.refusal) return fail(det.refusal, det);
  const floorFailure = pythonFloorFailure(det, deps.python);
  if (floorFailure) return fail(floorFailure, det);
  const before = topLevelEntries(det.path);
  const envFailure = await provisionOrRefuse(det.path, det.forge_id);
  if (envFailure) return fail(envFailure, det);
  const platform = deps.platform ?? process.platform;
  const script = selectSetup(det, platform, deps.python, deps.winShells);
  if (!script) {
    if (
      platform === 'win32' &&
      deps.winShells !== undefined &&
      !deps.winShells.ps &&
      !deps.winShells.bash
    ) {
      return fail(winShellNotFound(det.path), det);
    }
    return fail(
      {
        code: (deps.pythonIssue?.code as LocalFailure['code']) ?? 'FORGE-SOURCE-INVALID',
        cause:
          `${det.path}: fonte atualizada sem script de setup executável` +
          (deps.pythonIssue
            ? ` — descoberta de interpretador: ${deps.pythonIssue.code ? `${deps.pythonIssue.code}: ` : ''}${deps.pythonIssue.cause}`
            : ''),
        remedy:
          deps.pythonIssue?.remedy ??
          'a fonte nova precisa de install.sh/setup.sh/install.windows.sh (ou scripts/forge_bootstrap.py + python)',
      },
      det,
    );
  }
  const res = await run(script.command, script.args, {
    cwd: det.path,
    timeoutMs: deps.timeoutMs,
  });
  if (res.exitCode !== 0) {
    return fail(
      {
        cause: `${script.file} saiu com código ${res.exitCode}${res.stderr ? ` — ${res.stderr.slice(0, 400)}` : ''}`,
        remedy: `rode ${script.file} manualmente em ${det.path}`,
      },
      det,
    );
  }
  const managed = [
    ...new Set([
      ...prior.managed_artifacts.filter((a) => existsSync(path.join(det.path, a))),
      ...[...topLevelEntries(det.path)].filter((e) => !before.has(e)),
    ]),
  ].sort();
  const sourceFiles = snapshotSourceFiles(det.path, new Set(managed));
  const receipt = buildReceipt(det, deps, script, managed, sourceFiles, prior);
  receipt.history = [
    ...(prior.history ?? []),
    { version: prior.version, installedAt: prior.updatedAt ?? prior.installedAt },
  ];
  await runVerify(receipt, det, deps, run);
  try {
    await persistLocalReceipt(deps.home, receipt, deps.lifecycleLock);
  } catch (error) {
    return fail(
      {
        cause: `update executou mas o receipt/state falhou (${error instanceof Error ? error.message : error})`,
        remedy: `reexecute \`update ${det.path}\``,
      },
      det,
    );
  }
  if (!receipt.verify.ok) {
    return fail(
      {
        code: 'FORGE-INSTALL-VERIFICATION-FAILED',
        cause: `${receipt.forge}: \`${receipt.verify.command.join(' ')}\` falhou após o update`,
        remedy: `verifique a instalação em ${det.path}`,
      },
      det,
    );
  }
  return { ok: true, receipt, detection: det };
}

/**
 * `reinstall <nome>` / repair de fonte local — NUNCA spawna git:
 * remove só os artefatos gerenciados registrados (venv e afins),
 * re-executa o bootstrap e repersiste o receipt. Arquivos do usuário e
 * da fonte original permanecem.
 */
export async function localRepair(name: string, deps: LocalDeps): Promise<LocalOutcome> {
  const run = deps.run ?? execaRun;
  const prior = loadForgeState(deps.home).forges[name];
  if (!prior) {
    return fail({
      code: 'FORGE-SOURCE-NOT-FOUND',
      cause: `${name}: nenhum receipt registrado`,
      remedy: `instale primeiro com \`install <dir>\``,
    });
  }
  if (prior.method !== 'local') {
    return fail({
      code: 'FORGE-SOURCE-INVALID',
      cause: `${name}: instalada via registry (PyPI) — o repair local não se aplica`,
      remedy: `use \`reinstall --method registry ${name}\``,
    });
  }
  const dir = prior.source_dir;
  if (!dir || !existsSync(dir)) {
    return fail({
      code: 'FORGE-SOURCE-NOT-FOUND',
      cause: `${name}: fonte local ausente (${dir ?? 'desconhecida'})`,
      remedy: `reinstale com \`install <dir>\` apontando a fonte ou remova o registro com \`uninstall ${name}\``,
    });
  }
  const det = detectSource(dir);
  if (det.refusal) return fail(det.refusal, det);
  const gate = await partialGate(det, deps);
  if (gate) return fail(gate, det);
  const floorFailure = pythonFloorFailure(det, deps.python);
  if (floorFailure) return fail(floorFailure, det);
  // Artefatos gerenciados quebrados (venv parcial etc.) saem antes do
  // bootstrap — só o que o RECEIPT registrou; arquivo do usuário não
  // listado permanece mesmo dentro da fonte.
  for (const rel of prior.managed_artifacts) {
    const target = safeJoinInside(dir, rel);
    if (target && existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
  const before = topLevelEntries(dir);
  const envFailure = await provisionOrRefuse(dir, det.forge_id);
  if (envFailure) return fail(envFailure, det);
  const platform = deps.platform ?? process.platform;
  const script = selectSetup(det, platform, deps.python, deps.winShells);
  if (!script) {
    if (
      platform === 'win32' &&
      deps.winShells !== undefined &&
      !deps.winShells.ps &&
      !deps.winShells.bash
    ) {
      return fail(winShellNotFound(dir), det);
    }
    return fail(
      {
        code: (deps.pythonIssue?.code as LocalFailure['code']) ?? 'FORGE-SOURCE-INVALID',
        cause:
          `${dir}: sem script de setup para o repair` +
          (deps.pythonIssue
            ? ` — descoberta de interpretador: ${deps.pythonIssue.code ? `${deps.pythonIssue.code}: ` : ''}${deps.pythonIssue.cause}`
            : ''),
        remedy:
          deps.pythonIssue?.remedy ??
          'restaure install.sh/setup.sh/install.windows.sh na fonte ou reinstale com `install <dir>`',
      },
      det,
    );
  }
  const res = await run(script.command, script.args, {
    cwd: dir,
    timeoutMs: deps.timeoutMs,
  });
  if (res.exitCode !== 0) {
    return fail(
      {
        cause: `${script.file} saiu com código ${res.exitCode}${res.stderr ? ` — ${res.stderr.slice(0, 400)}` : ''}`,
        remedy: `rode ${script.file} manualmente em ${dir}`,
      },
      det,
    );
  }
  const managed = [
    ...new Set([
      ...prior.managed_artifacts.filter((a) => existsSync(path.join(dir, a))),
      ...[...topLevelEntries(dir)].filter((e) => !before.has(e)),
    ]),
  ].sort();
  const sourceFiles = snapshotSourceFiles(dir, new Set(managed));
  const receipt = buildReceipt(det, deps, script, managed, sourceFiles, prior);
  await runVerify(receipt, det, deps, run);
  try {
    await persistLocalReceipt(deps.home, receipt, deps.lifecycleLock);
  } catch (error) {
    return fail(
      {
        cause: `repair executou mas o receipt/state falhou (${error instanceof Error ? error.message : error})`,
        remedy: `reexecute \`reinstall ${name}\``,
      },
      det,
    );
  }
  if (!receipt.verify.ok) {
    return fail(
      {
        code: 'FORGE-INSTALL-VERIFICATION-FAILED',
        cause: `${name}: \`${receipt.verify.command.join(' ')}\` falhou após o repair`,
        remedy: `verifique a instalação em ${dir}`,
      },
      det,
    );
  }
  return { ok: true, receipt, detection: det };
}

/**
 * `uninstall <nome>` de fonte local — remove SÓ os managed_artifacts
 * registrados dentro da fonte (venv, configs copiados, .env criado),
 * preservando arquivo do usuário e o diretório-fonte INTEIRO (nunca
 * `rm -rf` da fonte — ela não é nossa). Receipt, state e shim saem.
 */
export async function localUninstall(
  name: string,
  deps: LocalDeps,
): Promise<
  | { ok: true; forge: string; removed: string[]; backup?: string; sourceKept: string }
  | { ok: false; failure: LocalFailure }
> {
  const state = loadForgeState(deps.home);
  const prior = Object.hasOwn(state.forges, name) ? state.forges[name] : undefined;
  if (!prior) {
    return {
      ok: false,
      failure: {
        code: 'FORGE-SOURCE-NOT-FOUND',
        cause: `${name}: nenhum receipt registrado`,
        remedy: 'verifique o nome com `forge-cli status`',
      },
    };
  }
  if (prior.method !== 'local') {
    return {
      ok: false,
      failure: {
        code: 'FORGE-SOURCE-INVALID',
        cause: `${name}: instalada via registry (PyPI)`,
        remedy: `use \`uninstall --method registry ${name}\``,
      },
    };
  }
  const dir = prior.source_dir;
  const removed: string[] = [];
  let backup: string | undefined;
  if (dir && existsSync(dir)) {
    // Configs que criamos podem ter sido editadas pelo usuário — backup
    // antes de remover (mesma cortesia do uninstall git, que preserva
    // .env/configs em .forge-cli/backups).
    const filesToBackup = prior.managed_artifacts.filter((rel) => {
      const target = safeJoinInside(dir, rel);
      try {
        return target !== null && statSync(target).isFile();
      } catch {
        return false;
      }
    });
    if (filesToBackup.length) {
      backup = path.join(
        deps.home,
        '.forge-cli',
        'backups',
        `${name}-${(deps.now ?? (() => new Date().toISOString()))().replace(/[:.]/g, '-')}`,
      );
      for (const rel of filesToBackup) {
        const dest = path.join(backup, rel);
        mkdirSync(path.dirname(dest), { recursive: true });
        const src = safeJoinInside(dir, rel);
        if (src) await copyFile(src, dest);
      }
    }
    for (const rel of prior.managed_artifacts) {
      const target = safeJoinInside(dir, rel);
      if (target && existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
        removed.push(rel);
      }
    }
  }
  const res = await acquireForgeLock(deps.home, deps.lifecycleLock);
  if (!res.ok) {
    return { ok: false, failure: { cause: res.detail } };
  }
  try {
    // Shim gravado no receipt sai junto — nunca deriva nome de bin.
    removeForgeShim(deps.home, prior.shim ?? prior.bin, deps.platform ?? process.platform);
    // Envelope do receipt (~/.forge-cli/forges/<nome>) — a fonte fica.
    const envelope = resolveInside(forgesRoot(deps.home), name);
    if (envelope && existsSync(envelope)) rmSync(envelope, { recursive: true, force: true });
    const cur = loadForgeState(deps.home);
    if (Object.hasOwn(cur.forges, name)) {
      delete cur.forges[name];
      saveForgeState(deps.home, cur);
    }
  } finally {
    res.lock.release();
  }
  return {
    ok: true,
    forge: name,
    removed,
    ...(backup ? { backup } : {}),
    sourceKept: dir ?? '',
  };
}
