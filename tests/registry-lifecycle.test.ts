import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliOptions } from '../src/cli-args.js';
import {
  runRegistryPin,
  runRegistryReinstall,
  runRegistryRollback,
  runRegistryUpdate,
} from '../src/cmd/registry.js';
import { registryEntry } from '../src/registry/catalog.js';
import {
  forgeStatePath,
  forgeVenv,
  forgesRoot,
  loadForgeState,
  type RegistryInstallReceipt,
  type RunLike,
  type RunResult,
} from '../src/registry/install.js';
import type { FetchLike } from '../src/registry/pypi.js';
import { parseVersion } from '../src/registry/versions.js';

let tmp: string;
beforeEach(() => (tmp = mkdtempSync(path.join(os.tmpdir(), 'reg-life-'))));
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

// ---------------------------------------------------------------------------
// Fixtures — mesmo harness do registry-install.test.ts
// ---------------------------------------------------------------------------

const WHEEL_BYTES = 'fake-wheel-bytes';
const WHEEL_SHA = createHash('sha256').update(WHEEL_BYTES).digest('hex');
const WHEEL_NAME = 'apiforge_af-0.1.0-py3-none-any.whl';
const WHEEL_NAME_2 = 'apiforge_af-0.2.0-py3-none-any.whl';

const PYPI = {
  info: { requires_python: '>=3.10' },
  releases: {
    '0.1.0': [
      {
        filename: WHEEL_NAME,
        url: 'https://f/apiforge_af-0.1.0.whl',
        digests: { sha256: WHEEL_SHA },
        packagetype: 'bdist_wheel',
      },
    ],
    '0.2.0': [
      {
        filename: WHEEL_NAME_2,
        url: 'https://f/apiforge_af-0.2.0.whl',
        digests: { sha256: WHEEL_SHA },
        packagetype: 'bdist_wheel',
      },
    ],
  },
};
const fetchOk: FetchLike = async () => ({ status: 200, body: JSON.stringify(PYPI) });
const py = () => [{ exe: ['python3'], version: '3.12.4', parsed: parseVersion('3.12.4')! }];

const runOk: RunLike = async (cmd, args) => {
  const di = args.indexOf('--dest');
  if (args.includes('download') && di !== -1) {
    const name = args.join(' ').includes('0.2.0') ? WHEEL_NAME_2 : WHEEL_NAME;
    writeFileSync(path.join(args[di + 1], name), WHEEL_BYTES);
  }
  // `python -m venv <dir>` → o mock cria o dir como o venv real faria
  const vi = args.indexOf('venv');
  if (vi !== -1 && args.includes('-m') && args[vi + 1]) {
    mkdirSync(args[vi + 1], { recursive: true });
  }
  void cmd;
  return { exitCode: 0, stdout: 'ok' } as RunResult;
};

function seed(
  version = '0.1.0',
  over: Partial<RegistryInstallReceipt> = {},
): RegistryInstallReceipt {
  mkdirSync(forgeVenv(tmp, 'api-forge'), { recursive: true });
  const receipt: RegistryInstallReceipt = {
    forge: 'api-forge',
    method: 'pypi',
    dist: 'apiforge-af',
    version,
    python: '3.12.4',
    source: 'latest-stable',
    venv: forgeVenv(tmp, 'api-forge'),
    bin: path.join(forgeVenv(tmp, 'api-forge'), 'bin', 'apiforge'),
    installedAt: '2026-01-01T00:00:00Z',
    verify: { command: [], ok: true },
    files: [],
    ...over,
  };
  const state = loadForgeState(tmp);
  state.forges['api-forge'] = receipt;
  mkdirSync(path.dirname(forgeStatePath(tmp)), { recursive: true });
  writeFileSync(forgeStatePath(tmp), JSON.stringify(state));
  return receipt;
}

const exitCodes = () => {
  const codes: (number | undefined)[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    codes.push(c);
  }) as never);
  return codes;
};

// ---------------------------------------------------------------------------

describe('update --method registry', () => {
  it('instala versão mais nova e empilha a anterior em history', async () => {
    seed('0.1.0');
    await runRegistryUpdate(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runOk,
    });
    const state = loadForgeState(tmp).forges['api-forge'];
    expect(state.version).toBe('0.2.0');
    expect(state.history).toEqual([{ version: '0.1.0', installedAt: '2026-01-01T00:00:00Z' }]);
  });

  it('já na mais recente → nada a fazer, exit 0', async () => {
    seed('0.2.0');
    const codes = exitCodes();
    await runRegistryUpdate(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runOk,
    });
    expect(codes).not.toContain(1);
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.2.0');
  });

  it('pinned → skipped, versão não muda', async () => {
    seed('0.1.0', { pinned: '0.1.0' });
    await runRegistryUpdate(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runOk,
    });
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.1.0');
    expect(loadForgeState(tmp).forges['api-forge'].pinned).toBe('0.1.0');
  });

  it('--check resolve sem mutar state/venv', async () => {
    seed('0.1.0');
    await runRegistryUpdate(cli({ check: true }), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
    });
    const state = loadForgeState(tmp).forges['api-forge'];
    expect(state.version).toBe('0.1.0');
    expect(state.history).toBeUndefined();
  });

  it('não instalado → skipped; desconhecido → exit 2', async () => {
    const codes = exitCodes();
    await runRegistryUpdate(cli(), ['platform-forge', 'bogus'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runOk,
    });
    expect(codes).toContain(2);
  });
});

