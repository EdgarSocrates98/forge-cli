import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadState } from './artifacts.js';
import { FORGE_REPOS } from './constants/repos.js';
import { resolveDiscovery, type DiscoverySource, type DiscoveryState } from './contracts/index.js';
import { readForgeManifest } from './manifest.js';
import { isLinkOrJunction, resolveInside } from './safety.js';
import type { CliState } from './artifacts.js';
import {
  commandOutput,
  commandWorks,
  hasGitRepo,
  resolvePython,
  withCmdExt,
} from './utils/system.js';

// ---------------------------------------------------------------------------
// §2.1 bounded environment discovery → forge-cli/EnvReport/v1.
// Every collection is bounded: the walk never leaves targetDir, never follows
// links/junctions, honors depth/entry/time limits and never throws — partial
// results are reported with `truncated: true`. Probes are `--version` calls on
// local CLIs only; .env files are recorded by path and never read.
// ---------------------------------------------------------------------------

export interface DiscoveryLimits {
  maxDepth: number;
  maxEntriesPerDir: number;
  maxTotalEntries: number;
  timeoutMs: number;
  skipDirs: readonly string[];
}

export const DEFAULT_LIMITS: DiscoveryLimits = {
  maxDepth: 3,
  maxEntriesPerDir: 500,
  maxTotalEntries: 5000,
  timeoutMs: 2000,
  skipDirs: [
    'node_modules',
    '.git',
    '.venv',
    'venv',
    'dist',
    'build',
    '__pycache__',
    '.idea',
    '.vscode',
    'coverage',
    'target',
    '.forge-cli',
  ],
};

export interface ToolInfo {
  name: string;
  found: boolean;
  version?: string | null;
  source?: string;
}

export interface MarkerHit {
  file: string;
  signals: string[];
}

export interface ForgePresence {
  name: string;
  path: string;
  git: boolean;
  manifest: boolean;
}

export interface HostProbe {
  name: string;
  detected: boolean;
  version?: string | null;
}

export interface ForgeDiscovery {
  name: string;
  state: DiscoveryState;
  evidence: string;
}

export interface EnvReport {
  schema: 'forge-cli/EnvReport/v1';
  generated_at: string;
  os: { platform: string; release: string; arch: string; shell: string | null };
  tools: ToolInfo[];
  workspace: {
    dir: string;
    markers: MarkerHit[];
    forges: ForgePresence[];
    env_files: string[];
  };
  hosts: HostProbe[];
  signals: string[];
  forges: ForgeDiscovery[];
  limits: DiscoveryLimits;
  truncated: boolean;
  duration_ms: number;
}

const MAX_FILE_BYTES = 256 * 1024;

// Marcadores por nome de arquivo (comparação em minúsculas).
const FILE_SIGNALS: Record<string, string[]> = {
  'package.json': ['node-app'],
  'pyproject.toml': ['python-app'],
  'setup.py': ['python-app'],
  'setup.cfg': ['python-app'],
  pipfile: ['python-app'],
  'pom.xml': ['java-app'],
  'build.gradle': ['java-app'],
  'build.gradle.kts': ['java-app'],
  'settings.gradle': ['java-app'],
  dockerfile: ['docker'],
  'compose.yaml': ['docker'],
  'compose.yml': ['docker'],
  'docker-compose.yml': ['docker'],
  'docker-compose.yaml': ['docker'],
  'forge.json': ['forge-manifest'],
  'forge.agentic.json': ['forge-manifest'],
  'azure-pipelines.yml': ['ci', 'azure'],
  '.gitlab-ci.yml': ['ci'],
  jenkinsfile: ['ci'],
  'chart.yaml': ['kubernetes'],
  'helmfile.yaml': ['kubernetes'],
  'kustomization.yaml': ['kubernetes'],
  '.mcp.json': ['mcp'],
  'mcp.json': ['mcp'],
  'claude.md': ['claude-host'],
  '.cursorrules': ['cursor-host'],
};

// Diretórios que também são evidência (registrados como MarkerHit).
const DIR_SIGNALS: Record<string, string[]> = {
  '.claude': ['claude-host'],
  '.codex': ['codex-host'],
  '.devin': ['devin-host'],
  '.cursor': ['cursor-host'],
  k8s: ['kubernetes'],
  kubernetes: ['kubernetes'],
  helm: ['kubernetes'],
  charts: ['kubernetes'],
};

