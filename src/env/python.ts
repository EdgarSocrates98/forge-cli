/**
 * Pipeline universal de descoberta de interpretadores Python (lf-0017).
 *
 * Responde "qual interpretador EXECUTA e satisfaz o piso", nunca "qual
 * caminho parece Python": todo candidato é validado executando
 * `<exe> --version` com timeout ≤ `PYTHON_PROBE_TIMEOUT_MS` (5 s) — a
 * versão vem da saída executada, não do nome do arquivo. O pipeline é
 * determinístico (estágios em ordem fixa, enumerações de diretório
 * ordenadas, dedup por realpath resolvido) e offline (nenhum probe toca
 * a rede, nunca baixa/instala Python).
 *
 * Estágios, na ordem do spec (FASE 4):
 *
 *   0. `FORGE_PYTHON` (seleção explícita — vence tudo)
 *   1. `--python` (seleção explícita do chamador)
 *   2. launcher `py` do Windows (`py -3.14`…`py -3.10`, `py -3`, `py -2`, `py`)
 *   3. nomes do PATH (`python3.14`…`python3.10`, `python3`, `python`)
 *   4. venv ativa (`VIRTUAL_ENV`) + `.venv`/`venv` do diretório alvo
 *   5. version managers (pyenv, uv, conda/mamba, asdf)
 *   6. locais de plataforma (AppData/Program Files + registry PEP 514 no
 *      Windows; /usr/bin, /usr/local/bin, /opt/*\/bin e prefixos Homebrew
 *      no POSIX)
 *   7. diretórios convencionais junto ao repo (`./python*`, `./tools/python*`)
 *
 * Seleção: explícito (estágio 0/1) vence a descoberta automática e JAMAIS
 * cai para ela quando inválido — o erro nomeia o FORGE-PYTHON-* do
 * veredito. Na seleção automática vence a maior versão compatível
 * (estável antes de pré-release); empates resolvem por estágio e depois
 * por caminho. Cada candidato sai com `{executable, source, version,
 * valid, verdict}` no relatório — inclusive os rejeitados.
 *
 * Alias da Microsoft Store: caminho contendo `WindowsApps` cujo probe
 * não produz versão é `store-stub` — conta como não-encontrado, nunca
 * como interpretador real. Um `python` legítimo instalado pela Store
 * (sob `Program Files\WindowsApps\PythonSoftwareFoundation…`) responde
 * `--version` de verdade e passa normalmente.
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { ForgeErrorCode } from '../errors.js';
import {
  compareVersions,
  isPrerelease,
  parseSpecifier,
  parseVersion,
  satisfiesRequiresPython,
  type ParsedVersion,
} from '../registry/versions.js';
import type { ProbeOutcome, ProbeRun } from './shells.js';

/** Teto de cada probe `<exe> --version` / `command -v` — spec: ≤ 5 s. */
export const PYTHON_PROBE_TIMEOUT_MS = 5_000;
/**
 * Teto de candidatos sondados por descoberta — bound do orçamento total
 * (spec: "overall discovery budget bounded"; ≤32 × 5 s no pior caso).
 */
export const PYTHON_DISCOVERY_MAX_CANDIDATES = 32;
/** Piso default quando o chamador não traz `requires-python` próprio. */
export const DEFAULT_PYTHON_FLOOR = '>=3.10';
/** Variável de ambiente de seleção explícita — estágio 0 do pipeline. */
export const PYTHON_ENV_VAR = 'FORGE_PYTHON';

/** Origem do candidato — valor estável do campo `source` do receipt. */
export type PythonSource =
  | 'env' // FORGE_PYTHON (explícito)
  | 'flag' // --python (explícito)
  | 'py-launcher'
  | 'path'
  | 'venv'
  | 'pyenv'
  | 'uv'
  | 'conda'
  | 'mamba'
  | 'asdf'
  | 'platform'
  | 'conventional';

export type PythonVerdict =
  | 'ok'
  /** Nome não resolvido no PATH — ausente, não quebrado. */
  | 'absent'
  /** Probe falhou/não-zero/timeout/saída irreconhecível. */
  | 'unexecutable'
  /** Executou mas ficou abaixo do piso exigido. */
  | 'incompatible'
  /** Alias da Microsoft Store (WindowsApps sem versão real). */
  | 'store-stub';

export interface PythonCandidate {
  /** Invocação completa — `['py','-3.11']`, `['/opt/x/bin/python3.12']`. */
  argv: string[];
  /** Forma de exibição — path resolvido quando conhecido, senão `argv`. */
  executable: string;
  source: PythonSource;
  /** Estágio do pipeline (0 = FORGE_PYTHON … 7 = convencional). */
  stage: number;
}

