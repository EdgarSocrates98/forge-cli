import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli-args.js';
import {
  checkoutRef,
  compareVersions,
  isValidRef,
  localTags,
  updateCheck,
} from '../src/git-revs.js';

let tmp: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

function commit(dir: string, file: string): string {
  writeFileSync(path.join(dir, file), file);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', file);
  return git(dir, 'rev-parse', 'HEAD');
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-revs-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('isValidRef / compareVersions', () => {
  it('valida revisões', () => {
    for (const ok of ['v1.2.3', '1.0', 'abc1234', 'release/1.x']) expect(isValidRef(ok)).toBe(true);
    for (const bad of ['--upload-pack=x', '-b', 'a..b', '', 'a b', 'x;rm']) {
      expect(isValidRef(bad)).toBe(false);
    }
  });
  it('ordena versões numericamente (mais nova primeiro)', () => {
    expect(['v1.2.0', 'v1.10.0', 'v1.9.0'].sort(compareVersions)).toEqual([
      'v1.10.0',
      'v1.9.0',
      'v1.2.0',
    ]);
  });
});

describe('checkoutRef / localTags', () => {
  it('faz checkout destacado por tag com ou sem v e por sha', async () => {
    const dir = path.join(tmp, 'r');
    execFileSync('git', ['init', '-q', dir]);
    initRepo(dir);
    const first = commit(dir, 'a');
    git(dir, 'tag', 'v1.0.0');
    const second = commit(dir, 'b');
    git(dir, 'tag', 'v1.1.0');

    expect(await checkoutRef(dir, '1.0.0')).toBe('v1.0.0');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(first);
    expect(await checkoutRef(dir, 'v1.1.0')).toBe('v1.1.0');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(second);
    await checkoutRef(dir, first);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(first);
    expect(await localTags(dir)).toEqual(['v1.1.0', 'v1.0.0']);
  });

  it('rejeita revisão inexistente ou perigosa', async () => {
    const dir = path.join(tmp, 'r');
    execFileSync('git', ['init', '-q', dir]);
    initRepo(dir);
    commit(dir, 'a');
    await expect(checkoutRef(dir, 'v9.9.9')).rejects.toThrow(/não encontrada/);
    await expect(checkoutRef(dir, '--force')).rejects.toThrow(/inválida/);
  });
});

describe('updateCheck', () => {
  it('conta commits disponíveis no upstream local', async () => {
    const origin = path.join(tmp, 'origin');
    execFileSync('git', ['init', '-q', origin]);
    initRepo(origin);
    commit(origin, 'a');
    const clone = path.join(tmp, 'clone');
    execFileSync('git', ['clone', '-q', origin, clone]);

    const upToDate = await updateCheck(clone);
    expect(upToDate).toMatchObject({ behind: 0, ahead: 0 });
    expect(upToDate.failure).toBeUndefined();

    commit(origin, 'b');
    const behind = await updateCheck(clone);
    expect(behind.behind).toBe(1);
    expect(git(clone, 'rev-list', '--count', 'HEAD')).toBe('1');
  });
});

describe('parseCliArgs --ref/--version', () => {
  it('aceita --version e --ref válidos', () => {
    expect(parseCliArgs(['install', 'x', '--version', '1.2.0']).ref).toBe('1.2.0');
    expect(parseCliArgs(['install', 'x', '--ref', 'abc1234']).ref).toBe('abc1234');
  });
  it('rejeita combinações e valores inválidos', () => {
    expect(() => parseCliArgs(['--ref', 'a', '--version', 'b'])).toThrow();
    expect(() => parseCliArgs(['--ref', '--evil'])).toThrow();
  });
  it('--check é booleano', () => {
    expect(parseCliArgs(['update', '--check']).check).toBe(true);
  });
});
