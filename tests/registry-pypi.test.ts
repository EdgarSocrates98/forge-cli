import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pypiCacheFile, resolveRelease, type FetchLike } from '../src/registry/pypi.js';

let tmp: string;
beforeEach(() => (tmp = mkdtempSync(path.join(os.tmpdir(), 'pypi-'))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const PAYLOAD = {
  info: { requires_python: '>=3.10' },
  releases: {
    '0.1.0': [
      {
        filename: 'd-0.1.0-py3-none-any.whl',
        url: 'https://files.example/d-0.1.0.whl',
        digests: { sha256: 'aaa' },
        packagetype: 'bdist_wheel',
        requires_python: '>=3.10',
      },
    ],
    '0.2.0': [
      {
        filename: 'd-0.2.0-py3-none-any.whl',
        url: 'https://files.example/d-0.2.0.whl',
        digests: { sha256: 'bbb' },
        packagetype: 'bdist_wheel',
      },
      {
        filename: 'd-0.2.0.tar.gz',
        url: 'https://files.example/d-0.2.0.tar.gz',
        digests: { sha256: 'ccc' },
        packagetype: 'sdist',
      },
    ],
    '0.3.0rc1': [
      {
        filename: 'd-0.3.0rc1-py3-none-any.whl',
        url: 'https://files.example/d-0.3.0rc1.whl',
      },
    ],
  },
};

const okFetch: FetchLike = async () => ({ status: 200, body: JSON.stringify(PAYLOAD) });

describe('resolveRelease', () => {
  it('resolve a estável mais nova ignorando pré-releases', async () => {
    const res = await resolveRelease('d', { cacheDir: tmp, fetchImpl: okFetch });
    expect(res).not.toHaveProperty('kind');
    if ('kind' in res) return;
    expect(res.version).toBe('0.2.0');
    expect(res.source).toBe('latest-stable');
    expect(res.files).toHaveLength(2);
    expect(res.files[0].sha256).toBe('bbb');
  });

  it('respeita pin e marca source=pinned', async () => {
    const res = await resolveRelease('d', { pin: '0.1.0', cacheDir: tmp, fetchImpl: okFetch });
    if ('kind' in res) throw new Error('unexpected error');
    expect(res.version).toBe('0.1.0');
    expect(res.source).toBe('pinned');
  });

  it('pin inexistente → version-not-found com disponíveis', async () => {
    const res = await resolveRelease('d', { pin: '9.9.9', cacheDir: tmp, fetchImpl: okFetch });
    expect(res).toMatchObject({ kind: 'version-not-found', requested: '9.9.9' });
    if ('kind' in res && res.kind === 'version-not-found') {
      expect(res.available).toContain('0.2.0');
    }
  });

  it('404 → not-found; HTTP 5xx → network', async () => {
    const nf = await resolveRelease('x', {
      cacheDir: tmp,
      fetchImpl: async () => ({ status: 404, body: '' }),
    });
    expect(nf).toMatchObject({ kind: 'not-found' });
    const err = await resolveRelease('x', {
      cacheDir: tmp,
      fetchImpl: async () => ({ status: 500, body: '' }),
    });
    expect(err).toMatchObject({ kind: 'network' });
  });

  it('falha de rede cai no cache quando existe', async () => {
    await resolveRelease('d', { cacheDir: tmp, fetchImpl: okFetch }); // popula
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    expect(res).not.toHaveProperty('kind');
    if ('kind' in res) return;
    expect(res.version).toBe('0.2.0');
    expect(res.source).toBe('cache');
  });

  it('falha de rede sem cache → network error', async () => {
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    expect(res).toMatchObject({ kind: 'network' });
  });

  it('--offline com cache resolve sem chamar fetch', async () => {
    await resolveRelease('d', { cacheDir: tmp, fetchImpl: okFetch });
    let called = false;
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      offline: true,
      fetchImpl: async () => {
        called = true;
        return { status: 200, body: '{}' };
      },
    });
    expect(called).toBe(false);
    expect(res).not.toHaveProperty('kind');
    if ('kind' in res) return;
    expect(res.source).toBe('cache');
  });

  it('--offline sem cache → offline-miss', async () => {
    const res = await resolveRelease('d', { cacheDir: tmp, offline: true, fetchImpl: okFetch });
    expect(res).toMatchObject({ kind: 'offline-miss', dist: 'd' });
  });

  it('corpo malformado → network/parse honesto, nunca crash', async () => {
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => ({ status: 200, body: 'not-json' }),
    });
    // JSON.parse lança dentro do try → cai no caminho de cache/network
    expect(res).toMatchObject({ kind: 'network' });
  });

  it('payload sem releases → malformed', async () => {
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => ({ status: 200, body: JSON.stringify({ info: {} }) }),
    });
    expect(res).toMatchObject({ kind: 'malformed' });
  });

  it('cache gravado em disco com o payload', async () => {
    await resolveRelease('d', { cacheDir: tmp, fetchImpl: okFetch });
    const cached = JSON.parse(
      (await import('node:fs')).readFileSync(pypiCacheFile(tmp, 'd'), 'utf8'),
    );
    expect(cached.payload.releases['0.2.0']).toBeTruthy();
  });

  it('cache expirado é ignorado em modo online', async () => {
    writeFileSync(
      pypiCacheFile(tmp, 'd'),
      JSON.stringify({ fetchedAt: Date.now() - 2 * 60 * 60 * 1000, payload: { releases: {} } }),
    );
    let fetched = false;
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => {
        fetched = true;
        return { status: 200, body: JSON.stringify(PAYLOAD) };
      },
    });
    expect(fetched).toBe(true);
    expect(res).not.toHaveProperty('kind');
  });
});