/** Candidato após o probe de validação — contrato `{executable, source, version, valid, verdict}` + detalhe. */
export interface ProbedPythonCandidate extends PythonCandidate {
  /** Versão EXECUTADA (`X.Y.Z[pre]`), null quando o probe não produziu. */
  version: string | null;
  parsed: ParsedVersion | null;
  valid: boolean;
  verdict: PythonVerdict;
  /** Código FORGE-* do veredito inválido (null quando `ok`). */
  code: ForgeErrorCode | null;
  /** Detalhe auditável — timeout, saída irreconhecível, alias Store… */
  note: string | null;
  /** Caminho real resolvido (chave de dedup) quando o candidato é arquivo. */
  real_path?: string;
}

export interface PythonSelection {
  argv: string[];
  executable: string;
  source: PythonSource;
  version: string;
  parsed: ParsedVersion;
  selection_reason: string;
}

/** Recusa FORGE-PYTHON-* de topo — causa + remédio acionável (PT-BR). */
export interface PythonRefusal {
  code: ForgeErrorCode;
  cause: string;
  remedy: string;
}

export interface PythonDiscovery {
  /** Todos os candidatos sondados, na ordem do pipeline (cap aplicado). */
  candidates: ProbedPythonCandidate[];
  /** Candidatos enumerados mas cortados pelo cap — evidência de bound. */
  truncated: number;
  selected: PythonSelection | null;
  /** Seleção explícita foi pedida (FORGE_PYTHON/--python). */
  explicit_requested: boolean;
  /** Piso de versão efetivamente avaliado. */
  floor: string;
  /** O piso era verificável dentro do subconjunto PEP 440 suportado. */
  floor_known: boolean;
  refusal: PythonRefusal | null;
}

export interface PythonDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: ProbeRun;
  exists?: (target: string) => boolean;
  /** Entradas de diretório (nomes) — default `readdirSync`. */
  readdir?: (dir: string) => string[];
  realpath?: (target: string) => string;
  osHome?: string;
  cwd?: string;
  /** Diretório-alvo dos estágios venv/convencional — default `cwd`. */
  targetDir?: string;
  /** `--python` do chamador — estágio 1, perde só para FORGE_PYTHON. */
  explicit?: string;
  /** Piso PEP 440 — default `>=3.10`. Versão nua (`3.11`) vira `>=3.11`. */
  floor?: string;
  /** Teto de candidatos sondados — default {@link PYTHON_DISCOVERY_MAX_CANDIDATES}. */
  maxCandidates?: number;
}

interface ResolvedPythonDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run: ProbeRun;
  exists: (target: string) => boolean;
  readdir: (dir: string) => string[];
  realpath: (target: string) => string;
  osHome: string;
  cwd: string;
  targetDir: string;
  explicit?: string;
  floor: string;
  maxCandidates: number;
}

/** Probe real via execa — mesma forma de `commandProbe`, ≤ 5 s. */
const defaultRun: ProbeRun = async (command, args): Promise<ProbeOutcome> => {
  try {
    const res = await execa(command, args, {
      reject: false,
      timeout: PYTHON_PROBE_TIMEOUT_MS,
    });
    if (res.timedOut) return { ok: false, output: null, timed_out: true };
    if (res.exitCode !== 0) {
      return {
        ok: false,
        output: (res.stderr || res.stdout || '').trim() || null,
        timed_out: false,
      };
    }
    // Saída vazia NÃO vira 'ok': `command -v` com stdout vazio é evidência
    // de não-resolução e `--version` sem saída é `unexecutable` igual.
    return {
      ok: true,
      output: (res.stdout || res.stderr || '').trim() || null,
      timed_out: false,
    };
  } catch {
    return { ok: false, output: null, timed_out: false };
  }
};

/** Piso utilizável: `3.11` nu vira `>=3.11`; especificador é usado como veio. */
export function normalizePythonFloor(floor: string | undefined): string {
  const trimmed = (floor ?? '').trim();
  if (!trimmed) return DEFAULT_PYTHON_FLOOR;
  return parseVersion(trimmed) ? `>=${trimmed}` : trimmed;
}