// Sinais derivados de conteúdo (requirements/pyproject/tf/package.json deps).
const TEXT_DEP_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['pyspark', /\bpyspark\b|\bdelta-spark\b/],
  ['aws', /\b(?:boto3|botocore|awscli|aws-cdk|s3fs|amazonaws|aws-sam|moto)\b|provider\s+"aws"/],
  ['azure', /\bazure[-_.][\w.-]*|\bazure\b|provider\s+"azurerm"/],
  [
    'api',
    /\b(?:fastapi|uvicorn|connexion|openapi|flask|django|starlette|sanic|litestar|aiohttp|grpcio|protobuf)\b/,
  ],
  [
    'data',
    /\b(?:pandas|pyarrow|polars|dask|dbt|airflow|dagster|great[_-]expectations|jupyter|jupyterlab|notebook|sqlalchemy|duckdb|kafka-python|pymongo|psycopg|redis)\b/,
  ],
  [
    'observability',
    /\b(?:opentelemetry|otel|prometheus|ddtrace|datadog|dynatrace|sentry|newrelic)\b/,
  ],
  ['mcp', /\bmcp\b|modelcontextprotocol/],
];

const JS_DEP_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['frontend', /\breact\b|\breact-dom\b|@angular\/|\bvue\b|\bnext\b|\bsvelte\b|\bnuxt\b/],
  ['api', /\bexpress\b|\bfastify\b|@nestjs\/|\bkoa\b|\bhapi\b|\bgraphql\b|\btrpc\b|\bswagger/],
  ['aws', /@aws-sdk\/|\baws-sdk\b|\baws-cdk\b|aws-amplify|\bamazon\b/],
  ['azure', /@azure\//],
  ['mcp', /@modelcontextprotocol\//],
  ['data', /\bduckdb\b|apache-arrow|@duckdb\//],
];

/** Arquivos de marcador cujo conteúdo pode ser lido (≤256 KiB, texto). */
function isContentScanned(lowerName: string): boolean {
  return (
    lowerName === 'package.json' ||
    lowerName === 'pyproject.toml' ||
    lowerName === 'pipfile' ||
    lowerName === 'setup.py' ||
    /^requirements.*\.txt$/.test(lowerName) ||
    lowerName.endsWith('.tf')
  );
}

function readBoundedText(file: string): string | null {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const text = readFileSync(file, 'utf8');
    // arquivos "binary-ish" (NUL no conteúdo) nunca são varridos
    if (text.includes(String.fromCharCode(0))) return null;
    return text;
  } catch {
    return null;
  }
}

function depSignalsFromText(content: string): string[] {
  const text = content.toLowerCase();
  const out = new Set<string>();
  for (const [signal, re] of TEXT_DEP_SIGNALS) if (re.test(text)) out.add(signal);
  return [...out];
}

function depSignalsFromPackageJson(content: string): string[] {
  try {
    const pkg = JSON.parse(content) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]
      .join(' ')
      .toLowerCase();
    const out = new Set(depSignalsFromText(names));
    for (const [signal, re] of JS_DEP_SIGNALS) if (re.test(names)) out.add(signal);
    return [...out];
  } catch {
    return [];
  }
}

function fileSignals(lowerName: string): string[] {
  const out = new Set<string>(FILE_SIGNALS[lowerName] ?? []);
  if (lowerName === 'dockerfile' || lowerName.startsWith('dockerfile.')) out.add('docker');
  if (/^requirements.*\.txt$/.test(lowerName)) out.add('python-app');
  if (lowerName.endsWith('.tf')) out.add('terraform');
  return [...out];
}

function isEnvFile(lowerName: string): boolean {
  return lowerName === '.env' || lowerName.startsWith('.env.');
}

interface WalkResult {
  markers: MarkerHit[];
  envFiles: string[];
  topDirs: string[];
  signals: Set<string>;
  truncated: boolean;
}

