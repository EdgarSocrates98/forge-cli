import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliOptions } from '../src/cli-args.js';
import {
  ignoredRegistryFlags,
  probePythons,
  resolveRegistryTargets,
  runRegistryInstall,
  runRegistryList,
  runRegistryUninstall,
} from '../src/cmd/registry.js';
import { mergeRegistryPhase } from '../src/cmd/query.js';
import {
  forgeStatePath,
  forgeVenv,
  forgesRoot,
  loadForgeState,
  type RegistryInstallReceipt,
} from '../src/registry/install.js';
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
    expect(flags).not.toContain('--report');
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

describe('runRegistryInstall — dedupe e --report', () => {
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
  const py = () => [{ exe: ['python3'], version: '3.12.4', parsed: parseVersion('3.12.4')! }];
  const fetchOk = async () => ({ status: 200, body: JSON.stringify(PYPI) });

  it('nome + alias do mesmo Forge planejam uma só vez (dedupe)', async () => {
    const res = await runRegistryInstall(cli({ plan: true }), ['api-forge', 'apiforge-af'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
    });
    expect(res).toHaveLength(1);
    expect(res[0].forge).toBe('api-forge');
  });

  it('--report <arq> escreve o documento JSON (honrada, não "ignorada")', async () => {
    const file = path.join(tmp, 'plan-report.json');
    await runRegistryInstall(
      cli({ plan: true, jsonReport: true, reportPath: file }),
      ['api-forge'],
      { home: tmp, pythons: py(), fetchImpl: fetchOk },
    );
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.plan).toBe(true);
    expect(doc.planned[0]).toMatchObject({ forge: 'api-forge', ok: true });
  });
});