function resolvePythonDeps(deps: PythonDeps): ResolvedPythonDeps {
  const cwd = deps.cwd ?? process.cwd();
  return {
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    run: deps.run ?? defaultRun,
    exists: deps.exists ?? existsSync,
    readdir: deps.readdir ?? ((dir) => readdirSync(dir)),
    realpath:
      deps.realpath ??
      ((target) => {
        try {
          return realpathSync(target);
        } catch {
          return target;
        }
      }),
    osHome: deps.osHome ?? os.homedir(),
    cwd,
    targetDir: deps.targetDir ?? cwd,
    explicit: deps.explicit,
    floor: normalizePythonFloor(deps.floor),
    maxCandidates: deps.maxCandidates ?? PYTHON_DISCOVERY_MAX_CANDIDATES,
  };
}

/** Variantes do executável dentro de uma venv/instalação, por plataforma. */
function venvBins(root: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? [path.join(root, 'Scripts', 'python.exe'), path.join(root, 'python.exe')]
    : [path.join(root, 'bin', 'python'), path.join(root, 'bin', 'python3')];
}

function pushIfExists(
  out: PythonCandidate[],
  file: string,
  source: PythonSource,
  stage: number,
  exists: (t: string) => boolean,
): void {
  if (!exists(file)) return;
  out.push({ argv: [file], executable: file, source, stage });
}

/** Lista nomes de `dir` ordenados — determinismo de enumeração. */
function sortedEntries(d: ResolvedPythonDeps, dir: string): string[] {
  try {
    return d.readdir(dir).sort();
  } catch {
    return [];
  }
}

/** `python3.12`, `python.exe`, `python3.12.exe` — exclui `*-config`, `pythonw`. */
const PYTHON_NAME_RE = /^python\d*(?:\.\d+)*(?:\.exe)?$/i;

/** Stage 2 — launcher `py` (win32): specs do spec + versões concretas. */
function pyLauncherCandidates(_d: ResolvedPythonDeps): PythonCandidate[] {
  const specs = ['-3.14', '-3.13', '-3.12', '-3.11', '-3.10', '-3', '-2'];
  const out: PythonCandidate[] = specs.map((spec) => ({
    argv: ['py', spec],
    executable: `py ${spec}`,
    source: 'py-launcher',
    stage: 2,
  }));
  out.push({ argv: ['py'], executable: 'py', source: 'py-launcher', stage: 2 });
  return out;
}

/** Stage 3 — nomes do PATH (não resolvidos; `command -v` decide `absent`). */
function pathCandidates(d: ResolvedPythonDeps): PythonCandidate[] {
  const names =
    d.platform === 'win32'
      ? ['python', 'python3']
      : ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'];
  return names.map((name) => ({
    argv: [name],
    executable: name,
    source: 'path',
    stage: 3,
  }));
}

/** Stage 4 — `VIRTUAL_ENV` + `.venv`/`venv` do diretório-alvo. */
function venvCandidates(d: ResolvedPythonDeps): PythonCandidate[] {
  const out: PythonCandidate[] = [];
  const venv = d.env.VIRTUAL_ENV;
  if (venv) {
    for (const bin of venvBins(venv, d.platform)) {
      pushIfExists(out, bin, 'venv', 4, d.exists);
    }
  }
  for (const name of ['.venv', 'venv']) {
    const root = path.join(d.targetDir, name);
    for (const bin of venvBins(root, d.platform)) {
      pushIfExists(out, bin, 'venv', 4, d.exists);
    }
  }
  return out;
}