describe('reinstall --method registry', () => {
  it('reinstala a MESMA versão (drift repair) — sem history nova', async () => {
    seed('0.1.0');
    await runRegistryReinstall(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runOk,
    });
    const state = loadForgeState(tmp).forges['api-forge'];
    expect(state.version).toBe('0.1.0');
    expect(state.history).toBeUndefined();
  });

  it('preserva pin através do reinstall', async () => {
    seed('0.1.0', { pinned: '0.1.0', history: [{ version: '0.0.9', installedAt: 'x' }] });
    await runRegistryReinstall(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runOk,
    });
    const state = loadForgeState(tmp).forges['api-forge'];
    expect(state.pinned).toBe('0.1.0');
    expect(state.history).toEqual([{ version: '0.0.9', installedAt: 'x' }]);
  });

  it('repara drift: venv apagada mas state presente → recria', async () => {
    seed('0.1.0');
    rmSync(forgeVenv(tmp, 'api-forge'), { recursive: true });
    await runRegistryReinstall(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runOk,
    });
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(true);
  });
});

describe('rollback --method registry', () => {
  it('desempilha a última versão e empilha a abandonada', async () => {
    seed('0.2.0', { history: [{ version: '0.1.0', installedAt: '2026-01-01T00:00:00Z' }] });
    await runRegistryRollback(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runOk,
    });
    const state = loadForgeState(tmp).forges['api-forge'];
    expect(state.version).toBe('0.1.0');
    expect(state.history).toEqual([{ version: '0.2.0', installedAt: expect.any(String) }]);
  });

  it('sem history → recusa honesta, exit 1', async () => {
    seed('0.1.0');
    const codes = exitCodes();
    await runRegistryRollback(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runOk,
    });
    expect(codes).toContain(1);
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.1.0');
  });

  it('rollback → rollback retorna à versão original', async () => {
    seed('0.2.0', { history: [{ version: '0.1.0', installedAt: '2026-01-01T00:00:00Z' }] });
    const deps = { home: tmp, pythons: py(), fetchImpl: fetchOk, run: runOk };
    await runRegistryRollback(cli(), ['api-forge'], deps);
    await runRegistryRollback(cli(), ['api-forge'], deps);
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.2.0');
  });
});

describe('pin/unpin --method registry', () => {
  it('pin grava a versão atual; unpin remove', async () => {
    seed('0.1.0');
    await runRegistryPin(cli(), ['api-forge'], true, { home: tmp });
    expect(loadForgeState(tmp).forges['api-forge'].pinned).toBe('0.1.0');
    await runRegistryPin(cli(), ['api-forge'], false, { home: tmp });
    expect(loadForgeState(tmp).forges['api-forge'].pinned).toBeUndefined();
  });

  it('pin em Forja não instalada → recusa (skipped), exit 1', async () => {
    const codes = exitCodes();
    await runRegistryPin(cli(), ['platform-forge'], true, { home: tmp });
    expect(codes).toContain(1);
  });

  it('nome desconhecido → exit 2', async () => {
    const codes = exitCodes();
    await runRegistryPin(cli(), ['bogus'], true, { home: tmp });
    expect(codes).toContain(2);
  });
});

describe('ghost-forge no lifecycle', () => {
  it('update funciona via entry sintético do receipt', async () => {
    // Forja removida do catálogo, mas com receipt — ghostEntry deriva dist/bin.
    mkdirSync(forgeVenv(tmp, 'ghost-x'), { recursive: true });
    const receipt: RegistryInstallReceipt = {
      forge: 'ghost-x',
      method: 'pypi',
      dist: 'apiforge-af', // reuse dist real para o fetch mock
      version: '0.1.0',
      python: '3.12.4',
      source: 'latest-stable',
      venv: forgeVenv(tmp, 'ghost-x'),
      bin: path.join(forgeVenv(tmp, 'ghost-x'), 'bin', 'apiforge'),
      installedAt: 'x',
      verify: { command: [], ok: true },
      files: [],
    };
    const state = loadForgeState(tmp);
    state.forges['ghost-x'] = receipt;
    mkdirSync(path.dirname(forgeStatePath(tmp)), { recursive: true });
    writeFileSync(forgeStatePath(tmp), JSON.stringify(state));

    await runRegistryUpdate(cli(), ['ghost-x'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runOk,
    });
    expect(loadForgeState(tmp).forges['ghost-x'].version).toBe('0.2.0');
  });
});

