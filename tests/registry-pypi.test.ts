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

  it('HTTP 5xx com cache quente cai no cache (falha honesta só sem cache)', async () => {
    await resolveRelease('d', { cacheDir: tmp, fetchImpl: okFetch }); // popula
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => ({ status: 503, body: '' }),
    });
    expect(res).not.toHaveProperty('kind');
    if ('kind' in res) return;
    expect(res.source).toBe('cache');
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

  it('200 malformado NÃO sobrescreve um cache sadio (sem envenenamento)', async () => {
    await resolveRelease('d', { cacheDir: tmp, fetchImpl: okFetch }); // cache sadio
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => ({ status: 200, body: JSON.stringify({ info: {} }) }),
    });
    // cai no cache em vez de falhar — e o arquivo cacheado ficou intacto
    expect(res).not.toHaveProperty('kind');
    if ('kind' in res) return;
    expect(res.version).toBe('0.2.0');
    expect(res.source).toBe('cache');
    const cached = JSON.parse(
      (await import('node:fs')).readFileSync(pypiCacheFile(tmp, 'd'), 'utf8'),
    );
    expect(cached.payload.releases['0.2.0']).toBeTruthy();
  });

  it('200 malformado sem cache → malformed (não grava lixo no cache)', async () => {
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => ({ status: 200, body: JSON.stringify({ info: {} }) }),
    });
    expect(res).toMatchObject({ kind: 'malformed' });
    const { existsSync } = await import('node:fs');
    expect(existsSync(pypiCacheFile(tmp, 'd'))).toBe(false);
  });

  it('fetchedAt futuro (clock skew) conta como stale, não como fresh', async () => {
    writeFileSync(
      pypiCacheFile(tmp, 'd'),
      JSON.stringify({ fetchedAt: Date.now() + 60 * 60 * 1000, payload: PAYLOAD }),
    );
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    if ('kind' in res) throw new Error('unexpected');
    expect(res.staleCache).toBe(true);
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

describe('yanked e releases vazios', () => {
  const YANKED = {
    info: { requires_python: '>=3.10' },
    releases: {
      '0.1.0': [{ filename: 'd-0.1.0.whl', url: 'u1' }],
      '0.2.0': [{ filename: 'd-0.2.0.whl', url: 'u2', yanked: true }],
      '0.2.5': [],
      '0.3.0': [{ filename: 'd-0.3.0.whl', url: 'u3' }],
    },
  };
  const fy: FetchLike = async () => ({ status: 200, body: JSON.stringify(YANKED) });

  it('latest-stable ignora releases yanked e sem arquivos', async () => {
    const res = await resolveRelease('d', { cacheDir: tmp, fetchImpl: fy });
    if ('kind' in res) throw new Error('unexpected');
    expect(res.version).toBe('0.3.0');
  });

  it('maior estável toda yanked → cai para a anterior instalável', async () => {
    const p = {
      info: {},
      releases: { '0.1.0': YANKED.releases['0.1.0'], '9.9.9': YANKED.releases['0.2.0'] },
    };
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(p) }),
    });
    if ('kind' in res) throw new Error('unexpected');
    expect(res.version).toBe('0.1.0');
  });

  it('pin em release yanked → instala e marca', async () => {
    const res = await resolveRelease('d', { pin: '0.2.0', cacheDir: tmp, fetchImpl: fy });
    if ('kind' in res) throw new Error('unexpected');
    expect(res.version).toBe('0.2.0');
    expect(res.yanked).toBe(true);
  });
});

describe('requires_python por arquivo', () => {
  it('prefere o da wheel ao do sdist/info', async () => {
    const payload = {
      info: { requires_python: '>=3.9' },
      releases: {
        '0.1.0': [
          {
            filename: 'd-0.1.0.tar.gz',
            url: 'u',
            packagetype: 'sdist',
            requires_python: '>=3.10',
          },
          {
            filename: 'd-0.1.0-py3-none-any.whl',
            url: 'u',
            packagetype: 'bdist_wheel',
            requires_python: '>=3.11',
          },
        ],
      },
    };
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(payload) }),
    });
    if ('kind' in res) throw new Error('unexpected');
    expect(res.requiresPython).toBe('>=3.11');
  });
});

describe('cache expirado', () => {
  it('fallback com cache expirado marca staleCache', async () => {
    writeFileSync(
      pypiCacheFile(tmp, 'd'),
      JSON.stringify({ fetchedAt: Date.now() - 2 * 60 * 60 * 1000, payload: PAYLOAD }),
    );
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    if ('kind' in res) throw new Error('unexpected');
    expect(res.staleCache).toBe(true);
  });

  it('cache fresco no fallback não marca stale', async () => {
    await resolveRelease('d', { cacheDir: tmp, fetchImpl: okFetch });
    const res = await resolveRelease('d', {
      cacheDir: tmp,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    if ('kind' in res) throw new Error('unexpected');
    expect(res.staleCache).toBeUndefined();
  });
});