/** Raízes de version managers — env primeiro, defaults depois. */
function managerCandidates(d: ResolvedPythonDeps): PythonCandidate[] {
  const out: PythonCandidate[] = [];
  // pyenv: PYENV_ROOT ou ~/.pyenv — versions/*/bin/python (ordenado).
  const pyenvRoot = d.env.PYENV_ROOT ?? path.join(d.osHome, '.pyenv');
  const pyenvVersions = path.join(pyenvRoot, 'versions');
  for (const ver of sortedEntries(d, pyenvVersions)) {
    const root = path.join(pyenvVersions, ver);
    for (const bin of venvBins(root, d.platform)) {
      pushIfExists(out, bin, 'pyenv', 5, d.exists);
    }
    if (d.platform === 'win32') {
      pushIfExists(out, path.join(root, 'python.exe'), 'pyenv', 5, d.exists);
    }
  }
  // uv-managed pythons: UV_PYTHON_INSTALL_DIR / XDG_DATA_HOME / defaults —
  // <raiz>/<install>/bin/python* (POSIX) ou <raiz>/<install>/python.exe.
  const uvRoots: string[] = [];
  if (d.env.UV_PYTHON_INSTALL_DIR) uvRoots.push(d.env.UV_PYTHON_INSTALL_DIR);
  if (d.env.XDG_DATA_HOME) uvRoots.push(path.join(d.env.XDG_DATA_HOME, 'uv', 'python'));
  uvRoots.push(
    d.platform === 'win32'
      ? path.join(d.env.LOCALAPPDATA ?? path.join(d.osHome, 'AppData', 'Local'), 'uv', 'python')
      : path.join(d.osHome, '.local', 'share', 'uv', 'python'),
  );
  const seenUv = new Set<string>();
  for (const root of uvRoots) {
    const key = path.normalize(root);
    if (seenUv.has(key)) continue;
    seenUv.add(key);
    for (const install of sortedEntries(d, root)) {
      const dir = path.join(root, install);
      for (const bin of [
        path.join(dir, 'bin', 'python3'),
        path.join(dir, 'bin', 'python'),
        path.join(dir, 'python.exe'),
      ]) {
        pushIfExists(out, bin, 'uv', 5, d.exists);
      }
    }
  }
  // conda/mamba: base + envs — CONDA_PREFIX (env ativa) e prefixos usuais.
  const condaRoots: { dir: string; source: PythonSource }[] = [];
  if (d.env.CONDA_PREFIX) {
    condaRoots.push({ dir: d.env.CONDA_PREFIX, source: 'conda' });
  }
  for (const name of ['miniconda3', 'anaconda3']) {
    condaRoots.push({ dir: path.join(d.osHome, name), source: 'conda' });
    if (d.platform === 'win32')
      condaRoots.push({ dir: path.join(d.osHome, name), source: 'conda' });
  }
  for (const name of ['miniforge3', 'mambaforge']) {
    condaRoots.push({ dir: path.join(d.osHome, name), source: 'mamba' });
  }
  const seenConda = new Set<string>();
  for (const { dir: root, source } of condaRoots) {
    const key = path.normalize(root);
    if (seenConda.has(key)) continue;
    seenConda.add(key);
    for (const bin of venvBins(root, d.platform)) {
      pushIfExists(out, bin, source, 5, d.exists);
    }
    for (const env of sortedEntries(d, path.join(root, 'envs'))) {
      for (const bin of venvBins(path.join(root, 'envs', env), d.platform)) {
        pushIfExists(out, bin, source, 5, d.exists);
      }
    }
  }
  // asdf: installs/python/*/bin/python + shims (ASDF_DATA_DIR ou ~/.asdf).
  const asdfDir = d.env.ASDF_DATA_DIR ?? path.join(d.osHome, '.asdf');
  for (const ver of sortedEntries(d, path.join(asdfDir, 'installs', 'python'))) {
    for (const bin of venvBins(path.join(asdfDir, 'installs', 'python', ver), d.platform)) {
      pushIfExists(out, bin, 'asdf', 5, d.exists);
    }
  }
  for (const shim of ['python', 'python3']) {
    pushIfExists(out, path.join(asdfDir, 'shims', shim), 'asdf', 5, d.exists);
  }
  return out;
}

