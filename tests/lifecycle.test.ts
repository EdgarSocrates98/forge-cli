import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPin, loadState, recordResult, setPin } from '../src/artifacts.js';
import { executeUninstall, planUninstall, rollbackRepo } from '../src/lifecycle.js';
import type { ForgeRepo, RepoResult } from '../src/types.js';

const URL = 'https://github.com/a/demo';
const repo: ForgeRepo = { name: 'demo', url: URL, description: '', kind: 'node' };

let tmp: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

function makeClone(origin = URL): string {
  const dir = path.join(tmp, 'demo');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'remote', 'add', 'origin', origin);
  writeFileSync(path.join(dir, '.gitignore'), '.env\nconfig.yaml\n');
  writeFileSync(path.join(dir, 'config.example.yaml'), 'a: 1\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const result = (head: string): RepoResult => ({
  repo,
  status: 'ok',
  detail: 'x',
  elapsedMs: 1,
  head,
});

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-life-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('planUninstall', () => {
  it('ausente quando não clonada', async () => {
    expect((await planUninstall(tmp, repo)).kind).toBe('absent');
  });

  it('recusa diretório sem .git (arquivos desconhecidos)', async () => {
    mkdirSync(path.join(tmp, 'demo'));
    writeFileSync(path.join(tmp, 'demo', 'meu-arquivo.txt'), 'x');
    expect(await planUninstall(tmp, repo)).toMatchObject({ kind: 'refused', reason: 'non-git' });
  });

  it('recusa remote diferente e working tree suja', async () => {
    const dir = makeClone('https://github.com/evil/demo');
    expect(await planUninstall(tmp, repo)).toMatchObject({
      kind: 'refused',
      reason: 'remote-mismatch',
    });
    git(dir, 'remote', 'set-url', 'origin', URL);
    writeFileSync(path.join(dir, 'novo.txt'), 'untracked');
    expect(await planUninstall(tmp, repo)).toMatchObject({ kind: 'refused', reason: 'dirty' });
  });

  it('pronto com backup de .env e configs geradas de exemplos', async () => {
    const dir = makeClone();
    writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    writeFileSync(path.join(dir, 'config.yaml'), 'a: 2\n');
    const plan = await planUninstall(tmp, repo);
    expect(plan.kind).toBe('ready');
    if (plan.kind === 'ready') expect(plan.backups.sort()).toEqual(['.env', 'config.yaml']);
  });
});

describe('executeUninstall', () => {
  it('faz backup, remove só o clone e esquece estado e pin', async () => {
    const dir = makeClone();
    writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    recordResult(tmp, result('abc'));
    setPin(tmp, 'demo', 'v1');
    const plan = await planUninstall(tmp, repo);
    if (plan.kind !== 'ready') throw new Error('esperava plano pronto');

    const backup = executeUninstall(tmp, repo, plan);
    expect(existsSync(dir)).toBe(false);
    expect(backup).not.toBeNull();
    expect(readFileSync(path.join(backup!, '.env'), 'utf8')).toBe('SECRET=1');
    const state = loadState(tmp);
    expect(state?.repos.demo).toBeUndefined();
    expect(state?.pins?.demo).toBeUndefined();
    expect(readdirSync(tmp)).toContain('.forge-cli');
  });

  it('recusa plano que aponta para outro diretório', async () => {
    makeClone();
    const outsider = path.join(tmp, 'outro');
    mkdirSync(outsider);
    expect(() =>
      executeUninstall(tmp, repo, { kind: 'ready', dir: outsider, backups: [] }),
    ).toThrow();
    expect(existsSync(outsider)).toBe(true);
  });
});

describe('pins e rollback', () => {
  it('setPin/clearPin', () => {
    setPin(tmp, 'demo', 'v1.2.0');
    expect(loadState(tmp)?.pins?.demo).toBe('v1.2.0');
    expect(clearPin(tmp, 'demo')).toBe(true);
    expect(clearPin(tmp, 'demo')).toBe(false);
  });

  it('recordResult guarda previousHead quando o HEAD muda', () => {
    recordResult(tmp, result('aaa'));
    recordResult(tmp, result('bbb'));
    recordResult(tmp, result('bbb'));
    expect(loadState(tmp)?.repos.demo).toMatchObject({ head: 'bbb', previousHead: 'aaa' });
  });

  it('rollback volta ao HEAD anterior; sem registro ou com tree suja é recusado', async () => {
    const dir = makeClone();
    const first = git(dir, 'rev-parse', 'HEAD');
    expect(await rollbackRepo(tmp, repo)).toMatchObject({ ok: false, reason: 'no-previous' });

    writeFileSync(path.join(dir, 'b.txt'), 'b');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'b');
    const second = git(dir, 'rev-parse', 'HEAD');
    recordResult(tmp, result(first));
    recordResult(tmp, result(second));

    writeFileSync(path.join(dir, 'sujo.txt'), 'x');
    expect(await rollbackRepo(tmp, repo)).toMatchObject({ ok: false, reason: 'dirty' });
    rmSync(path.join(dir, 'sujo.txt'));

    const ok = await rollbackRepo(tmp, repo);
    expect(ok).toMatchObject({ ok: true, to: first });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(first);
  });
});
