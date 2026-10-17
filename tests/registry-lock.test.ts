// P2-001: offline-lock — fecho transitivo íntegro. Faltando artefato, hash
// adulterado, artefato extra, tag incompatível ou dep transitiva nova →
// recusa nomeada ANTES do pip; pip nunca recebe índice no modo travado.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registryEntry } from '../src/registry/catalog.js';
import {
  forgeVenv,
  registryInstall,
  wheelCacheDir,
  type RunLike,
  type RunResult,
} from '../src/registry/install.js';
import {
  generateOfflineLock,
  normDist,
  parseOfflineLock,
  tagsCompatible,
  verifyLockFiles,
  type OfflineLock,
} from '../src/registry/lock.js';
import type { FetchLike } from '../src/registry/pypi.js';
import { parseVersion } from '../src/registry/versions.js';

let tmp: string;
beforeEach(() => (tmp = mkdtempSync(path.join(os.tmpdir(), 'reg-lock-'))));
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

const ENTRY = registryEntry('api-forge')!;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const WHEEL_A = 'apiforge_af-0.1.0-py3-none-any.whl';
const WHEEL_B = 'requests-2.31.0-py3-none-any.whl';
const BYTES_A = 'primary-wheel';
const BYTES_B = 'dep-wheel';
const py = (v: string) => ({ exe: ['python3'], version: v, parsed: parseVersion(v)! });

const PYPI = {
  info: { requires_python: '>=3.10' },
  releases: {
    '0.1.0': [
      {
        filename: WHEEL_A,
        url: 'https://f/a.whl',
        digests: { sha256: sha(BYTES_A) },
        packagetype: 'bdist_wheel',
      },
    ],
  },
};
const fetchOk: FetchLike = async () => ({ status: 200, body: JSON.stringify(PYPI) });

const lockFixture = (artifacts?: OfflineLock['artifacts']): OfflineLock => ({
  format: 'forge-cli-offline-lock/1',
  forge: 'api-forge',
  dist: 'apiforge-af',
  version: '0.1.0',
  python: '3.12.4',
  platform: 'linux',
  generatedAt: '2026-10-17T00:00:00Z',
  artifacts: artifacts ?? [
    {
      name: 'apiforge-af',
      version: '0.1.0',
      filename: WHEEL_A,
      sha256: sha(BYTES_A),
      python_tag: 'py3',
      platform_tag: 'any',
      source: 'pypi',
    },
    {
      name: 'requests',
      version: '2.31.0',
      filename: WHEEL_B,
      sha256: sha(BYTES_B),
      python_tag: 'py3',
      platform_tag: 'any',
      source: 'pypi',
    },
  ],
});

/** Semeia metadata cache + wheels dir com os artefatos do lock. */
function seedCache(cacheDir: string, lock: OfflineLock, contents?: Record<string, string>) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, 'apiforge-af.json'),
    JSON.stringify({ fetchedAt: Date.now(), payload: PYPI }),
  );
  const wheels = wheelCacheDir(cacheDir, 'apiforge-af');
  mkdirSync(wheels, { recursive: true });
  for (const a of lock.artifacts) {
    writeFileSync(path.join(wheels, a.filename), contents?.[a.filename] ?? 'x'.repeat(0));
  }
  // bytes reais precisam bater com sha — reescreve com conteúdo dos bytes fixos
  writeFileSync(path.join(wheels, WHEEL_A), contents?.[WHEEL_A] ?? BYTES_A);
  writeFileSync(path.join(wheels, WHEEL_B), contents?.[WHEEL_B] ?? BYTES_B);
  return wheels;
}

const TARGET = { py: [3, 12] as [number, number], platform: 'linux' };

describe('parseOfflineLock', () => {
  it('formato desconhecido / artifact sem campo → lock-invalid', () => {
    expect(parseOfflineLock(null)).toMatchObject({ kind: 'lock-invalid' });
    expect(parseOfflineLock({ format: 'outro' })).toMatchObject({ kind: 'lock-invalid' });
    expect(parseOfflineLock({ ...lockFixture(), artifacts: [{ name: 'x' }] })).toMatchObject({
      kind: 'lock-invalid',
    });
    expect(parseOfflineLock(lockFixture())).toMatchObject({ format: 'forge-cli-offline-lock/1' });
  });
});