/** Stage 6 — locais de plataforma (fs somente; registry vem por probe). */
function platformCandidates(d: ResolvedPythonDeps): PythonCandidate[] {
  const out: PythonCandidate[] = [];
  const pushDirPythons = (dir: string) => {
    for (const name of sortedEntries(d, dir)) {
      if (!PYTHON_NAME_RE.test(name)) continue;
      pushIfExists(out, path.join(dir, name), 'platform', 6, d.exists);
    }
  };
  if (d.platform === 'win32') {
    const locals = [
      d.env.LOCALAPPDATA ? path.join(d.env.LOCALAPPDATA, 'Programs', 'Python') : null,
      path.join(d.osHome, 'AppData', 'Local', 'Programs', 'Python'),
    ];
    const seen = new Set<string>();
    for (const base of locals) {
      if (!base || seen.has(base)) continue;
      seen.add(base);
      for (const install of sortedEntries(d, base)) {
        if (!/^python\d*/i.test(install)) continue;
        pushIfExists(out, path.join(base, install, 'python.exe'), 'platform', 6, d.exists);
      }
    }
    for (const pf of [d.env.PROGRAMFILES, d.env.ProgramFiles, d.env['ProgramFiles(x86)']]) {
      if (!pf) continue;
      for (const install of sortedEntries(d, pf)) {
        if (!/^python\d*/i.test(install)) continue;
        pushIfExists(out, path.join(pf, install, 'python.exe'), 'platform', 6, d.exists);
      }
    }
    return out;
  }
  pushDirPythons('/usr/bin');
  pushDirPythons('/usr/local/bin');
  for (const opt of sortedEntries(d, '/opt')) {
    pushDirPythons(path.join('/opt', opt, 'bin'));
  }
  // Homebrew: prefixo declarado, macOS arm64, Intel e Linuxbrew.
  const brewBins = new Set<string>();
  if (d.env.HOMEBREW_PREFIX) brewBins.add(path.join(d.env.HOMEBREW_PREFIX, 'bin'));
  brewBins.add('/opt/homebrew/bin');
  brewBins.add('/usr/local/bin'); // já coberto — dedup resolve
  if (d.platform === 'linux') brewBins.add('/home/linuxbrew/.linuxbrew/bin');
  for (const bin of [...brewBins].sort()) pushDirPythons(bin);
  // Cellar do python via Homebrew (prefixos opt/python@X.Y).
  for (const prefix of [d.env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local']) {
    if (!prefix) continue;
    for (const opt of sortedEntries(d, path.join(prefix, 'opt'))) {
      if (!/^python@/.test(opt)) continue;
      pushDirPythons(path.join(prefix, 'opt', opt, 'bin'));
    }
  }
  return out;
}

/** Stage 7 — `./python*` e `./tools/python*` do diretório-alvo. */
function conventionalCandidates(d: ResolvedPythonDeps): PythonCandidate[] {
  const out: PythonCandidate[] = [];
  for (const base of [d.targetDir, path.join(d.targetDir, 'tools')]) {
    for (const name of sortedEntries(d, base)) {
      if (!/^python/i.test(name)) continue;
      const root = path.join(base, name);
      // Diretório `python*/bin/python|python3` ou `python*/python.exe`;
      // o próprio nome pode ser o executável (shim/arquivo).
      for (const bin of [...venvBins(root, d.platform), root]) {
        pushIfExists(out, bin, 'conventional', 7, d.exists);
      }
    }
  }
  return out;
}

/**
 * Estágio explícito (0/1): o valor pode ser path absoluto, nome do PATH
 * ou invocação com args (`FORGE_PYTHON="py -3.11"` — token único quando
 * o literal não existe no disco). Nunca recai para auto.
 */
function explicitCandidate(
  value: string,
  source: 'env' | 'flag',
  stage: 0 | 1,
  d: ResolvedPythonDeps,
): PythonCandidate {
  const trimmed = value.trim();
  if (d.exists(trimmed) || !/\s/.test(trimmed)) {
    return { argv: [trimmed], executable: trimmed, source, stage };
  }
  const argv = trimmed.split(/\s+/);
  return { argv, executable: trimmed, source, stage };
}

/**
 * Chaves de registry PEP 514 consultadas em win32 — `reg query` é
 * somente-leitura; a saída lista `InstallPath`/`ExecutablePath` das
 * distribuições registradas (python.org, NuGet, ActiveState…).
 */
const PY_REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\Python\\PythonCore',
  'HKCU\\SOFTWARE\\Python\\PythonCore',
  'HKLM\\SOFTWARE\\WOW6432Node\\Python\\PythonCore',
];

/** Extrai caminhos de instalação de `reg query … /s` — regex conservador. */
function pythonPathsFromRegQuery(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/REG_SZ\s+(.+)$/i);
    if (!m) continue;
    const value = m[1].trim().replace(/"+$/, '').replace(/^"+/, '');
    if (!/^[A-Za-z]:[\\/]/.test(value)) continue;
    found.add(path.join(value, 'python.exe'));
    found.add(value);
  }
  return [...found].sort();
}

/** Resolve nome do PATH via `command -v`/`where` — evidência do realpath. */
async function resolvePathName(d: ResolvedPythonDeps, name: string): Promise<string | null> {
  const probe =
    d.platform === 'win32'
      ? await d.run('where.exe', [name])
      : await d.run('sh', ['-c', `command -v ${name}`]);
  if (!probe.ok || !probe.output) return null;
  const first = probe.output.split(/\r?\n/, 1)[0]?.trim();
  return first || null;
}

const VERSION_OUT_RE = /Python\s+(\d+\.\d+\.\d+(?:[a-z]+\d+)?)/i;
/** Alias da Store: `…\WindowsApps\python.exe` / `Program Files\WindowsApps\…`. */
const STORE_PATH_RE = /windowsapps/i;

