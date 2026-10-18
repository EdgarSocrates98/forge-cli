import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliOptions } from '../src/cli-args.js';
import { pinMethodFor } from '../src/cmd/manage.js';
import {
  runRegistryInstall,
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

  // E2E 11.2.1: `update --check --method registry` sem nomes reportava
  // "nenhuma Forja instalada" mesmo com receipts — leitura pura deve
  // cobrir TODAS as instaladas (contrato do update --check git).
  it('--check sem nomes cobre TODAS as instaladas — nunca mensagem falsa', async () => {
    seed('0.1.0');
    mkdirSync(forgeVenv(tmp, 'platform-forge'), { recursive: true });
    const st = loadForgeState(tmp);
    st.forges['platform-forge'] = {
      ...st.forges['api-forge'],
      forge: 'platform-forge',
      dist: 'platformforge',
      bin: path.join(forgeVenv(tmp, 'platform-forge'), 'bin', 'platformforge'),
    };
    writeFileSync(forgeStatePath(tmp), JSON.stringify(st));
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as never);
    const codes = exitCodes();
    await runRegistryUpdate(cli({ check: true, jsonReport: true }), [], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
    });
    const doc = JSON.parse(chunks[0]);
    expect(doc.method).toBe('pypi');
    expect(doc.updates.map((u: { forge: string }) => u.forge).sort()).toEqual([
      'api-forge',
      'platform-forge',
    ]);
    expect(codes).not.toContain(2);
  });

  it('--check sem nenhuma instalada → updates vazio, exit 0 (check não é erro)', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as never);
    const codes = exitCodes();
    await runRegistryUpdate(cli({ check: true, jsonReport: true }), [], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
    });
    const doc = JSON.parse(chunks[0]);
    expect(doc.updates).toEqual([]);
    expect(codes).toEqual([0]);
  });

  it('update sem --check e sem seleção → erro nomeado que diz como selecionar', async () => {
    seed('0.1.0');
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as never);
    const codes = exitCodes();
    await runRegistryUpdate(cli({ jsonReport: true }), [], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
    });
    const doc = JSON.parse(chunks[0]);
    expect(doc.error).toContain('update --method registry exige nomes');
    expect(doc.error).not.toContain('nenhuma Forja instalada');
    expect(codes).toContain(2);
    // nada foi mutado — update exige seleção explícita
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.1.0');
  });

  it('update sem nenhuma instalada → mensagem de registry vazio honesta', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as never);
    const codes = exitCodes();
    await runRegistryUpdate(cli({ jsonReport: true }), [], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
    });
    const doc = JSON.parse(chunks[0]);
    expect(doc.error).toContain('nenhuma Forja instalada via registry');
    expect(codes).toContain(2);
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

  it('--version divergente da instalada → recusa honesta, receipt intacto', async () => {
    seed('0.1.0');
    const codes = exitCodes();
    await runRegistryPin(cli({ ref: '9.9.9' }), ['api-forge'], true, { home: tmp });
    expect(codes).toContain(1);
    // pin registry fixa a versão INSTALADA — 9.9.9 não pode ser escrito
    expect(loadForgeState(tmp).forges['api-forge'].pinned).toBeUndefined();
  });

  it('--version igual à instalada (prefixo v) → pin normal', async () => {
    seed('0.1.0');
    await runRegistryPin(cli({ ref: 'v0.1.0' }), ['api-forge'], true, { home: tmp });
    expect(loadForgeState(tmp).forges['api-forge'].pinned).toBe('0.1.0');
  });
});

// E2E 11.2.1: `forge pin <f>` sem --method escrevia estado git mesmo com
// a Forja instalada via registry. A rota decide pela instalação REAL —
// receipt + clone são a evidência, nunca o catálogo.
describe('pinMethodFor — rota pin/unpin sem --method', () => {
  const ws = () => path.join(tmp, 'ws');

  it('só receipt registry → registry', () => {
    seed('0.1.0');
    expect(pinMethodFor(['api-forge'], cli({ dir: ws() }), tmp)).toBe('registry');
  });

  it('só clone git → git (pin segue escrevendo estado git)', () => {
    mkdirSync(path.join(ws(), 'api-forge', '.git'), { recursive: true });
    expect(pinMethodFor(['api-forge'], cli({ dir: ws() }), tmp)).toBe('git');
  });

  it('receipt + clone → ambiguous (só --method resolve)', () => {
    seed('0.1.0');
    mkdirSync(path.join(ws(), 'api-forge', '.git'), { recursive: true });
    expect(pinMethodFor(['api-forge'], cli({ dir: ws() }), tmp)).toBe('ambiguous');
  });

  it('alias de dist resolve o nome canônico antes de inspecionar o state', () => {
    seed('0.1.0');
    expect(pinMethodFor(['apiforge-af'], cli({ dir: ws() }), tmp)).toBe('registry');
  });

  it('dir inexistente no clone + receipt → registry', () => {
    seed('0.1.0');
    mkdirSync(path.join(ws(), 'api-forge'), { recursive: true }); // sem .git
    expect(pinMethodFor(['api-forge'], cli({ dir: ws() }), tmp)).toBe('registry');
  });

  it('0 ou >1 nomes → defer (pickOne decide o erro)', () => {
    expect(pinMethodFor([], cli({ dir: ws() }), tmp)).toBe('defer');
    expect(pinMethodFor(['api-forge', 'platform-forge'], cli({ dir: ws() }), tmp)).toBe('defer');
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
    await runRegistryInstall(cli({ native: true }), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runRec,
    });
    // Última chamada = delegação nativa: argv[0] é o bin do receipt (venv)
    const nat = calls.at(-1)!;
    const receipt = loadForgeState(tmp).forges['api-forge'];
    expect(nat[0]).toBe(receipt.bin);
    expect(nat.slice(1)).toEqual(['install', '--dry-run']);
    expect(receipt.native).toMatchObject({ ran: true, dryRun: true, exitCode: 0 });
  });

  it('install --native --yes → --yes (não --dry-run) + flags documentadas viram argv', async () => {
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