describe('tagsCompatible — conservador, fail-closed', () => {
  it('py3-none-any passa em qualquer alvo 3.x', () => {
    expect(tagsCompatible('a-1-py3-none-any.whl', TARGET)).toBe(true);
  });
  it('cp38-abi3-manylinux passa em py3.12 linux; cp38-cp38 não', () => {
    expect(tagsCompatible('a-1-cp38-abi3-manylinux_2_17_x86_64.whl', TARGET)).toBe(true);
    expect(tagsCompatible('a-1-cp38-cp38-manylinux_2_17_x86_64.whl', TARGET)).toBe(false);
  });
  it('win_amd64 não passa em linux; sdist passa (build local)', () => {
    expect(tagsCompatible('a-1-py3-none-win_amd64.whl', TARGET)).toBe(false);
    expect(tagsCompatible('a-1.tar.gz', TARGET)).toBe(true);
  });
  it('py2.py3 passa em 3.x; tag desconhecida recusa', () => {
    expect(tagsCompatible('a-1-py2.py3-none-any.whl', TARGET)).toBe(true);
    expect(tagsCompatible('a-1-zz9-none-any.whl', TARGET)).toBe(false);
  });
});

describe('verifyLockFiles — estrito antes do pip', () => {
  it('cache completo → null', () => {
    const lock = lockFixture();
    const wheels = seedCache(path.join(tmp, 'c'), lock);
    expect(verifyLockFiles(lock, wheels, TARGET)).toBeNull();
  });
  it('artefato faltante → lock-missing-artifact', () => {
    const lock = lockFixture();
    const wheels = seedCache(path.join(tmp, 'c'), lock);
    rmSync(path.join(wheels, WHEEL_B));
    expect(verifyLockFiles(lock, wheels, TARGET)).toMatchObject({
      kind: 'lock-missing-artifact',
    });
  });
  it('bytes adulterados → lock-hash-mismatch', () => {
    const lock = lockFixture();
    const wheels = seedCache(path.join(tmp, 'c'), lock, { [WHEEL_B]: 'tampered' });
    expect(verifyLockFiles(lock, wheels, TARGET)).toMatchObject({
      kind: 'lock-hash-mismatch',
    });
  });
  it('artefato extra no cache → lock-extra-artifact', () => {
    const lock = lockFixture();
    const wheels = seedCache(path.join(tmp, 'c'), lock);
    writeFileSync(path.join(wheels, 'sneaky-9.9-py3-none-any.whl'), 'x');
    expect(verifyLockFiles(lock, wheels, TARGET)).toMatchObject({ kind: 'lock-extra-artifact' });
  });
  it('tag incompatível → lock-incompatible-tag', () => {
    const lock = lockFixture([
      {
        name: 'apiforge-af',
        version: '0.1.0',
        filename: 'apiforge_af-0.1.0-cp38-cp38-macosx_10_9_x86_64.whl',
        sha256: sha(BYTES_A),
        python_tag: 'cp38',
        platform_tag: 'macosx_10_9_x86_64',
        source: 'pypi',
      },
    ]);
    const wheels = wheelCacheDir(path.join(tmp, 'c'), 'apiforge-af');
    mkdirSync(wheels, { recursive: true });
    writeFileSync(path.join(wheels, 'apiforge_af-0.1.0-cp38-cp38-macosx_10_9_x86_64.whl'), BYTES_A);
    expect(verifyLockFiles(lock, wheels, TARGET)).toMatchObject({
      kind: 'lock-incompatible-tag',
    });
  });
});

describe('generateOfflineLock — pip download --report', () => {
  it('report do pip vira lock com fecho + sha conferido no disco', async () => {
    const cacheDir = path.join(tmp, 'c');
    const wheels = wheelCacheDir(cacheDir, 'apiforge-af');
    mkdirSync(wheels, { recursive: true });
    const run: RunLike = async (_cmd, args) => {
      const di = args.indexOf('--dest');
      const ri = args.indexOf('--report');
      writeFileSync(path.join(args[di + 1], WHEEL_A), BYTES_A);
      writeFileSync(path.join(args[di + 1], WHEEL_B), BYTES_B);
      writeFileSync(
        args[ri + 1],
        JSON.stringify({
          install: [
            {
              metadata: { name: 'apiforge-af', version: '0.1.0' },
              download_info: {
                url: `https://f/${WHEEL_A}`,
                archive_info: { hashes: { sha256: sha(BYTES_A) } },
              },
            },
            {
              metadata: { name: 'requests', version: '2.31.0' },
              download_info: {
                url: `https://f/${WHEEL_B}`,
                archive_info: { hashes: { sha256: sha(BYTES_B) } },
              },
            },
          ],
        }),
      );
      return { exitCode: 0 };
    };
    const lock = await generateOfflineLock(ENTRY, '0.1.0', {
      run,
      python: py('3.12.4'),
      cacheDir,
      now: () => '2026-10-17T00:00:00Z',
      platform: 'linux',
    });
    expect(lock).toMatchObject({ format: 'forge-cli-offline-lock/1' });
    if ('kind' in lock) return;
    expect(lock.artifacts).toHaveLength(2);
    expect(lock.artifacts[0].filename).toBe(WHEEL_A);
    expect(lock.artifacts[0].sha256).toBe(sha(BYTES_A));
    expect(lock.artifacts[0].python_tag).toBe('py3');
    expect(lock.artifacts[0].platform_tag).toBe('any');
  });

  it('sem --report do pip → lock-report-missing (pip velho é recusado honesto)', async () => {
    const lock = await generateOfflineLock(ENTRY, '0.1.0', {
      run: async () => ({ exitCode: 0 }) as RunResult,
      python: py('3.12.4'),
      cacheDir: path.join(tmp, 'c2'),
    });
    expect(lock).toMatchObject({ kind: 'lock-report-missing' });
  });
});