/** Varredura limitada: só dentro de root, sem seguir links, nunca lança. */
function walkWorkspace(
  root: string,
  limits: DiscoveryLimits,
  budgetLeft: () => number,
): WalkResult {
  const markers: MarkerHit[] = [];
  const envFiles: string[] = [];
  const topDirs: string[] = [];
  const signals = new Set<string>();
  const skip = new Set(limits.skipDirs.map((d) => d.toLowerCase()));
  let truncated = false;
  let total = 0;
  const stack: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: '', depth: 0 }];

  while (stack.length) {
    if (budgetLeft() <= 0) {
      truncated = true;
      break;
    }
    const current = stack.pop();
    if (!current) break;
    const { dir, rel, depth } = current;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      continue; // permissão/corrida — ignora sem derrubar a varredura
    }
    if (entries.length > limits.maxEntriesPerDir) {
      truncated = true;
      entries = entries.slice(0, limits.maxEntriesPerDir);
    }
    for (const entry of entries) {
      if (++total > limits.maxTotalEntries) {
        truncated = true;
        return { markers, envFiles, topDirs, signals, truncated };
      }
      const lower = entry.name.toLowerCase();
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skip.has(lower) || isLinkOrJunction(full)) continue;
        if (depth === 0) topDirs.push(entry.name);
        const dirSigs =
          lower === 'workflows' && (rel === '.github' || rel.endsWith('/.github'))
            ? ['ci']
            : (DIR_SIGNALS[lower] ?? []);
        if (dirSigs.length) {
          for (const s of dirSigs) signals.add(s);
          markers.push({ file: relPath, signals: [...dirSigs].sort() });
        }
        if (depth + 1 <= limits.maxDepth) {
          stack.push({ dir: full, rel: relPath, depth: depth + 1 });
        } else {
          truncated = true; // há conteúdo além do limite de profundidade
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (isEnvFile(lower)) {
        // .env: registra só o caminho — conteúdo nunca é lido
        envFiles.push(relPath);
        signals.add('env');
        markers.push({ file: relPath, signals: ['env'] });
        continue;
      }
      const sigs = new Set(fileSignals(lower));
      if (isContentScanned(lower)) {
        const content = readBoundedText(full);
        if (content !== null) {
          const depSigs =
            lower === 'package.json'
              ? depSignalsFromPackageJson(content)
              : depSignalsFromText(content);
          for (const s of depSigs) sigs.add(s);
        }
      }
      if (!sigs.size) continue;
      const sorted = [...sigs].sort();
      for (const s of sorted) signals.add(s);
      markers.push({ file: relPath, signals: sorted });
    }
  }
  return { markers, envFiles, topDirs: topDirs.sort(), signals, truncated };
}

function firstLine(out: string | null): string | null {
  if (!out || out === 'ok') return null;
  return out.split(/\r?\n/)[0]?.trim() || null;
}

/** Corrida contra o orçamento restante — o total nunca é excedido. */
async function raced<T>(probe: Promise<T>, budgetMs: number, fallback: T): Promise<T> {
  if (budgetMs <= 0) return fallback;
  const timeout = new Promise<T>((resolve) => setTimeout(() => resolve(fallback), budgetMs));
  return Promise.race([probe.catch(() => fallback), timeout]);
}

async function probeTool(
  name: string,
  argv: readonly string[],
  budgetMs: number,
): Promise<ToolInfo> {
  const out = await raced(commandOutput(argv[0], [...argv.slice(1)]), budgetMs, null);
  const version = firstLine(out);
  return {
    name,
    found: out !== null,
    ...(version ? { version } : {}),
    source: argv.join(' '),
  };
}

