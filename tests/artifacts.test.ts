import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactsRoot,
  failedRepoNames,
  loadCustomRepos,
  loadState,
  mergeCatalog,
  openRunLog,
  recordResult,
  withLog,
  writeJsonReport,
} from '../src/artifacts.js';
import type { ForgeRepo, RepoResult } from '../src/types.js';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-art-'));
  tmpDirs.push(dir);
  return dir;
}

const result = (name: string, status: RepoResult['status']): RepoResult => ({
  repo: { name, url: `https://x/${name}`, description: 'd', kind: 'python' },
  status,
  detail: 'd',
  elapsedMs: 1,
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('run log', () => {
  it('creates a log file under .forge-cli/logs and appends lines', () => {
    const dir = tmpDir();
    const log = openRunLog(dir);
    expect(log.file).toContain(path.join('.forge-cli', 'logs'));
    log.write('linha um');
    log.write('linha dois');
    const content = readFileSync(log.file, 'utf8');
    expect(content).toBe('linha um\nlinha dois\n');
  });

  it('withLog taps every reporter method', () => {
    const dir = tmpDir();
    const log = openRunLog(dir);
    const seen: string[] = [];
    const reporter = withLog(
      {
        phase: (p) => seen.push(`p:${p}`),
        commandStart: (t) => seen.push(`s:${t}`),
        commandLine: (l) => seen.push(`l:${l}`),
        commandEnd: (ok, t) => seen.push(`e:${ok}:${t}`),
      },
      log.write,
    );
    reporter.phase?.('fase');
    reporter.commandStart?.('cmd');
    reporter.commandLine?.('out');
    reporter.commandEnd?.(true, 'cmd');
    const content = readFileSync(log.file, 'utf8');
    expect(content).toContain('[phase] fase');
    expect(content).toContain('[cmd] cmd');
    expect(content).toContain('  out');
    expect(content).toContain('[cmd ok] cmd');
    expect(seen).toEqual(['p:fase', 's:cmd', 'l:out', 'e:true:cmd']);
  });
});

describe('state', () => {
  it('round-trips per-repo results incrementally', () => {
    const dir = tmpDir();
    recordResult(dir, result('a', 'ok'));
    recordResult(dir, result('b', 'error'));
    recordResult(dir, result('a', 'warning'));
    const state = loadState(dir);
    expect(state?.repos.a.status).toBe('warning');
    expect(state?.repos.b.status).toBe('error');
  });

  it('failedRepoNames returns only error repos', () => {
    const dir = tmpDir();
    recordResult(dir, result('a', 'ok'));
    recordResult(dir, result('b', 'error'));
    recordResult(dir, result('c', 'error'));
    expect(failedRepoNames(loadState(dir)).sort()).toEqual(['b', 'c']);
  });

  it('returns null state for missing/invalid state files', () => {
    const dir = tmpDir();
    expect(loadState(dir)).toBeNull();
    mkdirSync(path.join(dir, '.forge-cli'), { recursive: true });
    writeFileSync(path.join(dir, '.forge-cli', 'state.json'), '{oops');
    expect(loadState(dir)).toBeNull();
    writeFileSync(path.join(dir, '.forge-cli', 'state.json'), '{"version":2}');
    expect(loadState(dir)).toBeNull();
  });
});

describe('json report', () => {
  it('writes the default report under .forge-cli/reports', () => {
    const dir = tmpDir();
    const file = writeJsonReport(dir, [result('a', 'ok')]);
    expect(file).toContain(path.join('.forge-cli', 'reports'));
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed.targetDir).toBe(dir);
    expect(parsed.results).toHaveLength(1);
  });

  it('honors a custom report path', () => {
    const dir = tmpDir();
    const custom = path.join(dir, 'out', 'r.json');
    expect(writeJsonReport(dir, [], custom)).toBe(custom);
    expect(existsSync(custom)).toBe(true);
  });
});

describe('custom repos', () => {
  it('loads a valid forge-cli.repos.json and defaults kind', () => {
    const dir = tmpDir();
    writeFileSync(
      path.join(dir, 'forge-cli.repos.json'),
      JSON.stringify([{ name: 'mine', url: 'https://x/mine', description: 'd' }]),
    );
    const res = loadCustomRepos(dir);
    expect(res && 'repos' in res && res.repos[0].name).toBe('mine');
    expect(res && 'repos' in res && res.repos[0].kind).toBe('python');
  });

  it('returns error results for invalid files', () => {
    const dir = tmpDir();
    expect(loadCustomRepos(dir)).toBeNull();
    writeFileSync(path.join(dir, 'forge-cli.repos.json'), '{oops');
    expect(loadCustomRepos(dir)).toHaveProperty('error');
    writeFileSync(path.join(dir, 'forge-cli.repos.json'), '{"a":1}');
    expect(loadCustomRepos(dir)).toHaveProperty('error');
  });

  it('mergeCatalog lets custom override catalog by name', () => {
    const dir = tmpDir();
    writeFileSync(
      path.join(dir, 'forge-cli.repos.json'),
      JSON.stringify([
        { name: 'the-forge', url: 'https://fork/the-forge', description: 'fork' },
        { name: 'mine', url: 'https://x/mine', description: 'd' },
      ]),
    );
    const res = loadCustomRepos(dir);
    const custom = res && 'repos' in res ? res.repos : null;
    const merged = mergeCatalog(
      [{ name: 'the-forge', url: 'https://orig/the-forge', description: 'd', kind: 'python' }],
      custom,
    );
    expect(merged.find((r) => r.name === 'the-forge')?.url).toBe('https://fork/the-forge');
    expect(merged.find((r) => r.name === 'mine')).toBeDefined();
    expect(artifactsRoot(dir)).toBe(path.join(dir, '.forge-cli'));
  });
});
