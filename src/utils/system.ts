import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { discoverPythons } from '../env/python.js';
import { isLinkOrJunction, isSafeRepoUrl, redactSecrets, resolveInside } from '../safety.js';
import type { ForgeRepo, SetupScript, SyncFailure, SyncResult } from '../types.js';

export const DEFAULT_WORKSPACE = './forge-workspace';

/* ── Ambiente de subprocessos (P0: anti-exfiltração) ──────────────────
 * Todo filho spawnado pelo CLI recebe um env MÍNIMO, nunca `process.env`
 * inteiro: scripts de setup de Forjas e fontes gitless são código de
 * terceiros — um `GITHUB_TOKEN`/`AWS_SECRET_ACCESS_KEY` ambiente seria
 * legível por qualquer instalador. A política é deny-first para nomes
 * com cara de credencial e allowlist para toolchain/OS; o escape hatch
 * documentado é `FORGE_CLI_ENV_ALLOW="FOO,BAR"` (re-admissão explícita
 * do operador — assume o risco conscientemente). */

/** Padrão de nome credential-shaped — negado antes da allowlist. */
const CREDENTIAL_ENV_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|_CREDS\b|^CREDS\b|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET_?KEY|SESSION_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY|MASTER_?KEY|RECOVERY_?KEY|CLIENT_?SECRET|OAUTH|BEARER|AUTHORIZATION|_AUTH_|_AUTH$|^AUTH_|^AUTH$|_JWT$|_DSN$|^DSN_|COOKIE|CONNECTION_?STRING|CONN_?STR|_PASS$|^PASS$|_PIN$|^PIN$|_KEY$|^KEY$)/i;

/** Nomes exatos admitidos — identidade de processo, OS, terminal,
 * toolchain e proxy corporativo (documentado: proxies podem embutir
 * credenciais na URL; necessários para instalação em rede corporativa —
 * `FORGE_CLI_ENV_ALLOW` é o caminho para ambientes que preferem cortar). */
const SAFE_ENV_NAMES = new Set(
  [
    // processo / identidade / OS
    'PATH', 'HOME', 'USER', 'LOGNAME', 'USERNAME', 'USERPROFILE', 'HOMEDRIVE',
    'HOMEPATH', 'USERDOMAIN', 'SHELL', 'SHLVL', 'PWD', 'OLDPWD', 'COMSPEC',
    'OS', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'PATHEXT', 'PUBLIC',
    'ALLUSERSPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES',
    'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'DRIVERDATA',
    'PSMODULEPATH', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL',
    'PROCESSOR_REVISION', 'MSYSTEM', 'PLINK_PROTOCOL', 'EXEPATH',
    // locale / terminal / UI
    'LANG', 'LANGUAGE', 'LC_ALL', 'TZ', 'TERM', 'COLORTERM', 'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION', 'TERMINFO', 'NO_COLOR', 'CLICOLOR',
    'CLICOLOR_FORCE', 'FORCE_COLOR', 'CI', 'LS_COLORS', 'EDITOR', 'VISUAL',
    'PAGER', 'MANPATH', 'INFOPATH',
    // temp
    'TMP', 'TEMP', 'TMPDIR',
    // proxy corporativo — ver comentário acima
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY',
    // TLS / CA corporativa
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
    'NODE_EXTRA_CA_CERTS', 'DENO_CERT', 'NIX_SSL_CERT_FILE',
    // python toolchain (nomes exatos — o resto entra por prefixo)
    'PYTHON', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP',
    'PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE', 'PYTHONIOENCODING',
    'PYTHONUTF8', 'PYTHONHASHSEED', 'PYTHONWARNINGS', 'PYTHONINSPECT',
    'PYTHONOPTIMIZE', 'PYTHONUNBUFFERED', 'VIRTUAL_ENV', 'VIRTUAL_ENV_PROMPT',
    'FORGE_PYTHON',
    // node toolchain
    'NODE', 'NODE_PATH', 'NODE_ENV', 'NODE_OPTIONS', 'NODE_REPL_HISTORY',
    // toolchains compiladas / JVM / .NET
    'CLASSPATH', 'GOPATH', 'GOROOT', 'GOPROXY', 'GOFLAGS', 'GOSUMDB',
    'GONOSUMDB', 'GONOSUMCHECK', 'GOPRIVATE', 'GOINSECURE', 'GOVCS',
    'RUSTFLAGS', 'RUSTC', 'NUGET_PACKAGES', 'CMAKE_PREFIX_PATH',
    'PKG_CONFIG_PATH', 'CHOCOLATEYINSTALL', 'SCOOP',
    // descoberta interna do próprio CLI
    'FORGE_CLI_HOME', 'FORGE_CLI_PROBE_TIMEOUT_MS', 'FORGE_CLI_ENV_ALLOW',
    'FORGE_CLI_QUIET', 'FORGE_CLI_FORCE_TTY', 'FORGE_CLI_AI_CMD',
    'FORGE_HOME_OVERRIDE',
  ].map((n) => n.toUpperCase()),
);