async function probeTools(
  platform: NodeJS.Platform,
  budgetLeft: () => number,
): Promise<ToolInfo[]> {
  const tools: ToolInfo[] = [];
  tools.push(await probeTool('git', ['git', '--version'], budgetLeft()));
  tools.push(await probeTool('node', ['node', '--version'], budgetLeft()));
  tools.push(await probeTool('npm', [withCmdExt('npm'), '--version'], budgetLeft()));
  // python: resolve o interpretador real (python3, python, py -3)
  const pyArgv = await raced(resolvePython(), budgetLeft(), null);
  if (pyArgv) {
    const out = await raced(
      commandOutput(pyArgv[0], [...pyArgv.slice(1), '--version']),
      budgetLeft(),
      null,
    );
    tools.push({
      name: 'python',
      found: true,
      ...(firstLine(out) ? { version: firstLine(out) } : {}),
      source: pyArgv.join(' '),
    });
  } else {
    tools.push({ name: 'python', found: false });
  }
  tools.push(await probeTool('java', ['java', '--version'], budgetLeft()));
  tools.push(await probeTool('docker', ['docker', '--version'], budgetLeft()));
  tools.push(await probeTool('terraform', ['terraform', '--version'], budgetLeft()));
  if (platform === 'win32') {
    tools.push(
      await probeTool(
        'powershell',
        ['powershell.exe', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
        budgetLeft(),
      ),
    );
  } else {
    tools.push(await probeTool('bash', ['bash', '--version'], budgetLeft()));
  }
  return tools;
}

const HOST_CLIS = ['claude', 'codex', 'devin', 'cursor'] as const;

async function probeHosts(budgetLeft: () => number): Promise<HostProbe[]> {
  const hosts: HostProbe[] = [];
  for (const name of HOST_CLIS) {
    const detected = await raced(commandWorks(name, ['--version']), budgetLeft(), false);
    let version: string | null = null;
    if (detected) {
      version = firstLine(await raced(commandOutput(name, ['--version']), budgetLeft(), null));
    }
    hosts.push({ name, detected, ...(version ? { version } : {}) });
  }
  return hosts;
}

/** Estado derivado do registro local (.forge-cli/state.json) — origem 'manifest' (installation registry). */
function registryState(entry: CliState['repos'][string]): DiscoveryState {
  if (
    entry.status === 'error' ||
    entry.phase === 'failed' ||
    entry.phase === 'partial' ||
    entry.phase === 'drifted'
  ) {
    return 'degraded';
  }
  if (entry.phase === 'validated') return 'validated';
  if (entry.phase === 'installed' || entry.status === 'ok' || entry.status === 'warning') {
    return 'configured';
  }
  if (entry.phase === 'cloned' || entry.phase === 'prepared') return 'detected';
  return 'unknown';
}

function discoverForge(name: string, dir: string | null, state: CliState | null): ForgeDiscovery {
  const sources: DiscoverySource[] = [];
  const git = !!dir && hasGitRepo(dir);
  const manifest = dir && existsSync(dir) ? readForgeManifest(dir) : null;
  const entry = state?.repos[name];
  if (entry && entry.phase !== 'not-installed') {
    const dirExists = !!dir && existsSync(dir);
    sources.push({
      origin: 'manifest',
      // registro diz instalada mas o checkout sumiu → evidência falhando
      state: dirExists ? registryState(entry) : 'degraded',
      forge_id: name,
      evidence: dirExists
        ? `state.json: ${entry.phase ?? entry.status}`
        : 'state.json sem checkout',
    });
  }
  if (manifest) {
    sources.push({
      origin: 'manifest',
      state: 'declared',
      forge_id: name,
      evidence: `${name}/forge.json`,
    });
  }
  if (git) {
    sources.push({
      origin: 'catalog',
      state: 'detected',
      forge_id: name,
      evidence: `${name}/ (checkout git)`,
    });
  }
  sources.push({
    origin: 'catalog',
    state: 'unknown',
    forge_id: name,
    evidence: 'nenhuma evidência local',
  });
  const resolved = resolveDiscovery(sources);
  return {
    name,
    state: resolved?.state ?? 'unknown',
    evidence: resolved?.evidence ?? 'nenhuma evidência local',
  };
}

export async function discoverEnvironment(
  targetDir: string,
  opts?: { limits?: Partial<DiscoveryLimits>; now?: () => number },
): Promise<EnvReport> {
  const now = opts?.now ?? Date.now;
  const start = now();
  const limits: DiscoveryLimits = { ...DEFAULT_LIMITS, ...opts?.limits };
  const budgetLeft = () => limits.timeoutMs - (now() - start);
  const root = path.resolve(targetDir);

  const walk = walkWorkspace(root, limits, budgetLeft);
  const tools = await probeTools(process.platform, budgetLeft);
  const hosts = await probeHosts(budgetLeft);
  const signals = new Set(walk.signals);
  for (const host of hosts) if (host.detected) signals.add(`${host.name}-host`);

  const state = loadState(root);
  const catalogNames = new Set(FORGE_REPOS.map((r) => r.name));
  const forges: ForgeDiscovery[] = [];
  for (const repo of FORGE_REPOS) {
    forges.push(discoverForge(repo.name, resolveInside(root, repo.name), state));
  }
  const presence: ForgePresence[] = [];
  for (const dirName of walk.topDirs) {
    const dir = resolveInside(root, dirName);
    if (!dir) continue;
    const git = hasGitRepo(dir);
    const manifest = existsSync(path.join(dir, 'forge.json'));
    if (!git && !manifest) continue;
    presence.push({ name: dirName, path: dirName, git, manifest });
    // Forja fora do catálogo: só entra em `forges` quando se declara (forge.json válido)
    if (!catalogNames.has(dirName) && manifest) {
      const parsed = readForgeManifest(dir);
      forges.push({
        name: parsed?.forgeId ?? dirName,
        state: 'declared',
        evidence: `${dirName}/forge.json`,
      });
    }
  }

  return {
    schema: 'forge-cli/EnvReport/v1',
    generated_at: new Date(now()).toISOString(),
    os: {
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      shell: process.env.SHELL ?? process.env.ComSpec ?? null,
    },
    tools,
    workspace: {
      dir: root,
      markers: walk.markers,
      forges: presence,
      env_files: walk.envFiles.sort(),
    },
    hosts,
    signals: [...signals].sort(),
    forges,
    limits,
    truncated: walk.truncated,
    duration_ms: Math.max(0, now() - start),
  };
}
