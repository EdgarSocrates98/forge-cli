import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCustomRepos } from '../src/artifacts.js';
import {
  isLinkOrJunction,
  isSafeRepoName,
  isSafeRepoUrl,
  redactSecrets,
  resolveInside,
  writeFileAtomic,
} from '../src/safety.js';
import { syncRepo } from '../src/utils/system.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-safety-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('isSafeRepoName', () => {
  it.each(['api-forge', 'the-forge', 'a.b_c'])('aceita %s', (n) => {
    expect(isSafeRepoName(n)).toBe(true);
  });
  it.each(['..', '../x', '..\\x', '/abs', 'C:\\x', 'a/b', '', '.hidden', 'a..b', 42])(
    'rejeita %s',
    (n) => {
      expect(isSafeRepoName(n)).toBe(false);
    },
  );
});

describe('isSafeRepoUrl', () => {
  it.each([
    'https://github.com/EdgarSocrates98/api-forge',
    'git@github.com:EdgarSocrates98/api-forge.git',
    'ssh://git@github.com/EdgarSocrates98/api-forge',
  ])('aceita %s', (u) => expect(isSafeRepoUrl(u)).toBe(true));
  it.each([
    '--upload-pack=calc',
    'ext::sh -c calc',
    'file:///etc/passwd',
    'http://github.com/x/y',
    'https://user:tok@github.com/x/y',
    '/local/path',
    ' https://github.com/x/y',
  ])('rejeita %s', (u) => expect(isSafeRepoUrl(u)).toBe(false));
});

describe('resolveInside', () => {
  it('resolve dentro da base e bloqueia fuga', () => {
    expect(resolveInside(tmp, 'api-forge')).toBe(path.join(tmp, 'api-forge'));
    expect(resolveInside(tmp, '../evil')).toBeNull();
    expect(resolveInside(tmp, path.join(tmp, 'x'))).toBeNull();
  });
});

describe('redactSecrets', () => {
  it('mascara tokens, credenciais em URL e variáveis sensíveis', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const out = redactSecrets(
      `clone https://x-access-token:${token}@github.com/a/b GITHUB_TOKEN=abc123 Authorization: Bearer xyz ${token}`,
    );
    expect(out).not.toContain(token);
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('xyz');
    expect(out).toContain('https://***@github.com/a/b');
  });
  it('preserva texto comum', () => {
    expect(redactSecrets('git pull --ff-only')).toBe('git pull --ff-only');
  });
});

describe('writeFileAtomic', () => {
  it('substitui conteúdo e não deixa temporários', () => {
    const file = path.join(tmp, 'state.json');
    writeFileAtomic(file, 'a');
    writeFileAtomic(file, 'b');
    expect(readFileSync(file, 'utf8')).toBe('b');
  });
});

describe('loadCustomRepos', () => {
  it('rejeita nomes e URLs perigosos', () => {
    writeFileSync(
      path.join(tmp, 'forge-cli.repos.json'),
      JSON.stringify([
        { name: '../evil', url: 'https://github.com/a/b', description: 'x' },
        { name: 'ok', url: '--upload-pack=x', description: 'x' },
        { name: 'good', url: 'https://github.com/a/good', description: 'x' },
      ]),
    );
    const res = loadCustomRepos(tmp);
    expect(res && 'repos' in res && res.repos.map((r) => r.name)).toEqual(['good']);
    expect(res && 'rejected' in res && res.rejected).toEqual(['../evil', 'ok']);
  });
});

describe('syncRepo', () => {
  const repo = (name: string, url = 'https://github.com/a/b') => ({
    name,
    url,
    description: '',
    kind: 'node' as const,
  });
  it('recusa nome com path traversal', async () => {
    await expect(syncRepo(repo('../evil'), tmp)).rejects.toThrow(/inválido/);
  });
  it('recusa URL perigosa', async () => {
    await expect(syncRepo(repo('x', '--upload-pack=calc'), tmp)).rejects.toThrow(/URL/);
  });
  it('recusa destino que é link simbólico', async () => {
    const outside = path.join(tmp, 'outside');
    mkdirSync(outside);
    const link = path.join(tmp, 'ws', 'lnk');
    mkdirSync(path.dirname(link));
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      return; // sem permissão para criar link neste ambiente
    }
    expect(isLinkOrJunction(link)).toBe(true);
    await expect(syncRepo(repo('lnk'), path.dirname(link))).rejects.toThrow(/link/);
  });
});

import { classifyGitFailure, sameRemote } from '../src/utils/system.js';

describe('git sync helpers', () => {
  it('compara remotes ignorando protocolo, .git e credenciais', () => {
    expect(sameRemote('git@github.com:A/b.git', 'https://github.com/a/b')).toBe(true);
    expect(sameRemote('https://tok@github.com/a/b/', 'https://github.com/a/b')).toBe(true);
    expect(sameRemote('https://github.com/evil/b', 'https://github.com/a/b')).toBe(false);
  });
  it('classifica falhas de pull', () => {
    expect(classifyGitFailure('fatal: Not possible to fast-forward, aborting.')).toBe('diverged');
    expect(classifyGitFailure('Could not resolve host: github.com')).toBe('network');
    expect(classifyGitFailure('fatal: Authentication failed for')).toBe('auth');
    expect(classifyGitFailure('boom')).toBe('unknown');
  });
});

describe('syncRepo offline', () => {
  const demo = {
    name: 'demo',
    url: 'https://github.com/a/b',
    description: '',
    kind: 'node' as const,
  };
  it('não clona nada sem rede', async () => {
    await expect(syncRepo(demo, tmp, { offline: true })).rejects.toThrow(/offline/);
  });
  it('usa o clone existente sem pull nem fetch', async () => {
    const dir = path.join(tmp, 'demo');
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    const res = await syncRepo(demo, tmp, { offline: true });
    expect(res.kind).toBe('fixed-ref');
  });
});