/** Prefixos admitidos — famílias de toolchain/gerenciador/Forja. O deny
 * de credencial continua valendo (TWINE_PASSWORD, NPM_CONFIG_//TOKEN…). */
const SAFE_ENV_PREFIXES = [
  'LC_', 'XDG_',
  'PIP_', 'UV_', 'POETRY_', 'PIPX_', 'PDM_', 'HATCH_', 'FLIT_', 'RYE_',
  'TWINE_', 'NPM_CONFIG_',
  'PYENV_', 'RBENV_', 'NVM_', 'VOLTA_', 'FNM_', 'NODENV_', 'ASDF_',
  'MISE_', 'SDKMAN_', 'COREPACK_', 'PNPM_', 'YARN_', 'BUN_', 'DENO_',
  'NODE_',
  'CONDA_', 'MAMBA_', 'MICROMAMBA_',
  'JAVA_', 'JDK_', 'M2_', 'MAVEN_', 'GRADLE_', 'SBT_', 'COURSIER_',
  'CARGO_', 'RUSTUP_', 'RUST_',
  'GEM_', 'BUNDLE_', 'RUBY', 'RAILS_',
  'DOTNET_', 'NUGET_',
  'CMAKE_', 'PKG_CONFIG_',
  'MSYS', 'MINGW_', 'CYGWIN', 'WSL',
  'HOMEBREW_',
  // Forjas — variáveis públicas de configuração do ecossistema.
  'FORGE_', 'APIFORGE_', 'SPARKFORGE_', 'PLATFORMFORGE_', 'PRODUCTFORGE_',
  'THEFORGE_',
  // Cloud CLIs — config/perfis passam; credenciais continuam negadas.
  'AWS_', 'AZURE_', 'CLOUDSDK_', 'GCLOUD_', 'GOOGLE_',
  'KRB5',
];

/** `FORGE_CLI_ENV_ALLOW="A,B"` — re-admissão explícita do operador. */
export function envAllowList(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  for (const raw of String(env.FORGE_CLI_ENV_ALLOW ?? '').split(/[,;:]/)) {
    const name = raw.trim().toUpperCase();
    if (/^[A-Z_][A-Z0-9_]*$/.test(name)) out.add(name);
  }
  return out;
}

export interface ChildEnvOptions {
  /** Nomes exatos force-admitidos (checados ANTES do deny de credencial). */
  readonly allow?: readonly string[];
  /** Prefixos force-admitidos (checados ANTES do deny de credencial). */
  readonly allowPrefixes?: readonly string[];
  /** Fonte — default `process.env` (injetável em testes). */
  readonly base?: NodeJS.ProcessEnv;
}

/**
 * Monta o env de um subprocesso: allowlist de toolchain/OS + regras
 * explícitas do caller + `FORGE_CLI_ENV_ALLOW`, com deny-first para
 * nomes credential-shaped. `GIT_TERMINAL_PROMPT=0` é injetado sempre —
 * o CLI é não-interativo por desenho; um prompt de credencial git é um
 * hang garantido, não uma feature.
 */