function candidateDisplay(c: PythonCandidate): string {
  return c.executable || c.argv.join(' ');
}

/**
 * Probe de validação de UM candidato — a ÚNICA execução permitida:
 * `<argv> --version` com timeout ≤ 5 s. Nunca infere versão do nome/path.
 */
async function probeCandidate(
  d: ResolvedPythonDeps,
  candidate: PythonCandidate,
): Promise<ProbedPythonCandidate> {
  const base: ProbedPythonCandidate = {
    ...candidate,
    version: null,
    parsed: null,
    valid: false,
    verdict: 'absent',
    code: 'FORGE-PYTHON-NOT-FOUND',
    note: null,
  };
  const exe = candidate.argv[0];
  const isPath = exe.includes('/') || exe.includes('\\') || d.exists(exe);
  if (!isPath) {
    // Nome de PATH — resolve primeiro para dedup real e para distinguir
    // "não existe no PATH" (absent) de "existe mas não executa".
    const resolved = await resolvePathName(d, exe);
    if (!resolved) {
      base.verdict = 'absent';
      base.note = `não resolvido no PATH (${exe})`;
      return base;
    }
    base.real_path = d.realpath(resolved);
    base.executable = resolved;
  } else if (d.exists(exe)) {
    base.real_path = d.realpath(exe);
  } else {
    base.verdict = 'absent';
    base.note = `arquivo ausente: ${exe}`;
    return base;
  }

  const probe = await d.run(candidate.argv[0], [...candidate.argv.slice(1), '--version']);
  const storePath =
    STORE_PATH_RE.test(candidate.argv.join(' ')) || STORE_PATH_RE.test(base.real_path ?? '');
  if (!probe.ok) {
    if (storePath && !probe.timed_out) {
      base.verdict = 'store-stub';
      base.code = 'FORGE-PYTHON-NOT-FOUND';
      base.note =
        'alias da Microsoft Store (WindowsApps) — não é um interpretador real; desative em "Aliases de execução de aplicativo" ou instale Python de python.org';
      return base;
    }
    base.verdict = 'unexecutable';
    base.code = 'FORGE-PYTHON-UNEXECUTABLE';
    base.note = probe.timed_out
      ? `timeout após ${PYTHON_PROBE_TIMEOUT_MS}ms em --version`
      : `\`${candidateDisplay(candidate)} --version\` falhou (não-zero/sem execução)`;
    return base;
  }
  const match = probe.output?.match(VERSION_OUT_RE);
  if (!match) {
    if (storePath) {
      base.verdict = 'store-stub';
      base.code = 'FORGE-PYTHON-NOT-FOUND';
      base.note =
        'alias da Microsoft Store (WindowsApps) — saída sem versão; desative o alias ou instale Python de python.org';
      return base;
    }
    base.verdict = 'unexecutable';
    base.code = 'FORGE-PYTHON-UNEXECUTABLE';
    base.note = `\`${candidateDisplay(candidate)} --version\` saiu 0 mas sem versão reconhecível`;
    return base;
  }
  const parsed = parseVersion(match[1]);
  if (!parsed) {
    base.verdict = 'unexecutable';
    base.code = 'FORGE-PYTHON-UNEXECUTABLE';
    base.note = `versão fora do subconjunto PEP 440 suportado: ${match[1]}`;
    return base;
  }
  base.version = match[1];
  base.parsed = parsed;
  const sat = satisfiesRequiresPython(d.floor, parsed);
  if (sat === false) {
    base.verdict = 'incompatible';
    base.code = 'FORGE-PYTHON-INCOMPATIBLE';
    base.note = `Python ${base.version} não satisfaz o piso ${d.floor}`;
    return base;
  }
  base.valid = true;
  base.verdict = 'ok';
  base.code = null;
  if (sat === null) {
    base.note = `piso ${d.floor} fora do subconjunto verificável — aceito pela execução, sem prova do piso`;
  } else if (storePath) {
    base.note = 'instalação da Microsoft Store (WindowsApps) — interpretador real, não alias';
  }
  return base;
}