describe('runRegistryUninstall', () => {
  const seed = (name: string, dist: string) => {
    mkdirSync(path.join(forgesRoot(tmp), name, 'venv'), { recursive: true });
    const receipt: RegistryInstallReceipt = {
      forge: name,
      method: 'pypi',
      dist,
      version: '0.1.0',
      python: '3.12.4',
      source: 'latest-stable',
      venv: forgeVenv(tmp, name),
      bin: path.join(forgeVenv(tmp, name), 'bin', dist),
      installedAt: '2026-01-01T00:00:00Z',
      verify: { command: [], ok: true },
      files: [],
    };
    const state = loadForgeState(tmp);
    state.forges[name] = receipt;
    mkdirSync(path.dirname(forgeStatePath(tmp)), { recursive: true });
    writeFileSync(forgeStatePath(tmp), JSON.stringify(state));
  };
  const exitCodes = () => {
    const codes: (number | undefined)[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      codes.push(c);
    }) as never);
    return codes;
  };

  it('remove venv + wheel cache + state (e flags ignoradas avisam)', async () => {
    seed('api-forge', 'apiforge-af');
    const wheels = path.join(tmp, '.forge-cli', 'cache', 'wheels', 'apiforge-af');
    mkdirSync(wheels, { recursive: true });
    writeFileSync(path.join(wheels, 'x.whl'), 'w');
    const codes = exitCodes();
    await runRegistryUninstall(cli({ yes: true, dir: '/tmp/zzz' }), ['api-forge'], {
      home: tmp,
    });
    expect(codes).not.toContain(2);
    expect(existsSync(wheels)).toBe(false);
    expect(existsSync(path.join(forgesRoot(tmp), 'api-forge'))).toBe(false);
    expect(loadForgeState(tmp).forges['api-forge']).toBeUndefined();
  });

  it('Forja fora do catálogo mas presente no state → desinstala mesmo assim', async () => {
    seed('ghost-forge', 'ghost-dist');
    const codes = exitCodes();
    await runRegistryUninstall(cli({ yes: true }), ['ghost-forge'], { home: tmp });
    expect(codes).not.toContain(2);
    expect(loadForgeState(tmp).forges['ghost-forge']).toBeUndefined();
    expect(existsSync(path.join(forgesRoot(tmp), 'ghost-forge'))).toBe(false);
  });

  it('nome + alias do mesmo Forge desinstalam uma só vez', async () => {
    seed('api-forge', 'apiforge-af');
    exitCodes();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as never);
    await runRegistryUninstall(cli({ yes: true, jsonReport: true }), ['api-forge', 'apiforge-af'], {
      home: tmp,
    });
    // process.exit mockado deixa o fluxo seguir — o JSON é o chunk '{…}'
    // (logs humanos podem escrever depois dele quando o exit não aborta).
    const jsonChunk = writes.find((w) => w.trimStart().startsWith('{'))!;
    const doc = JSON.parse(jsonChunk);
    expect(doc.results).toHaveLength(1);
    expect(doc.results[0].forge).toBe('api-forge');
  });

  it('conhecido + desconhecido → remove o conhecido e sai 2', async () => {
    seed('api-forge', 'apiforge-af');
    const codes = exitCodes();
    await runRegistryUninstall(cli({ yes: true }), ['api-forge', 'bogus'], { home: tmp });
    expect(codes).toContain(2);
    expect(loadForgeState(tmp).forges['api-forge']).toBeUndefined();
  });

  it('não-TTY sem --yes recusa limpa (exit 0), nunca trava em prompt', async () => {
    seed('api-forge', 'apiforge-af');
    const codes = exitCodes();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as never);
    // vitest roda sem TTY — antes do fix este caminho chamava confirm()
    // e pendurava esperando stdin que nunca chega.
    await runRegistryUninstall(cli({}), ['api-forge'], { home: tmp });
    expect(codes).toContain(0);
    expect(writes.join('')).toContain('--yes');
    // recusa não removeu nada
    expect(loadForgeState(tmp).forges['api-forge']).toBeTruthy();
    expect(existsSync(path.join(forgesRoot(tmp), 'api-forge'))).toBe(true);
  });

  it('nome do Object.prototype ("constructor") → desconhecido, sai 2', async () => {
    const codes = exitCodes();
    await runRegistryUninstall(cli({ yes: true }), ['constructor'], { home: tmp });
    expect(codes).toContain(2);
  });

  it('state com receipt não-objeto não derruba o list', async () => {
    const stateDir = path.join(tmp, '.forge-cli', 'forges');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, 'state.json'),
      JSON.stringify({ forges: { 'api-forge': 'garbage' } }),
    );
    expect(() => runRegistryList(cli({}), { home: tmp })).not.toThrow();
    // entrada malformada é filtrada no load — aparece como não instalada
    expect(loadForgeState(tmp).forges['api-forge']).toBeUndefined();
  });
});

describe('mergeRegistryPhase — status honesto quando venv sumiu', () => {
  const receipt = (bin: string): RegistryInstallReceipt => ({
    forge: 'api-forge',
    method: 'pypi',
    dist: 'apiforge-af',
    version: '0.1.0',
    python: '3.12.4',
    source: 'latest-stable',
    venv: '/v',
    bin,
    installedAt: 'x',
    verify: { command: [], ok: true },
    files: [],
  });
  const info = () => [
    { name: 'api-forge', phase: 'not-installed' } as {
      name: string;
      phase: string;
      describe?: string;
    },
  ];
  it('bin ausente → drifted + "(bin ausente)", não "installed"', () => {
    const infos = info();
    mergeRegistryPhase(infos, { 'api-forge': receipt(path.join(tmp, 'nope', 'apiforge')) });
    expect(infos[0].phase).toBe('drifted');
    expect(infos[0].describe).toContain('bin ausente');
  });
  it('bin presente → installed', () => {
    const bin = path.join(tmp, 'apiforge');
    writeFileSync(bin, '#!/bin/sh\n');
    const infos = info();
    mergeRegistryPhase(infos, { 'api-forge': receipt(bin) });
    expect(infos[0].phase).toBe('installed');
    expect(infos[0].describe).toBe('pypi apiforge-af==0.1.0');
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