export function childEnv(opts: ChildEnvOptions = {}): NodeJS.ProcessEnv {
  const allow = envAllowList(opts.base ?? process.env);
  for (const n of opts.allow ?? []) {
    const name = n.trim().toUpperCase();
    if (name) allow.add(name);
  }
  const allowPrefixes = (opts.allowPrefixes ?? []).map((p) => p.toUpperCase());
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(opts.base ?? process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (allow.has(upper) || allowPrefixes.some((p) => upper.startsWith(p))) {
      env[key] = value;
      continue;
    }
    if (CREDENTIAL_ENV_RE.test(upper)) continue;
    if (SAFE_ENV_NAMES.has(upper) || SAFE_ENV_PREFIXES.some((p) => upper.startsWith(p))) {
      env[key] = value;
    }
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** Filho `git`: GIT_* + SSH_* re-admitidos (SSH_AUTH_SOCK para git@…). */
const GIT_CHILD_ENV: ChildEnvOptions = {
  allowPrefixes: ['GIT_', 'SSH_'],
};

/** `git`, `git.exe`, `C:\…\git.exe` → mesmo comando (win32 usa path). */
function isGitCommand(command: string): boolean {
  return /^(?:.*[\\/])?git(?:\.(?:exe|cmd|bat))?$/i.test(command.trim());
}

function normalizeWinPath(env: NodeJS.ProcessEnv): void {
  const winPath = env.Path ?? env.PATH;
  delete env.PATH;
  delete env.Path;
  if (winPath) env.Path = winPath;
}

/**
 * Env completo de um subprocesso genérico — substitui o antigo
 * `{...process.env}`: use com `extendEnv: false` no execa para que o
 * ambiente ambiente NÃO vaze de volta por cima do scrub.
 */
export function portableEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...childEnv(), ...extra };
  if (process.platform === 'win32') normalizeWinPath(env);
  return env;
}

