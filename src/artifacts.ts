import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RepoReporter } from './runner.js';
import { isSafeRepoName, isSafeRepoUrl, redactSecrets, writeFileAtomic } from './safety.js';
import type { ForgeRepo, RepoResult, RepoStatus } from './types.js';

export interface CliState {
  version: 1;
  repos: Record<
    string,
    { status: RepoStatus; detail: string; at: string; head?: string; previousHead?: string }
  >;
  pins?: Record<string, string>;
}

export function artifactsRoot(targetDir: string): string {
  return path.join(targetDir, '.forge-cli');
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function openRunLog(targetDir: string): { file: string; write: (line: string) => void } {
  const file = path.join(artifactsRoot(targetDir), 'logs', `forge-cli-${timestamp()}.log`);
  mkdirSync(path.dirname(file), { recursive: true });
  return { file, write: (line) => appendFileSync(file, `${line}\n`, 'utf8') };
}

export function withLog(reporter: RepoReporter, write: (line: string) => void): RepoReporter {
  return {
    phase: (p) => {
      write(`[phase] ${p}`);
      reporter.phase?.(p);
    },
    commandStart: (t) => {
      write(`[cmd] ${t}`);
      reporter.commandStart?.(t);
    },
    commandLine: (l) => {
      write(`  ${l}`);
      reporter.commandLine?.(l);
    },
    commandEnd: (ok, t) => {
      write(`[cmd ${ok ? 'ok' : 'fail'}] ${t}`);
      reporter.commandEnd?.(ok, t);
    },
  };
}

export function stateFileFor(targetDir: string): string {
  return path.join(artifactsRoot(targetDir), 'state.json');
}

export function loadState(targetDir: string): CliState | null {
  const file = stateFileFor(targetDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CliState;
    return parsed?.version === 1 && parsed.repos && typeof parsed.repos === 'object'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function recordResult(targetDir: string, result: RepoResult): void {
  const state = loadState(targetDir) ?? { version: 1 as const, repos: {} };
  const prior = state.repos[result.repo.name];
  const previousHead =
    result.head && prior?.head && prior.head !== result.head ? prior.head : prior?.previousHead;
  state.repos[result.repo.name] = {
    status: result.status,
    detail: result.detail,
    at: new Date().toISOString(),
    ...(result.head ? { head: result.head } : {}),
    ...(previousHead ? { previousHead } : {}),
  };
  saveState(targetDir, state);
}

function saveState(targetDir: string, state: CliState): void {
  const file = stateFileFor(targetDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(state, null, 2));
}

export function setPin(targetDir: string, name: string, ref: string): void {
  const state = loadState(targetDir) ?? { version: 1 as const, repos: {} };
  state.pins = { ...state.pins, [name]: ref };
  saveState(targetDir, state);
}

export function clearPin(targetDir: string, name: string): boolean {
  const state = loadState(targetDir);
  if (!state?.pins || !(name in state.pins)) return false;
  delete state.pins[name];
  saveState(targetDir, state);
  return true;
}

export function forgetRepo(targetDir: string, name: string): void {
  const state = loadState(targetDir);
  if (!state) return;
  delete state.repos[name];
  if (state.pins) delete state.pins[name];
  saveState(targetDir, state);
}

export function failedRepoNames(state: CliState | null): string[] {
  if (!state) return [];
  return Object.entries(state.repos)
    .filter(([, v]) => v.status === 'error')
    .map(([k]) => k);
}

export function writeJsonReport(
  targetDir: string,
  results: RepoResult[],
  reportPath?: string,
): string {
  const file =
    reportPath ?? path.join(artifactsRoot(targetDir), 'reports', `forge-cli-${timestamp()}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(
    file,
    redactSecrets(
      JSON.stringify({ generatedAt: new Date().toISOString(), targetDir, results }, null, 2),
    ),
  );
  return file;
}

export type CustomReposResult =
  { repos: ForgeRepo[]; rejected: string[] } | { error: string } | null;

export function loadCustomRepos(targetDir: string): CustomReposResult {
  const file = path.join(targetDir, 'forge-cli.repos.json');
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return { error: 'not-an-array' };
    const repos: ForgeRepo[] = [];
    const rejected: string[] = [];
    for (const item of parsed) {
      if (item && typeof item.name === 'string' && !isSafeRepoName(item.name)) {
        rejected.push(item.name);
        continue;
      }
      if (item && typeof item.url === 'string' && !isSafeRepoUrl(item.url)) {
        rejected.push(String(item.name));
        continue;
      }
      if (
        item &&
        typeof item.name === 'string' &&
        typeof item.url === 'string' &&
        typeof item.description === 'string'
      ) {
        repos.push({
          origin: 'custom',
          kind: item.kind === 'node' ? 'node' : 'python',
          nextSteps: item.nextSteps,
          envKeys: item.envKeys,
          verify: item.verify,
          name: item.name,
          url: item.url,
          description: item.description,
        });
      }
    }
    return repos.length ? { repos, rejected } : { error: 'empty' };
  } catch {
    return { error: 'invalid-json' };
  }
}

export function mergeCatalog(
  catalog: readonly ForgeRepo[],
  custom: ForgeRepo[] | null,
): ForgeRepo[] {
  if (!custom?.length) return [...catalog];
  const byName = new Map<string, ForgeRepo>(catalog.map((r) => [r.name, r]));
  for (const repo of custom) byName.set(repo.name, repo);
  return [...byName.values()];
}