/** Enumera todos os candidatos na ordem do pipeline — explícito primeiro. */
async function enumerateCandidates(d: ResolvedPythonDeps): Promise<PythonCandidate[]> {
  const out: PythonCandidate[] = [];
  const envValue = d.env[PYTHON_ENV_VAR]?.trim();
  if (envValue) out.push(explicitCandidate(envValue, 'env', 0, d));
  if (d.explicit?.trim()) out.push(explicitCandidate(d.explicit, 'flag', 1, d));
  if (d.platform === 'win32') out.push(...pyLauncherCandidates(d));
  out.push(...pathCandidates(d));
  out.push(...venvCandidates(d));
  out.push(...managerCandidates(d));
  out.push(...platformCandidates(d));
  out.push(...conventionalCandidates(d));
  if (d.platform === 'win32') {
    // PEP 514 — reg query somente-leitura; cada chave é uma sonda ≤5 s.
    for (const key of PY_REGISTRY_KEYS) {
      const res = await d.run('reg.exe', ['query', key, '/s']);
      if (!res.ok || !res.output) continue;
      for (const file of pythonPathsFromRegQuery(res.output)) {
        pushIfExists(out, file, 'platform', 6, d.exists);
      }
    }
  }
  return out;
}

/** Dedup por caminho real resolvido — o primeiro estágio vence o empate. */
function dedupKey(candidate: PythonCandidate, realPath?: string): string {
  // Realpath resolvido + argumentos da invocação: `py -3.12` e `py -3.10`
  // compartilham o realpath do launcher mas apontam interpretadores
  // distintos — a spec faz parte da identidade do candidato.
  const args = candidate.argv.slice(1).join(' ');
  const raw = `${realPath ?? candidate.argv[0]} ${args}`.trim();
  return raw.toLowerCase();
}

const PLATFORM_GUIDANCE: Record<string, string> = {
  win32:
    'instale Python ≥3.10 de https://www.python.org/downloads/ ou `winget install Python.Python.3.13`, ou aponte com --python/FORGE_PYTHON. Aliases da Microsoft Store não valem — desative-os em Configurações → Aliases de execução de aplicativo',
  darwin:
    'instale Python ≥3.10 de https://www.python.org/downloads/, `brew install python@3.13` ou pyenv — ou aponte com --python/FORGE_PYTHON',
  default:
    'instale Python ≥3.10 de https://www.python.org/downloads/ ou do gerenciador da sua distro (apt/dnf/pacote pyenv/uv) — ou aponte com --python/FORGE_PYTHON',
};

function platformGuidance(platform: NodeJS.Platform): string {
  return PLATFORM_GUIDANCE[platform] ?? PLATFORM_GUIDANCE.default;
}

function describeRejects(candidates: ProbedPythonCandidate[]): string {
  return candidates
    .map((c) => `  ${c.executable} [${c.source}] → ${c.version ?? 'sem versão'} (${c.verdict})`)
    .join('\n');
}

function refusalFor(
  d: ResolvedPythonDeps,
  candidates: ProbedPythonCandidate[],
  explicit: boolean,
): PythonRefusal | null {
  const label = explicit
    ? d.env[PYTHON_ENV_VAR]?.trim()
      ? `FORGE_PYTHON=${d.env[PYTHON_ENV_VAR]}`
      : `--python ${d.explicit}`
    : null;
  const explicitFailed = candidates.filter((c) => c.stage <= 1 && !c.valid);
  if (explicit) {
    const failed = explicitFailed.length ? explicitFailed : candidates.filter((c) => !c.valid);
    const first = failed[0];
    const code =
      first?.verdict === 'incompatible'
        ? 'FORGE-PYTHON-INCOMPATIBLE'
        : first?.verdict === 'unexecutable'
          ? 'FORGE-PYTHON-UNEXECUTABLE'
          : 'FORGE-PYTHON-NOT-FOUND';
    return {
      code,
      cause: `${label}: seleção explícita inválida — ${first ? `${first.executable}: ${first.note ?? first.verdict}` : 'sem candidato'}`,
      remedy:
        'corrija o caminho/versão apontado ou remova a seleção explícita para usar a descoberta automática — o forge-cli NUNCA cai para auto quando o explícito falha',
    };
  }
  if (!candidates.length) {
    return {
      code: 'FORGE-PYTHON-NOT-FOUND',
      cause: 'nenhum candidato a interpretador Python encontrado nos 8 estágios do pipeline',
      remedy: platformGuidance(d.platform),
    };
  }
  const executed = candidates.filter((c) => c.version !== null);
  if (executed.length && executed.every((c) => !c.valid)) {
    return {
      code: 'FORGE-PYTHON-INCOMPATIBLE',
      cause: `interpretadores encontrados mas nenhum satisfaz o piso ${d.floor}:\n${describeRejects(executed)}`,
      remedy: `instale Python compatível com ${d.floor} (${platformGuidance(d.platform)})`,
    };
  }
  const broken = candidates.filter((c) => c.verdict === 'unexecutable');
  const stubs = candidates.filter((c) => c.verdict === 'store-stub');
  if (broken.length && !stubs.length && !executed.length) {
    return {
      code: 'FORGE-PYTHON-UNEXECUTABLE',
      cause: `candidatos a Python encontrados mas nenhum executa --version:\n${describeRejects(broken)}`,
      remedy: `repare/remova os executáveis quebrados ou aponte um interpretador válido com --python/FORGE_PYTHON — ${platformGuidance(d.platform)}`,
    };
  }
  return {
    code: 'FORGE-PYTHON-NOT-FOUND',
    cause:
      `nenhum interpretador Python utilizável${stubs.length ? ` — ${stubs.length} candidato(s) são aliases da Microsoft Store (não executam)` : ''}` +
      (broken.length ? `; ${broken.length} candidato(s) falharam na sonda` : ''),
    remedy: platformGuidance(d.platform),
  };
}