/** Resolve git by absolute path on Windows hosts with unreliable PATH lookup. */
export function gitExecutable(): string {
  if (process.platform !== 'win32') return 'git';
  const raw = process.env.Path ?? process.env.PATH ?? '';
  for (const dir of raw.split(path.delimiter)) {
    const candidate = path.join(dir, 'git.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'git';
}

/**
 * Env completo para `command` — `git` recebe prefixos GIT_ e SSH_ a
 * mais; o resto segue a allowlist comum. Sempre `extendEnv: false`.
 */
export function commandEnv(command: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const git = isGitCommand(command);
  const env = { ...childEnv(git ? GIT_CHILD_ENV : undefined), ...extra };
  if (process.platform === 'win32') {
    normalizeWinPath(env);
    if (git) {
      const exe = gitExecutable();
      if (path.isAbsolute(exe)) {
        const current = env.Path ?? '';
        env.Path = `${path.dirname(exe)}${path.delimiter}${current}`;
      }
    }
  }
  return env;
}

/** Git nunca pode pedir credencial no TTY — prompt = hang. */
export const GIT_NO_PROMPT: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };

/** Tetos das operações git de rede — remoto pendurado não pode travar
 * clone/pull para sempre (o fetch já era bounded via NO_PROMPT). */
export const GIT_FETCH_TIMEOUT_MS = 120_000;
export const GIT_PULL_TIMEOUT_MS = 300_000;
export const GIT_CLONE_TIMEOUT_MS = 600_000;

function executable(command: string): string {
  return command.toLowerCase() === 'git' ? gitExecutable() : command;
}

/** Home do estado forge-cli — `FORGE_CLI_HOME` permite home hermético
 * (bench, testes, containers). Hosts continuam no home real do usuário. */
export function cliHome(): string {
  return process.env.FORGE_CLI_HOME || os.homedir();
}

/**
 * Cadeias de script de setup por rota (ciclo 12.1, lf-0016). Windows tem
 * DUAS rotas nativas: `.ps1` via PowerShell/pwsh e `.sh` via Git Bash
 * (`install.windows.sh` é o script dedicado — lf-0018 — seguido dos
 * candidatos POSIX, que o Git Bash executa nativamente). WSL, Cygwin e
 * MSYS2 nunca entram na cadeia — reportados pela descoberta, não rotas.
 */
const WIN_PS_SETUP_CANDIDATES = ['setup.ps1', 'install.ps1'];
const WIN_BASH_SETUP_CANDIDATES = ['install.windows.sh', 'setup.sh', 'install.sh'];
const POSIX_SETUP_CANDIDATES = ['setup.sh', 'install.sh'];

/**
 * Shells de setup resolvidas pela descoberta (`windowsSetupShells`):
 * `ps` = condutor .ps1 verificado (powershell.exe|pwsh), `bash` = bash.exe
 * do Git for Windows verificado executando. Ausente na posição = rota
 * indisponível — capability é execução verificada, nunca palpite de PATH.
 */
export interface WinSetupShells {
  ps?: string;
  bash?: string;
}

export function resolveTargetDir(input: string | undefined, cwd = process.cwd()): string {
  const trimmed = input?.trim();
  return path.resolve(cwd, trimmed ? trimmed : DEFAULT_WORKSPACE);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export function hasGitRepo(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

const PKG_FILE_MAX_BYTES = 256 * 1024;
const PYPROJECT_NAME_RE = /^\s*name\s*=\s*["']([^"']+)["']\s*$/m;

/**
 * Identidade de conteúdo de um checkout — lê `[project] name` do
 * `pyproject.toml` ou `"name"` do `package.json` (limitado a 256 KiB,
 * nunca lança). É o que reconhece um ZIP extraído sem `.git` como uma
 * Forja do catálogo: `product-forge-main/` com `name = "product-forge"`
 * é a Forja `product-forge`. `null` = sem evidência (ausente/ilegível).
 */
export function packageIdentity(dir: string): { name: string; file: string } | null {
  try {
    const pyproject = path.join(dir, 'pyproject.toml');
    if (existsSync(pyproject)) {
      const text = readFileSync(pyproject, 'utf8');
      if (text.length <= PKG_FILE_MAX_BYTES) {
        const match = PYPROJECT_NAME_RE.exec(text);
        if (match) return { name: match[1], file: 'pyproject.toml' };
      }
    }
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      const text = readFileSync(pkg, 'utf8');
      if (text.length <= PKG_FILE_MAX_BYTES) {
        const parsed: unknown = JSON.parse(text);
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { name?: unknown }).name === 'string'
        ) {
          return { name: (parsed as { name: string }).name, file: 'package.json' };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Lista nomes de um diretório — determinismo de enumeração, nunca lança. */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Candidatos de executável node, em ordem — para quando `node` não está no
 * PATH mas a máquina tem instalação (portable, nvm, scoop, chocolatey…).
 * O primeiro é sempre `process.execPath`: o interpretador que ESTÁ rodando
 * este CLI — evidência real de capacidade, nunca palpite. Os literais são
 * só caminhos prováveis; quem chama filtra por `existsSync` e sonda
 * `--version` antes de acreditar.
 */
export function nodeExecutables(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string | null | undefined) => {
    if (!candidate) return;
    const key = candidate.toLowerCase().replace(/\//g, '\\');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };
  if (/^node/i.test(path.basename(process.execPath))) push(process.execPath);
  // path.win32.join / path.posix.join: candidates must carry the TARGET
  // platform's separators even when discovery is simulated off-OS (tests,
  // CI on Linux) — bare path.join leaks host separators into the list.
  const wj = path.win32.join;
  if (platform === 'win32') {
    for (const pf of [env.PROGRAMFILES, env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (pf) push(wj(pf, 'nodejs', 'node.exe'));
    }
    push('C:\\Program Files\\nodejs\\node.exe');
    push('C:\\Progra~1\\nodejs\\node.exe');
    // nvm-windows: symlink (NVM_SYMLINK) + versões instaladas sob NVM_HOME.
    if (env.NVM_SYMLINK) push(wj(env.NVM_SYMLINK, 'node.exe'));
    const nvmRoots = [env.NVM_HOME, env.APPDATA ? wj(env.APPDATA, 'nvm') : null];
    for (const root of nvmRoots) {
      if (!root) continue;
      for (const ver of safeReaddir(root)) push(wj(root, ver, 'node.exe'));
    }
    push('C:\\nvm4w\\nodejs\\node.exe');
    // scoop e chocolatey — gerenciadores comuns fora do PATH padrão.
    push(wj(home, 'scoop', 'apps', 'nodejs', 'current', 'node.exe'));
    push(wj(home, 'scoop', 'apps', 'nodejs-lts', 'current', 'node.exe'));
    const chocoLib = wj(env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'lib');
    for (const dir of safeReaddir(chocoLib)) {
      if (/^nodejs/i.test(dir)) push(wj(chocoLib, dir, 'tools', 'node.exe'));
    }
    push(wj(home, 'AppData', 'Local', 'Volta', 'bin', 'node.exe'));
  } else {
    const pj = path.posix.join;
    push('/usr/local/bin/node');
    push('/opt/homebrew/bin/node');
    if (platform === 'linux') push('/home/linuxbrew/.linuxbrew/bin/node');
    const nvmDir = env.NVM_DIR ?? pj(home, '.nvm');
    const nvmVersions = pj(nvmDir, 'versions', 'node');
    for (const ver of safeReaddir(nvmVersions)) {
      push(pj(nvmVersions, ver, 'bin', 'node'));
    }
    push(pj(home, '.volta', 'bin', 'node'));
    push(pj(home, '.asdf', 'shims', 'node'));
    const mise = pj(home, '.local', 'share', 'mise', 'installs', 'node');
    for (const ver of safeReaddir(mise)) push(pj(mise, ver, 'bin', 'node'));
  }
  return out;
}

/** Diretório do pacote instalado — sobe até achar o package.json do próprio CLI. */
export function findPackageRoot(startDir: string, pkgName = 'theforge-cli'): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    const identity = packageIdentity(dir);
    if (identity?.file === 'package.json' && identity.name === pkgName) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Sugestão de workspace — o diretório onde já vivem checkouts das Forjas.
 * Caso comum: clone/zip extraído como `E:\projetos\FORJAS\forge-cli` → o
 * pai `E:\projetos\FORJAS` já contém os irmãos do catálogo. Em instalação
 * npm global o pai não tem checkouts → `null` (sem sugestão inventada).
 * Ordem: `cwd` (contexto explícito do usuário), depois o pai do pacote.
 */
export function suggestWorkspaceDir(
  repoNames: readonly string[],
  opts: { cwd?: string; selfDir?: string; exists?: (dir: string) => boolean } = {},
): string | null {
  const exists = opts.exists ?? existsSync;
  const names = new Set(repoNames.map((n) => n.toLowerCase()));
  const hasCheckout = (dir: string): boolean => {
    try {
      return readdirSync(dir, { withFileTypes: true }).some(
        (entry) => entry.isDirectory() && names.has(entry.name.toLowerCase()),
      );
    } catch {
      return false;
    }
  };
  const candidates: string[] = [];
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  candidates.push(cwd);
  const selfRoot = findPackageRoot(opts.selfDir ?? path.dirname(fileURLToPath(import.meta.url)));
  if (selfRoot) {
    const parent = path.dirname(selfRoot);
    if (parent !== cwd) candidates.push(parent);
  }
  for (const dir of candidates) {
    if (exists(dir) && hasCheckout(dir)) return dir;
  }
  return null;
}

/**
 * Escolhe o script de setup pelo OS + shells verificadas. Em `win32` sem
 * `winShells` mantém o comportamento legado (só cadeia `.ps1` via
 * powershell.exe); com `winShells` a cadeia é `.ps1` quando `ps` existe
 * senão `.sh` via Git Bash — `install.windows.sh` primeiro, depois os
 * candidatos POSIX que o Git Bash executa. `{}` (sondado, nada encontrado)
 * = sem rota → `null`; `undefined` (não sondado) = legado.
 */
export function findSetupScript(
  repoDir: string,
  platform: NodeJS.Platform = process.platform,
  winShells?: WinSetupShells,
): SetupScript | null {
  if (platform === 'win32') {
    const ps = winShells === undefined ? 'powershell.exe' : winShells.ps;
    if (ps) {
      for (const file of WIN_PS_SETUP_CANDIDATES) {
        if (existsSync(path.join(repoDir, file))) {
          return {
            file,
            command: ps,
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
          };
        }
      }
    }
    const bash = winShells?.bash;
    if (bash) {
      for (const file of WIN_BASH_SETUP_CANDIDATES) {
        if (existsSync(path.join(repoDir, file))) {
          return { file, command: bash, args: [file] };
        }
      }
    }
    return null;
  }
  for (const file of POSIX_SETUP_CANDIDATES) {
    if (existsSync(path.join(repoDir, file))) {
      return { file, command: 'sh', args: ['-c', `chmod +x ${file} && ./${file}`] };
    }
  }
  return null;
}

export function npmInstallArgs(repoDir: string): string[] | null {
  if (!existsSync(path.join(repoDir, 'package.json'))) return null;
  return existsSync(path.join(repoDir, 'package-lock.json')) ? ['ci'] : ['install'];
}

export function withCmdExt(bin: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && /^(npm|npx|pnpm|yarn)$/i.test(bin) ? `${bin}.cmd` : bin;
}

/**
 * Teto de um probe externo de ambiente (versão/auth/toolchain). Um shim
 * que nunca responde — `cursor --version` Electron girando por >4min no
 * E2E do ciclo 11.2.1 — não pode travar doctor/hosts-list/preflight.
 * `FORGE_CLI_PROBE_TIMEOUT_MS` (inteiro >0, ms) sobrescreve o default.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export function probeTimeoutMs(): number {
  const raw = Number(process.env.FORGE_CLI_PROBE_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_PROBE_TIMEOUT_MS;
}

export async function commandWorks(
  command: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const result = await execa(executable(command), args, {
      reject: false,
      timeout: opts.timeoutMs ?? probeTimeoutMs(),
      env: commandEnv(command),
      extendEnv: false,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve o interpretador Python disponível — agora delega ao pipeline
 * lf-0017 (`discoverPythons`): FORGE_PYTHON, venvs, managers e locais
 * de plataforma entram, e toda seleção foi validada por `--version`.
 * `null` = nenhum interpretador válido (a recusa detalhada vive no
 * relatório de descoberta — `env discover` a expõe).
 */
export async function resolvePython(): Promise<string[] | null> {
  const discovery = await discoverPythons({});
  return discovery.selected?.argv ?? null;
}

export async function commandOutput(
  command: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  try {
    // Sem timeout um shim de host pode girar para sempre (host Electron
    // travado manteve `doctor`/`hosts list` bloqueados >4 min — E2E-A).
    const result = await execa(executable(command), args, {
      reject: false,
      timeout: opts.timeoutMs ?? probeTimeoutMs(),
      env: commandEnv(command),
      extendEnv: false,
    });
    if (result.exitCode !== 0) return null;
    return (result.stdout || result.stderr || '').trim() || 'ok';
  } catch {
    return null;
  }
}

/** Resultado detalhado de um probe — distingue timeout de sem-saída. */
export interface CommandProbeResult {
  output: string | null;
  /**
   * true = processo morto por timeout — INCONCLUSIVO, nunca "ausente":
   * um shim que não responde não é evidência de que o host não existe.
   */
  timedOut: boolean;
}

export async function commandProbe(
  command: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<CommandProbeResult> {
  const timeoutMs = opts.timeoutMs ?? probeTimeoutMs();
  try {
    const result = await execa(executable(command), args, {
      reject: false,
      timeout: timeoutMs,
      env: commandEnv(command),
      extendEnv: false,
    });
    if (result.timedOut) return { output: null, timedOut: true };
    if (result.exitCode !== 0) return { output: null, timedOut: false };
    return { output: (result.stdout || result.stderr || '').trim() || 'ok', timedOut: false };
  } catch {
    return { output: null, timedOut: false };
  }
}

export async function isGitDirty(repoDir: string): Promise<boolean> {
  try {
    const { stdout } = await execa(gitExecutable(), ['status', '--porcelain'], {
      cwd: repoDir,
      env: commandEnv('git'),
      extendEnv: false,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function currentHead(repoDir: string): Promise<string | null> {
  return commandOutput('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
}

function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^https?:\/\/[^@/]+@/, 'https://')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function sameRemote(a: string, b: string): boolean {
  return normalizeRemote(a) === normalizeRemote(b);
}

export function classifyGitFailure(message: string): SyncFailure {
  if (
    /authentication failed|could not read username|permission denied|403|terminal prompts disabled/i.test(
      message,
    )
  )
    return 'auth';
  if (/not possible to fast-forward|divergent|diverged|refusing to merge/i.test(message))
    return 'diverged';
  if (
    /could not resolve host|unable to access|timed out|connection (refused|reset)|network is unreachable/i.test(
      message,
    )
  )
    return 'network';
  return 'unknown';
}

export interface SyncOptions {
  shallow?: boolean;
  noPull?: boolean;
  offline?: boolean;
}

export async function syncRepo(
  repo: ForgeRepo,
  targetDir: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const repoDir = resolveInside(targetDir, repo.name);
  if (!repoDir) throw new Error(`nome de repositório inválido: ${repo.name}`);
  if (!isSafeRepoUrl(repo.url)) throw new Error(`URL de repositório não permitida: ${repo.name}`);
  if (isLinkOrJunction(repoDir)) {
    throw new Error(`destino é link simbólico/junction: ${repo.name}`);
  }
  if (existsSync(repoDir)) {
    if (!hasGitRepo(repoDir)) return { kind: 'non-git', dirty: false };
    const dirty = await isGitDirty(repoDir);
    const remote = await commandOutput('git', ['-C', repoDir, 'remote', 'get-url', 'origin']);
    if (remote && remote !== 'ok' && !sameRemote(remote, repo.url)) {
      return { kind: 'remote-mismatch', dirty };
    }
    if (opts.offline) return { kind: 'fixed-ref', dirty };
    if (opts.noPull) {
      await execa(gitExecutable(), ['fetch', '--quiet', '--tags'], {
        cwd: repoDir,
        reject: false,
        timeout: GIT_FETCH_TIMEOUT_MS,
        env: commandEnv('git', GIT_NO_PROMPT),
        extendEnv: false,
      });
      return { kind: 'fixed-ref', dirty };
    }
    try {
      await execa(gitExecutable(), ['pull', '--ff-only'], {
        cwd: repoDir,
        timeout: GIT_PULL_TIMEOUT_MS,
        env: commandEnv('git', GIT_NO_PROMPT),
        extendEnv: false,
      });
      return { kind: 'pulled', dirty };
    } catch (error) {
      return { kind: 'pull-failed', dirty, failure: classifyGitFailure(errorDetail(error)) };
    }
  }
  if (opts.offline) throw new Error(`modo offline: ${repo.name} não está clonada localmente`);
  const cloneArgs = opts.shallow ? ['clone', '--depth', '1'] : ['clone'];
  await execa(gitExecutable(), [...cloneArgs, '--', repo.url, repoDir], {
    timeout: GIT_CLONE_TIMEOUT_MS,
    env: commandEnv('git', GIT_NO_PROMPT),
    extendEnv: false,
  });
  return { kind: 'cloned', dirty: false };
}

export async function runStreamed(
  argv: readonly string[],
  cwd: string,
  onLine?: (line: string) => void,
  timeoutMs?: number,
): Promise<void> {
  const [bin, ...args] = argv;
  const sub = execa(bin.toLowerCase() === 'git' ? gitExecutable() : withCmdExt(bin), args, {
    cwd,
    all: true,
    buffer: false,
    timeout: timeoutMs,
    env: commandEnv(bin),
    extendEnv: false,
  });
  for await (const line of sub.iterable({ from: 'all' })) {
    onLine?.(redactSecrets(line));
  }
  await sub;
}

export function errorDetail(error: unknown): string {
  if (error && typeof error === 'object') {
    const err = error as { shortMessage?: string; stderr?: string; message?: string };
    return redactSecrets(err.stderr?.trim() || err.shortMessage || err.message || String(error));
  }
  return redactSecrets(String(error));
}