describe('catálogo sanity', () => {
  it('entry existe para a fixture', () => {
    expect(registryEntry('api-forge')!.dist).toBe('apiforge-af');
  });
  it('forgesRoot respeita home injetado', () => {
    expect(forgesRoot(tmp)).toContain(tmp);
  });
});

// ---------------------------------------------------------------------------
// Wave 2 — delegação ao instalador nativo (fase 2)
// ---------------------------------------------------------------------------

describe('delegação nativa no registry', () => {
  const calls: string[][] = [];
  const runRec: RunLike = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const di = args.indexOf('--dest');
    if (args.includes('download') && di !== -1) {
      const name = args.join(' ').includes('0.2.0') ? WHEEL_NAME_2 : WHEEL_NAME;
      writeFileSync(path.join(args[di + 1], name), WHEEL_BYTES);
    }
    const vi = args.indexOf('venv');
    if (vi !== -1 && args.includes('-m') && args[vi + 1]) {
      mkdirSync(args[vi + 1], { recursive: true });
    }
    return { exitCode: 0, stdout: 'ok' } as RunResult;
  };

  beforeEach(() => (calls.length = 0));

  it('install --native roda <venv-bin> install --dry-run (sem --yes)', async () => {
    const { runRegistryInstall } = await import('../src/cmd/registry.js');
    await runRegistryInstall(cli({ native: true }), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runRec,
    });
    // Última chamada = delegação nativa: argv[0] é o bin da venv
    const nat = calls.at(-1)!;
    expect(nat[0]).toBe(path.join(forgeVenv(tmp, 'api-forge'), 'bin', 'apiforge'));
    expect(nat.slice(1)).toEqual(['install', '--dry-run']);
    const receipt = loadForgeState(tmp).forges['api-forge'];
    expect(receipt.native).toMatchObject({ ran: true, dryRun: true, exitCode: 0 });
  });

  it('install --native --yes → --yes (não --dry-run) + flags documentadas viram argv', async () => {
    const { runRegistryInstall } = await import('../src/cmd/registry.js');
    await runRegistryInstall(
      cli({ native: true, yes: true, profile: 'minimal', scope: 'user' }),
      ['api-forge'],
      { home: tmp, pythons: py(), fetchImpl: fetchOk, run: runRec },
    );
    const nat = calls.at(-1)!;
    expect(nat.slice(1)).toEqual(['install', '--scope', 'user', '--profile', 'minimal', '--yes']);
    expect(loadForgeState(tmp).forges['api-forge'].native?.argv.slice(1)).toContain('--yes');
  });

  it('--profile inválido falha antes de gastar rede', async () => {
    const { runRegistryInstall } = await import('../src/cmd/registry.js');
    const fetchSpy = vi.fn(fetchOk);
    const codes = exitCodes();
    await runRegistryInstall(cli({ profile: 'nope' }), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchSpy,
      run: runRec,
    });
    expect(codes).toContain(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uninstall --native roda a op documentada antes de remover a venv', async () => {
    seed('0.1.0');
    const { runRegistryUninstall } = await import('../src/cmd/registry.js');
    await runRegistryUninstall(cli({ yes: true, native: true }), ['api-forge'], {
      home: tmp,
      run: runRec,
    });
    const nat = calls.at(-1)!;
    expect(nat[0]).toContain('apiforge');
    // buildNativeOp: aprovado = argv sem --dry-run (não adiciona --yes)
    expect(nat.slice(1)).toEqual(['install', 'uninstall']);
    expect(loadForgeState(tmp).forges['api-forge']).toBeUndefined();
  });

  it('forge-doctor-api (--native) → skip honesto (script do repo, não da wheel)', async () => {
    const { runRegistryInstall } = await import('../src/cmd/registry.js');
    // dist forge-doctor-api precisa de fixture própria — reuse apiforge-af não vale.
    // O caminho testável é delegateNative com entry + receipt sintéticos:
    const { delegateNative } = await import('../src/cmd/registry.js');
    const entry = registryEntry('forge-doctor-api')!;
    const receipt = seed('0.1.0');
    const n = await delegateNative(
      cli({ native: true }),
      entry,
      { ...receipt, forge: 'forge-doctor-api', dist: 'forge-doctor-api' },
      'install',
      runRec,
    );
    expect(n).toMatchObject({ ran: false });
    expect(n?.skipped).toContain('script');
  });

  it('update com --native roda a op update do instalador', async () => {
    seed('0.1.0');
    await runRegistryUpdate(cli({ native: true, yes: true }), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runRec,
    });
    const nat = calls.at(-1)!;
    expect(nat.slice(1)).toEqual(['install', 'update']);
    expect(loadForgeState(tmp).forges['api-forge'].native?.argv.slice(1)).toContain('update');
  });
});
