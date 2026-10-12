import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadState, recordResult } from '../src/artifacts.js';
import { FORGE_REPOS } from '../src/constants/repos.js';
import { install, installDir, uninstall } from '../src/install.js';
import { executeUninstall, planUninstall } from '../src/lifecycle.js';
import { planLines } from '../src/plan.js';
import { detectInstallMethod, planSelfUpdate } from '../src/self.js';
import { collectStatus } from '../src/status.js';
import type { ForgeRepo, RepoResult } from '../src/types.js';

let ws: string;
let home: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** Simula uma Forge instalada "à mão" (sem nenhum estado do forge-cli). */
function manualForge(repo: ForgeRepo): string {
  const dir = path.join(ws, repo.name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'remote', 'add', 'origin', repo.url);
  writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  writeFileSync(path.join(dir, 'README.md'), repo.name);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const result = (repo: ForgeRepo, head: string): RepoResult => ({
  repo,
  status: 'ok',
  detail: 'ok',
  elapsedMs: 1,
  head,
});

const [forgeA, forgeB] = FORGE_REPOS;

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-indep-ws-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-indep-home-'));
});
afterEach(() => {
  for (const d of [ws, home])
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('Cenário A — computador sem nenhuma Forge', () => {
  it('catálogo, status e plano funcionam com o workspace vazio', async () => {
    const infos = await collectStatus(FORGE_REPOS, ws, null);
    expect(infos).toHaveLength(FORGE_REPOS.length);
    expect(infos.every((i) => i.phase === 'not-installed')).toBe(true);
    expect(planLines(forgeA, ws).length).toBeGreaterThan(0);
    expect(readdirSync(ws)).toEqual([]); // nada criado só por consultar
  });
});

describe('Cenário B — Forge instalada manualmente', () => {
  it('é reconhecida sem estado do forge-cli e pode ser planejada sem reinstalação', async () => {
    manualForge(forgeA);
    const [info] = await collectStatus([forgeA], ws, loadState(ws));
    expect(info.phase).toBe('cloned');
    expect(info.head).toHaveLength(7);
    expect((await planUninstall(ws, forgeA)).kind).toBe('ready');
    expect(existsSync(path.join(ws, '.forge-cli'))).toBe(false); // nenhum registro obrigatório
  });
});

describe('Cenário C/E — forge-cli removido ou indisponível', () => {
  it('self install/uninstall não tocam em Forjas nem no workspace', async () => {
    const dir = manualForge(forgeA);
    const bundle = path.join(home, 'bundle.mjs');
    writeFileSync(bundle, '// bundle');
    const before = readFileSync(path.join(dir, 'README.md'), 'utf8');

    await install({ platform: 'linux', homedir: home, bundlePath: bundle });
    expect(existsSync(installDir(home))).toBe(true);
    await uninstall({ platform: 'linux', homedir: home });

    expect(existsSync(installDir(home))).toBe(false);
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe(before);
    expect(git(dir, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    expect(readdirSync(ws)).toEqual([forgeA.name]);
  });
});

describe('Cenário D — Forge atualizada diretamente pelo repositório', () => {
  it('o status reflete o HEAD real e o estado auxiliar se reconcilia', async () => {
    const dir = manualForge(forgeA);
    const first = git(dir, 'rev-parse', 'HEAD');
    recordResult(ws, result(forgeA, first));

    writeFileSync(path.join(dir, 'novo.md'), 'x');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'direto');
    const second = git(dir, 'rev-parse', 'HEAD');

    const [info] = await collectStatus([forgeA], ws, loadState(ws));
    expect(second.startsWith(info.head!)).toBe(true);
    expect(info.head).not.toBe(first.slice(0, 7));

    recordResult(ws, result(forgeA, second));
    expect(loadState(ws)?.repos[forgeA.name]).toMatchObject({ head: second, previousHead: first });
  });
});

describe('Cenário F — múltiplas Forjas independentes', () => {
  it('remover uma Forja não afeta as demais nem o diretório compartilhado', async () => {
    const dirA = manualForge(forgeA);
    const dirB = manualForge(forgeB);
    writeFileSync(path.join(ws, 'forge-cli.config.json'), '{}');

    const plan = await planUninstall(ws, forgeA);
    if (plan.kind !== 'ready') throw new Error('plano deveria estar pronto');
    executeUninstall(ws, forgeA, plan);

    expect(existsSync(dirA)).toBe(false);
    expect(existsSync(path.join(dirB, '.git'))).toBe(true);
    expect(existsSync(path.join(ws, 'forge-cli.config.json'))).toBe(true);
  });
});

describe('self update respeita o método de instalação', () => {
  it('detecta shim, npm global e código-fonte', () => {
    const h = path.join(home);
    expect(detectInstallMethod(path.join(h, '.forge-cli', 'bin', 'index.mjs'), h)).toBe('shim');
    expect(detectInstallMethod('/usr/lib/node_modules/forge-cli/dist/index.js', h)).toBe(
      'npm-global',
    );
    expect(detectInstallMethod('/work/forge-cli/dist/index.js', h)).toBe('source');
  });

  it('só npm global recebe comando automático', () => {
    expect(planSelfUpdate('npm-global').command?.args).toEqual([
      'install',
      '-g',
      'forge-cli@latest',
    ]);
    expect(planSelfUpdate('shim').command).toBeUndefined();
    expect(planSelfUpdate('source').manual).toMatch(/git pull/);
  });
});