describe('registryInstall --offline --lock — fecho travado', () => {
  const base = (lock: OfflineLock) => {
    const cacheDir = path.join(tmp, 'c');
    seedCache(cacheDir, lock);
    const lockPath = path.join(tmp, 'api-forge.offline-lock.json');
    writeFileSync(lockPath, JSON.stringify(lock));
    return {
      home: tmp,
      cacheDir,
      offline: true,
      lockFile: lockPath,
      pythons: [py('3.12.4')],
      fetchImpl: fetchOk,
      now: () => '2026-10-17T00:00:00Z',
    };
  };
  const runRequires = (calls: string[][], reqs: Record<string, string[]> = {}): RunLike => {
    return async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes('-c')) {
        return { exitCode: 0, stdout: JSON.stringify(reqs) };
      }
      return { exitCode: 0, stdout: 'ok' };
    };
  };

  it('cache completo → instala; pip recebe --no-index e TODOS os caminhos do lock', async () => {
    const calls: string[][] = [];
    const res = await registryInstall(ENTRY, undefined, {
      ...base(lockFixture()),
      run: runRequires(calls),
    });
    expect(res).not.toHaveProperty('stage');
    if ('stage' in res) return;
    expect(res.offlineLock?.artifacts).toBe(2);
    const pipArgs = calls.find((c) => c.includes('install') && c.includes('pip'))!;
    expect(pipArgs).toContain('--no-index');
    expect(pipArgs.filter((a) => a.endsWith('.whl'))).toHaveLength(2);
  });

  it('artefato faltante → stage lock/lock-missing-artifact, sem venv', async () => {
    const lock = lockFixture();
    const deps = base(lock);
    rmSync(path.join(wheelCacheDir(deps.cacheDir, 'apiforge-af'), WHEEL_B));
    const res = await registryInstall(ENTRY, undefined, { ...deps, run: runRequires([]) });
    expect(res).toMatchObject({ stage: 'lock', error: { kind: 'lock-missing-artifact' } });
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(false);
  });

  it('hash adulterado → lock-hash-mismatch', async () => {
    const lock = lockFixture();
    const deps = base(lock);
    writeFileSync(
      path.join(wheelCacheDir(deps.cacheDir, 'apiforge-af'), WHEEL_B),
      'tampered-bytes',
    );
    const res = await registryInstall(ENTRY, undefined, { ...deps, run: runRequires([]) });
    expect(res).toMatchObject({ stage: 'lock', error: { kind: 'lock-hash-mismatch' } });
  });

  it('artefato extra → lock-extra-artifact', async () => {
    const lock = lockFixture();
    const deps = base(lock);
    writeFileSync(
      path.join(wheelCacheDir(deps.cacheDir, 'apiforge-af'), 'sneaky-1.0-py3-none-any.whl'),
      'x',
    );
    const res = await registryInstall(ENTRY, undefined, { ...deps, run: runRequires([]) });
    expect(res).toMatchObject({ stage: 'lock', error: { kind: 'lock-extra-artifact' } });
  });

  it('dep transitiva nova fora do lock → lock-missing-dependency', async () => {
    const lock = lockFixture();
    const deps = base(lock);
    const wheels = wheelCacheDir(deps.cacheDir, 'apiforge-af');
    const reqs = { [path.join(wheels, WHEEL_B)]: ['ghost-newdep'] };
    const res = await registryInstall(ENTRY, undefined, {
      ...deps,
      run: runRequires([], reqs),
    });
    expect(res).toMatchObject({ stage: 'lock', error: { kind: 'lock-missing-dependency' } });
  });

  it('lock de versão diferente → lock-mismatch', async () => {
    const lock = { ...lockFixture(), version: '9.9.9' };
    const deps = base(lock);
    const res = await registryInstall(ENTRY, undefined, { ...deps, run: runRequires([]) });
    expect(res).toMatchObject({ stage: 'lock', error: { kind: 'lock-mismatch' } });
  });

  it('--lock sem --offline → lock-invalid (a flag não vale sozinha)', async () => {
    const lock = lockFixture();
    const deps = { ...base(lock), offline: false };
    const res = await registryInstall(ENTRY, undefined, { ...deps, run: runRequires([]) });
    expect(res).toMatchObject({ stage: 'lock', error: { kind: 'lock-invalid' } });
  });

  it('normDist — PEP 503', () => {
    expect(normDist('APiForge_AF')).toBe('apiforge-af');
  });
});
