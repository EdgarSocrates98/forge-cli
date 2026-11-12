import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { FORGE_REPOS } from '../constants/repos.js';
import { loadState } from '../artifacts.js';
import { loadContextStates } from '../context-registry.js';
import { commandOutput, currentHead, hasGitRepo, isGitDirty } from '../utils/system.js';
import { isLinkOrJunction } from '../safety.js';
import type {
  ExperienceState,
  IdentityLevel,
  WorkspaceInventory,
  WorkspaceProject,
  WorkspaceProjectKind,
} from './contracts.js';

const MAX_FILE_BYTES = 128 * 1024;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  'coverage',
  '.forge-cli',
]);

function safeRead(file: string): string {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return '';
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function jsonName(file: string): { name: string | null; version: string | null } {
  try {
    const value = JSON.parse(safeRead(file)) as { name?: unknown; version?: unknown };
    return {
      name: typeof value.name === 'string' ? value.name : null,
      version: typeof value.version === 'string' ? value.version : null,
    };
  } catch {
    return { name: null, version: null };
  }
}

function pythonName(file: string): { name: string | null; version: string | null } {
  const text = safeRead(file);
  const name = /^name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ?? null;
  const version = /^version\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ?? null;
  return { name, version };
}

function normalizeName(value: string | null): string | null {
  return value?.trim().toLowerCase().replace(/_/g, '-') || null;
}

function candidateFor(dirName: string): string | null {
  const normalized = normalizeName(dirName);
  if (!normalized) return null;
  return FORGE_REPOS.some((repo) => repo.name === normalized) ? normalized : null;
}

function safeGitBranch(dir: string): Promise<string | null> {
  return commandOutput('git', ['-C', dir, 'branch', '--show-current']).then((out) =>
    out && out !== 'ok' ? out.trim() || null : null,
  );
}

function kindFor(markers: Set<string>): WorkspaceProjectKind {
  if (markers.has('portal')) return 'portal';
  if (markers.has('skills')) return 'skills';
  if (markers.has('agents')) return 'agents';
  if (markers.has('python') && markers.has('node')) return 'mixed';
  if (markers.has('python')) return 'python';
  if (markers.has('node')) return 'node';
  if (markers.has('docs')) return 'docs';
  if (markers.has('config')) return 'config';
  return 'unknown';
}

function stateFor(
  identity: IdentityLevel,
  dir: string,
  name: string | null,
  targetDir: string,
): ExperienceState {
  if (identity === 'unknown' || identity === 'conflict')
    return identity === 'conflict' ? 'DEGRADED' : 'DISCOVERED';
  const state = name ? loadState(targetDir)?.repos[name] : undefined;
  if (state?.status === 'error') return 'DEGRADED';
  if (state?.phase === 'validated') return 'VERIFIED';
  if (state?.phase === 'installed' || state?.status === 'ok') return 'INSTALLED';
  if (existsSync(path.join(dir, '.forge-cli', 'activated.json'))) return 'ACTIVATED';
  if (
    hasGitRepo(dir) ||
    existsSync(path.join(dir, 'package.json')) ||
    existsSync(path.join(dir, 'pyproject.toml'))
  ) {
    return 'READY';
  }
  return 'RECOGNIZED';
}

function projectFromEntry(
  root: string,
  workspaceRoot: string,
  entry: Dirent,
  targetDir: string,
): WorkspaceProject | null {
  if (!entry.isDirectory()) return null;
  const dir = path.join(root, entry.name);
  if (SKIP_DIRS.has(entry.name.toLowerCase()) || isLinkOrJunction(dir)) return null;
  const packageInfo = existsSync(path.join(dir, 'package.json'))
    ? jsonName(path.join(dir, 'package.json'))
    : { name: null, version: null };
  const pythonFile = existsSync(path.join(dir, 'pyproject.toml'))
    ? path.join(dir, 'pyproject.toml')
    : existsSync(path.join(dir, 'setup.py'))
      ? path.join(dir, 'setup.py')
      : null;
  const pythonInfo = pythonFile ? pythonName(pythonFile) : { name: null, version: null };
  const declared = (() => {
    try {
      const parsed = JSON.parse(safeRead(path.join(dir, 'forge.json'))) as { forge_id?: unknown };
      return typeof parsed.forge_id === 'string' ? normalizeName(parsed.forge_id) : null;
    } catch {
      return null;
    }
  })();
  const derived = normalizeName(packageInfo.name ?? pythonInfo.name);
  const candidate = candidateFor(entry.name);
  const recognized = Boolean(
    packageInfo.name ||
    pythonInfo.name ||
    declared ||
    candidate ||
    existsSync(path.join(dir, 'install.sh')) ||
    existsSync(path.join(dir, 'install.ps1')) ||
    existsSync(path.join(dir, 'forge.agentic.json')) ||
    existsSync(path.join(dir, 'mcp.json')) ||
    existsSync(path.join(dir, '.mcp.json')),
  );
  if (!recognized) return null;
  const conflict = declared && derived && declared !== derived ? `${declared} != ${derived}` : null;
  const level: IdentityLevel = conflict
    ? 'conflict'
    : declared
      ? 'declared'
      : derived
        ? 'derived'
        : candidate
          ? 'candidate'
          : 'unknown';
  const name = declared ?? derived ?? candidate;
  const markers = new Set<string>();
  if (packageInfo.name) markers.add('node');
  if (pythonInfo.name) markers.add('python');
  if (existsSync(path.join(dir, 'forge.json'))) markers.add('manifest');
  if (existsSync(path.join(dir, 'install.sh')) || existsSync(path.join(dir, 'install.ps1')))
    markers.add('installer');
  if (existsSync(path.join(dir, 'forge.agentic.json'))) markers.add('agents');
  if (existsSync(path.join(dir, 'skills'))) markers.add('skills');
  if (existsSync(path.join(dir, 'src', 'app'))) markers.add('portal');
  if (existsSync(path.join(dir, 'README.md')) && recognized) markers.add('docs');
  if (existsSync(path.join(dir, 'mcp.json')) || existsSync(path.join(dir, '.mcp.json')))
    markers.add('mcp');
  const capabilities = [...markers]
    .filter((m) => ['installer', 'manifest', 'agents', 'skills', 'mcp', 'portal'].includes(m))
    .sort();
  const git = hasGitRepo(dir);
  const absolute = path.resolve(dir);
  return {
    id: name ?? entry.name,
    path: path.relative(workspaceRoot, dir).split(path.sep).join('/'),
    absolute_path: absolute,
    identity: { name, level, declared, derived, candidate, conflict },
    kind: kindFor(markers),
    capabilities,
    markers: [...markers].sort(),
    git: { present: git, branch: null, dirty: null },
    version: packageInfo.version ?? pythonInfo.version,
    state: stateFor(level, dir, name, targetDir),
    evidence: [
      ...(packageInfo.name ? ['package.json'] : []),
      ...(pythonInfo.name ? [pythonFile ? path.basename(pythonFile) : 'python'] : []),
      ...(declared ? ['forge.json'] : []),
      ...(git ? ['.git'] : []),
    ],
  };
}

async function enrichGit(project: WorkspaceProject): Promise<WorkspaceProject> {
  if (!project.git.present) return project;
  return {
    ...project,
    git: {
      present: true,
      branch: await safeGitBranch(project.absolute_path),
      dirty: await isGitDirty(project.absolute_path),
    },
  };
}

export interface WorkspaceScanOptions {
  now?: string;
  maxDepth?: number;
  maxEntries?: number;
  maxProjects?: number;
}

/** Read-only, bounded, symlink-safe workspace inventory. */
export async function scanWorkspace(
  rootInput: string,
  options: WorkspaceScanOptions = {},
): Promise<WorkspaceInventory> {
  const root = path.resolve(rootInput);
  const maxDepth = options.maxDepth ?? 2;
  const maxEntries = options.maxEntries ?? 5000;
  const maxProjects = options.maxProjects ?? 256;
  const warnings: string[] = [];
  const projects: WorkspaceProject[] = [];
  let truncated = false;
  if (!existsSync(root)) warnings.push(`workspace ausente: ${root}`);
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let entriesSeen = 0;
  const rootProject = projectFromEntry(
    path.dirname(root),
    root,
    { name: path.basename(root), isDirectory: () => true } as Dirent,
    root,
  );
  if (rootProject) projects.push(await enrichGit(rootProject));
  while (queue.length && projects.length < maxProjects && entriesSeen < maxEntries) {
    const current = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      warnings.push(`sem permissão: ${path.relative(root, current.dir) || '.'}`);
      continue;
    }
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > maxEntries) {
        truncated = true;
        break;
      }
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      const project = projectFromEntry(current.dir, root, entry, root);
      if (project) projects.push(await enrichGit(project));
      if (current.depth < maxDepth && !isLinkOrJunction(path.join(current.dir, entry.name))) {
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }
  if (projects.length >= maxProjects || entriesSeen >= maxEntries) truncated = true;
  // Estados granulares do Forge Context (install-2.0): uma leitura bounded
  // de `.forge/context/registry.json` + manifests — projetada por Forja,
  // nunca substitui o ExperienceState derivado localmente.
  const contextStates = loadContextStates(root);
  for (const project of projects) {
    const ctx = contextStates.forges[project.id];
    if (ctx) {
      project.context = {
        state: ctx.state,
        health: ctx.health,
        scope: ctx.scope,
        kind: ctx.kind,
      };
    }
  }
  projects.sort((a, b) => a.path.localeCompare(b.path));
  const git = hasGitRepo(root);
  const head = git ? await currentHead(root) : null;
  const branch = git ? await safeGitBranch(root) : null;
  const capabilities = [...new Set(projects.flatMap((p) => p.capabilities))].sort();
  return {
    schema: 'forge/WorkspaceInventory/v1',
    generated_at: options.now ?? new Date().toISOString(),
    root,
    git: { present: git, branch, head },
    limits: { max_depth: maxDepth, max_entries: maxEntries, max_projects: maxProjects },
    projects,
    capabilities,
    warnings,
    truncated,
  };
}

export function inventoryDigest(inventory: WorkspaceInventory): string {
  return createHash('sha256')
    .update(JSON.stringify({ ...inventory, generated_at: undefined }))
    .digest('hex');
}