/**
 * Seleção automática — maior versão compatível; estável antes de
 * pré-release (mesma regra do `selectInterpreter` do registry); empate
 * por estágio do pipeline e depois por `executable` (lexicográfico).
 */
function selectAuto(candidates: ProbedPythonCandidate[]): ProbedPythonCandidate | null {
  const valid = candidates.filter((c) => c.valid && c.parsed);
  if (!valid.length) return null;
  const stable = valid.filter((c) => !isPrerelease(c.parsed!));
  const pool = stable.length ? stable : valid;
  return pool.slice().sort((a, b) => {
    const byVersion = compareVersions(b.parsed!, a.parsed!);
    if (byVersion !== 0) return byVersion;
    if (a.stage !== b.stage) return a.stage - b.stage;
    return a.executable < b.executable ? -1 : a.executable > b.executable ? 1 : 0;
  })[0];
}

function selectionOf(c: ProbedPythonCandidate, reason: string): PythonSelection {
  return {
    argv: c.argv,
    executable: c.executable,
    source: c.source,
    version: c.version!,
    parsed: c.parsed!,
    selection_reason: reason,
  };
}

/**
 * Descoberta completa — enumera (ordem fixa), deduplica por realpath,
 * sonda cada candidato e seleciona. Explícito inválido = recusa, nunca
 * fallback. Retorna o relatório inteiro para `env discover`/receipts.
 */
export async function discoverPythons(deps: PythonDeps = {}): Promise<PythonDiscovery> {
  const d = resolvePythonDeps(deps);
  const enumerated = await enumerateCandidates(d);
  const explicitRequested = enumerated.some((c) => c.stage <= 1);

  // Dedup ANTES dos probes: nomes de PATH resolvem via command -v/where
  // para o realpath — `python3` e `/usr/bin/python3` são o mesmo binário.
  const probed: ProbedPythonCandidate[] = [];
  const seenKeys = new Set<string>();
  const capped = enumerated.slice(0, d.maxCandidates);
  const truncated = enumerated.length - capped.length;
  for (const candidate of capped) {
    const result = await probeCandidate(d, candidate);
    const key = dedupKey(result, result.real_path);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    probed.push(result);
  }

  let selected: PythonSelection | null = null;
  let refusal: PythonRefusal | null = null;
  if (explicitRequested) {
    // Estágio 0 (FORGE_PYTHON) vence estágio 1 (--python); ambos foram
    // sondados — o primeiro válido na ordem do pipeline é a seleção.
    const winner = probed.find((c) => c.stage <= 1 && c.valid) ?? null;
    if (winner) {
      selected = selectionOf(
        winner,
        winner.source === 'env'
          ? `seleção explícita via ${PYTHON_ENV_VAR} (estágio 0 do pipeline)`
          : `seleção explícita via --python (estágio 1 do pipeline)`,
      );
    } else {
      refusal = refusalFor(d, probed, true);
    }
  } else {
    const winner = selectAuto(probed);
    if (winner) {
      const total = probed.filter((c) => c.valid).length;
      selected = selectionOf(
        winner,
        `maior versão compatível com o piso ${d.floor} entre ${total} candidato(s) válido(s) (descoberta automática)`,
      );
    } else {
      refusal = refusalFor(d, probed, false);
    }
  }

  return {
    candidates: probed,
    truncated,
    selected,
    explicit_requested: explicitRequested,
    floor: d.floor,
    // Piso verificável = TODA cláusula parseia no subconjunto PEP 440.
    floor_known: d.floor
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .every((part) => parseSpecifier(part) !== null),
    refusal,
  };
}
