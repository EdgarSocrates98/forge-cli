import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registryEntry } from '../src/registry/catalog.js';
import {
  forgeVenv,
  loadForgeState,
  receiptPath,
  registryInstall,
  registryUninstall,
  type RunLike,
} from '../src/registry/install.js';
import type { FetchLike } from '../src/registry/pypi.js';
import { parseVersion } from '../src/registry/versions.js';

let tmp: string;
beforeEach(() => (tmp = mkdtempSync(path.join(os.tmpdir(), 'reg-inst-'))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const PYPI = {
  info: { requires_python: '>=3.10' },
  releases: {
    '0.1.0': [
      {
        filename: 'd-0.1.0-py3-none-any.whl',
        url: 'https://f/d-0.1.0.whl',
        digests: { sha256: 'a'.repeat(64) },
        packagetype: 'bdist_wheel',
      },
    ],
  },
};
const fetchOk: FetchLike = async () => ({ status: 200, body: JSON.stringify(PYPI) });
const py = (v: string) => ({ exe: ['python3'], version: v, parsed: parseVersion(v)! });

const ENTRY = registryEntry('api-forge')!;

function runOk(calls: string[][]): RunLike {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { exitCode: 0, stdout: 'ok' };
  };
}

describe('registryInstall', () => {
  it('cria venv, instala pinado, verifica e grava receipt + state', async () => {
    const calls: string[][] = [];
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'cache'),
      pythons: [py('3.11.9')],
      run: runOk(calls),
      fetchImpl: fetchOk,
      now: () => '2026-10-17T00:00:00Z',
    });
    expect(res).not.toHaveProperty('stage');
    if ('stage' in res) return;
    expect(res.version).toBe('0.1.0');
    expect(res.dist).toBe('apiforge-af');
    expect(res.method).toBe('pypi');
    expect(res.verify.ok).toBe(true);

    const venvDir = forgeVenv(tmp, 'api-forge');
    expect(calls[0][0]).toBe('python3');
    expect(calls[0]).toContain('-m');
    expect(calls[0]).toContain('venv');
    expect(calls[0].at(-1)).toBe(venvDir);
    expect(calls[1].slice(-1)).toEqual(['apiforge-af==0.1.0']);
    expect(calls[2][0]).toBe(res.bin);
    expect(calls[2][1]).toBe('--help');

    const receipt = JSON.parse(readFileSync(receiptPath(tmp, 'api-forge'), 'utf8'));
    expect(receipt.version).toBe('0.1.0');
    expect(receipt.files[0].sha256).toBe('a'.repeat(64));
    const state = loadForgeState(tmp);
    expect(state.forges['api-forge'].dist).toBe('apiforge-af');
  });

  it('escolhe o interpretador mais novo que satisfaz requires_python', async () => {
    const payload = {
      info: { requires_python: '>=3.11,<3.13' },
      releases: PYPI.releases,
    };
    const calls: string[][] = [];
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.13.0'), py('3.12.1'), py('3.10.9')],
      run: runOk(calls),
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(payload) }),
    });
    if ('stage' in res) throw new Error('unexpected failure');
    expect(res.python).toBe('3.12.1');
  });

  it('python incompatível → erro honesto antes de criar venv', async () => {
    const payload = {
      info: { requires_python: '>=3.12' },
      releases: PYPI.releases,
    };
    const calls: string[][] = [];
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.11.9')],
      run: runOk(calls),
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(payload) }),
    });
    expect(res).toMatchObject({ stage: 'resolve', error: { kind: 'python-incompatible' } });
    expect(calls).toHaveLength(0); // nada foi executado
  });

  it('piso do catálogo bloqueia interpretador antigo sem requires_python no PyPI', async () => {
    const payload = { info: {}, releases: PYPI.releases }; // sem requires_python
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.9.18')],
      run: runOk([]),
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(payload) }),
    });
    expect(res).toMatchObject({ stage: 'resolve', error: { kind: 'python-incompatible' } });
  });

  it('pip falha → stage pip com detalhe', async () => {
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.11.0')],
      run: async (_c, args) =>
        args.includes('pip')
          ? { exitCode: 1, stderr: 'ResolutionImpossible' }
          : { exitCode: 0 },
      fetchImpl: fetchOk,
    });
    expect(res).toMatchObject({ stage: 'pip' });
  });

  it('verify falha → stage verify mas receipt já gravado (auditoria)', async () => {
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.11.0')],
      run: async (cmd) =>
        cmd.endsWith('/bin/apiforge') || cmd.endsWith('apiforge.exe')
          ? { exitCode: 2 }
          : { exitCode: 0 },
      fetchImpl: fetchOk,
    });
    expect(res).toMatchObject({ stage: 'verify' });
    const receipt = JSON.parse(readFileSync(receiptPath(tmp, 'api-forge'), 'utf8'));
    expect(receipt.verify.ok).toBe(false);
  });

  it('sem interpretadores → no-python', async () => {
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: tmp,
      pythons: [],
      fetchImpl: fetchOk,
    });
    expect(res).toMatchObject({ stage: 'no-python' });
  });
});

describe('registryUninstall', () => {
  it('remove dir + receipt e atualiza state', async () => {
    const calls: string[][] = [];
    await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.11.0')],
      run: runOk(calls),
      fetchImpl: fetchOk,
    });
    expect(loadForgeState(tmp).forges['api-forge']).toBeTruthy();
    const res = registryUninstall(ENTRY, { home: tmp });
    expect(res.removed).toBe(true);
    expect(res.receiptRemoved).toBe(true);
    expect(loadForgeState(tmp).forges['api-forge']).toBeUndefined();
    expect(existsSync(path.join(tmp, '.forge-cli', 'forges', 'api-forge'))).toBe(false);
  });

  it('idempotente quando não instalado', () => {
    const res = registryUninstall(ENTRY, { home: tmp });
    expect(res.removed).toBe(false);
    expect(res.receiptRemoved).toBe(false);
  });
});
