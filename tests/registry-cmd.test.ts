import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliOptions } from '../src/cli-args.js';
import {
  ignoredRegistryFlags,
  probePythons,
  resolveRegistryTargets,
  runRegistryInstall,
} from '../src/cmd/registry.js';
import { forgeStatePath, forgeVenv, loadForgeState } from '../src/registry/install.js';
import { isPrerelease, parseVersion } from '../src/registry/versions.js';

let tmp: string;
beforeEach(() => (tmp = mkdtempSync(path.join(os.tmpdir(), 'reg-cmd-'))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const cli = (over: Partial<CliOptions> = {}) =>
  ({
    only: undefined,
    all: false,
    yes: false,
    jsonReport: false,
    timeoutSet: false,
    jobsSet: false,
    ...over,
  }) as CliOptions;

describe('resolveRegistryTargets', () => {
  const installed = ['api-forge', 'forge-doctor-api'];
  it('posicionais vencem --only e --all', () => {
    expect(resolveRegistryTargets(cli({ only: ['x'], all: true }), ['a'], installed)).toEqual([
      'a',
    ]);
  });
  it('--only sem posicionais', () => {
    expect(resolveRegistryTargets(cli({ only: ['x', 'y'] }), [], installed)).toEqual(['x', 'y']);
  });
  it('--all resolve o conjunto instalado, não o catálogo', () => {
    expect(resolveRegistryTargets(cli({ all: true }), [], installed)).toEqual(installed);
  });
  it('sem nada → [] (o chamador recusa)', () => {
    expect(resolveRegistryTargets(cli(), [], installed)).toEqual([]);
  });
});

describe('ignoredRegistryFlags', () => {
  it('lista flags com efeito ignorado no método registry', () => {
    const flags = ignoredRegistryFlags(
      cli({
        dir: '/tmp/x',
        profile: 'full',
        skipVerify: true,
        skipScripts: true,
        shallow: true,
        fix: true,
        rollback: true,
        gatewayProfile: 'g',
        trustCustom: true,
        runAfterSyncFailure: true,
        reportPath: '/tmp/r.json',
        onlyChanged: true,
        timeoutSet: true,
        jobsSet: true,
      }),
    );
    for (const f of [
      '--dir',
      '--profile',
      '--skip-verify',
      '--skip-scripts',
      '--shallow',
      '--fix',
      '--rollback',
      '--gateway-profile',
      '--trust-custom',
      '--run-after-sync-failure',
      '--report-path',
      '--only-changed',
      '--timeout',
      '--jobs',
    ]) {
      expect(flags).toContain(f);
    }
    expect(flags).not.toContain('--scope');
    // honradas, não ignoradas
    expect(flags).not.toContain('--plan');
    expect(flags).not.toContain('--check');
    expect(flags).not.toContain('--clean');
  });
  it('sem flags → vazio', () => {
    expect(ignoredRegistryFlags(cli())).toEqual([]);
  });
});

describe('runRegistryInstall --plan', () => {
  const PYPI = {
    info: { requires_python: '>=3.10' },
    releases: {
      '0.1.0': [
        {
          filename: 'apiforge_af-0.1.0-py3-none-any.whl',
          url: 'https://f/x.whl',
          digests: { sha256: 'a'.repeat(64) },
          packagetype: 'bdist_wheel',
        },
      ],
    },
  };

  it('resolve sem mutar — nenhuma venv, receipt ou state', async () => {
    const res = await runRegistryInstall(cli({ plan: true }), ['api-forge'], {
      home: tmp,
      pythons: [{ exe: ['python3'], version: '3.12.4', parsed: parseVersion('3.12.4')! }],
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(PYPI) }),
    });
    expect(res).toEqual([
      expect.objectContaining({ forge: 'api-forge', ok: true, version: '0.1.0' }),
    ]);
    expect(existsSync(forgeStatePath(tmp))).toBe(false);
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(false);
  });

  it('alias de dist (apiforge-af) normaliza para o nome da Forja', async () => {
    const res = await runRegistryInstall(cli({ plan: true }), ['apiforge-af'], {
      home: tmp,
      pythons: [{ exe: ['python3'], version: '3.12.4', parsed: parseVersion('3.12.4')! }],
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(PYPI) }),
    });
    expect(res).toEqual([
      expect.objectContaining({ forge: 'api-forge', ok: true, version: '0.1.0' }),
    ]);
  });

  it('--version v0.1.0 aceita prefixo v (PyPI usa chave sem v)', async () => {
    const res = await runRegistryInstall(cli({ plan: true, ref: 'v0.1.0' }), ['api-forge'], {
      home: tmp,
      pythons: [{ exe: ['python3'], version: '3.12.4', parsed: parseVersion('3.12.4')! }],
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(PYPI) }),
    });
    expect(res[0].ok).toBe(true);
    expect(res[0].version).toBe('0.1.0');
  });
});

describe('probePythons', () => {
  it('deduplica por versão e ordena mais novo primeiro', async () => {
    const seen: string[] = [];
    const out = await probePythons('linux', async (exe) => {
      seen.push(exe);
      return { 'python3.14': 'Python 3.14.0', 'python3.13': 'Python 3.13.2' }[exe] ?? null;
    });
    expect(out.map((p) => p.version)).toEqual(['3.14.0', '3.13.2']);
    expect(seen).toContain('python3.14');
  });
  it('pré-release de interpretador parseia com sufixo', async () => {
    const out = await probePythons('linux', async (exe) =>
      exe === 'python3.14' ? 'Python 3.14.0a1' : null,
    );
    expect(out).toHaveLength(1);
    expect(out[0].version).toBe('3.14.0a1');
    expect(isPrerelease(out[0].parsed)).toBe(true);
  });
  it('saída irreconhecível é ignorada', async () => {
    const out = await probePythons('linux', async () => 'weird');
    expect(out).toEqual([]);
  });
});

describe('loadForgeState corrompido', () => {
  it('JSON quebrado → backup .corrupt preservado + estado vazio', () => {
    const file = forgeStatePath(tmp);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{forges: !!!');
    const state = loadForgeState(tmp);
    expect(state.forges).toEqual({});
    expect(existsSync(`${file}.corrupt`)).toBe(true);
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe('{forges: !!!');
  });
});
