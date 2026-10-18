// P0-003: fault injection do lifecycle registry — cada falha deve terminar em
// estado consistente + erro nomeado + zero half-state. Harness: fetch/run
// injetáveis (mesmo padrão de registry-install/registry-lifecycle).
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliOptions } from '../src/cli-args.js';
import {
  runRegistryInstall,
  runRegistryList,
  runRegistryRollback,
  runRegistryUninstall,
  runRegistryUpdate,
} from '../src/cmd/registry.js';
import { registryEntry } from '../src/registry/catalog.js';
import {
  acquireForgeLock,
  forgeLockDir,
  forgeStatePath,
  forgeVenv,
  forgesRoot,
  installConsistency,
  loadForgeState,
  receiptPath,
  registryInstall,
  saveForgeState,
  wheelCacheDir,
  type RegistryInstallReceipt,
  type RunLike,
  type RunResult,
} from '../src/registry/install.js';
import type { FetchLike } from '../src/registry/pypi.js';
import { parseVersion } from '../src/registry/versions.js';

// Fault injection via wrapper de fs: vi.mock é hoisted, então o interruptor
// fica em globalThis — determinístico, sem disco cheio nem permissão real.
vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  const g = globalThis as { __fsFault?: { needle?: string; code?: string; lockMkdir?: boolean } };
  return {
    ...mod,
    openSync: ((p: unknown, flags?: unknown, mode?: unknown) => {
      const f = g.__fsFault;
      if (f?.needle && typeof p === 'string' && p.includes(f.needle) && p.endsWith('.tmp')) {
        const err = new Error(`${f.code}: injected`) as NodeJS.ErrnoException;
        err.code = f.code;
        throw err;
      }
      return (mod.openSync as (...a: unknown[]) => number)(p, flags, mode);
    }) as typeof mod.openSync,
    mkdirSync: ((p: unknown, opts?: unknown) => {
      const f = g.__fsFault;
      if (f?.lockMkdir && typeof p === 'string' && p.endsWith('.forge-lifecycle.lock')) {
        const err = new Error('EACCES: injected') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return (mod.mkdirSync as (...a: unknown[]) => unknown)(p, opts);
    }) as typeof mod.mkdirSync,
  };
});

const fsFault = (f?: { needle?: string; code?: string; lockMkdir?: boolean }) => {
  (globalThis as { __fsFault?: unknown }).__fsFault = f;
};

let tmp: string;
beforeEach(() => (tmp = mkdtempSync(path.join(os.tmpdir(), 'fault-'))));
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

const ENTRY = registryEntry('api-forge')!;

const WHEEL_BYTES = 'fake-wheel-bytes';
const WHEEL_SHA = createHash('sha256').update(WHEEL_BYTES).digest('hex');
const WHEEL_NAME = 'apiforge_af-0.1.0-py3-none-any.whl';
const WHEEL_NAME_2 = 'apiforge_af-0.2.0-py3-none-any.whl';

const fileFor = (dist: string, ver: string) => ({
  filename: `${dist.replace(/[-_.]/g, '_')}-${ver}-py3-none-any.whl`,
  url: `https://f/${dist}-${ver}.whl`,
  digests: { sha256: WHEEL_SHA },
  packagetype: 'bdist_wheel',
});
const pypiPayload = (dist: string, yank?: (f: ReturnType<typeof fileFor>) => object) => ({
  info: { requires_python: '>=3.10' },
  releases: {
    '0.1.0': [{ ...fileFor(dist, '0.1.0'), ...(yank?.(fileFor(dist, '0.1.0')) ?? {}) }],
    '0.2.0': [{ ...fileFor(dist, '0.2.0'), ...(yank?.(fileFor(dist, '0.2.0')) ?? {}) }],
  },
});
const PYPI = pypiPayload('apiforge-af');
const fetchOk: FetchLike = async () => ({ status: 200, body: JSON.stringify(PYPI) });
const py = () => [{ exe: ['python3'], version: '3.12.4', parsed: parseVersion('3.12.4')! }];
const cacheDir = () => path.join(tmp, 'cache');
const wheelsDir = () => wheelCacheDir(cacheDir(), 'apiforge-af');

const cli = (over: Partial<CliOptions> = {}) =>
  ({ yes: true, jsonReport: true, ...over }) as CliOptions;

const exitCodes = () => {
  const codes: (number | undefined)[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    codes.push(c);
  }) as never);
  return codes;
};

/**
 * Nome da wheel fake para um spec `dist[extras]==ver` (PEP 427): o pip
 * nomeia o arquivo pela DIST — extras do requerimento nunca entram no
 * filename da wheel baixada.
 */
const wheelNameFor = (spec: string): string => {
  const [dist, ver] = spec.split('==');
  const base = dist.replace(/\[.*?\]/g, '');
  return `${base.replace(/[-_.]/g, '_')}-${ver}-py3-none-any.whl`;
};

/**
 * Runner padrão: `venv` cria o dir, `pip download` grava a wheel fake da
 * versão pedida (nome derivado do spec), resto sai 0. `failOn` permite
 * falhar por etapa.
 */
function runner(opts: {
  failOn?: (cmd: string, args: string[]) => RunResult | null;
  writeWheel?: boolean;
  createVenv?: boolean;
}): RunLike {
  return async (cmd, args) => {
    const di = args.indexOf('--dest');
    if (args.includes('download') && di !== -1 && opts.writeWheel !== false) {
      const spec = args.find((a) => a.includes('==')) ?? 'x==0';
      writeFileSync(path.join(args[di + 1], wheelNameFor(spec)), WHEEL_BYTES);
    }
    const vi = args.indexOf('venv');
    if (vi !== -1 && args.includes('-m') && args[vi + 1] && opts.createVenv !== false) {
      mkdirSync(args[vi + 1], { recursive: true });
    }
    return opts.failOn?.(cmd, args) ?? { exitCode: 0, stdout: 'ok' };
  };
}

function seed(version = '0.1.0', over: Partial<RegistryInstallReceipt> = {}) {
  const venv = forgeVenv(tmp, 'api-forge');
  mkdirSync(path.join(venv, 'bin'), { recursive: true });
  writeFileSync(path.join(venv, 'bin', 'apiforge'), '#!/bin/sh\n');
  const receipt: RegistryInstallReceipt = {
    forge: 'api-forge',
    method: 'pypi',
    dist: 'apiforge-af',
    version,
    python: '3.12.4',
    source: 'latest-stable',
    venv,
    bin: path.join(venv, 'bin', 'apiforge'),
    installedAt: '2026-01-01T00:00:00Z',
    verify: { command: [], ok: true },
    files: [],
    ...over,
  };
  mkdirSync(path.dirname(forgeStatePath(tmp)), { recursive: true });
  writeFileSync(receiptPath(tmp, 'api-forge'), `${JSON.stringify(receipt, null, 2)}\n`);
  const state = loadForgeState(tmp);
  state.forges['api-forge'] = receipt;
  writeFileSync(forgeStatePath(tmp), JSON.stringify(state));
  return receipt;
}

const forgeDir = () => path.join(forgesRoot(tmp), 'api-forge');

describe('fault injection — install', () => {
  it('download interrompido → stage download + venv removida + sem state', async () => {
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({
        failOn: (_c, args) =>
          args.includes('download') ? { exitCode: 1, stderr: 'connection reset' } : null,
      }),
    });
    expect(res).toMatchObject({ stage: 'download' });
    expect((res as { detail?: string }).detail).toContain('connection reset');
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(false);
    expect(existsSync(forgeDir())).toBe(false);
    expect(loadForgeState(tmp).forges['api-forge']).toBeUndefined();
  });

  it('hash divergente → quarentena .rejected + venv removida + sem state', async () => {
    const tampered: RunLike = async (cmd, args) => {
      // pip download grava conteúdo adulterado — digest ≠ metadata PyPI
      const di = args.indexOf('--dest');
      if (args.includes('download') && di !== -1) {
        const spec = args.find((a) => a.includes('==')) ?? 'x==0';
        writeFileSync(path.join(args[di + 1], wheelNameFor(spec)), 'tampered-bytes');
      }
      const vi = args.indexOf('venv');
      if (vi !== -1 && args.includes('-m') && args[vi + 1]) {
        mkdirSync(args[vi + 1], { recursive: true });
      }
      void cmd;
      return { exitCode: 0 };
    };
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: tampered,
    });
    expect(res).toMatchObject({ stage: 'hash-mismatch' });
    const rejected = path.join(wheelsDir(), `${WHEEL_NAME_2}.rejected`);
    expect(existsSync(rejected)).toBe(true);
    expect(readFileSync(rejected, 'utf8')).toBe('tampered-bytes');
    expect(existsSync(path.join(wheelsDir(), WHEEL_NAME_2))).toBe(false);
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(false);
    expect(loadForgeState(tmp).forges['api-forge']).toBeUndefined();
  });

  it('cache adulterado (offline) → hash-mismatch + quarentena + sem venv', async () => {
    mkdirSync(wheelsDir(), { recursive: true });
    // resolve offline escolhe a última release (0.2.0) — adultera a wheel dela.
    writeFileSync(path.join(wheelsDir(), WHEEL_NAME_2), 'tampered');
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(
      path.join(cacheDir(), 'apiforge-af.json'),
      JSON.stringify({ fetchedAt: Date.now(), payload: PYPI }),
    );
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      offline: true,
      run: async () => ({ exitCode: 0 }),
    });
    expect(res).toMatchObject({ stage: 'hash-mismatch' });
    expect(existsSync(path.join(wheelsDir(), `${WHEEL_NAME_2}.rejected`))).toBe(true);
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(false);
  });

  it('venv incompleta (sem bin) → verify falha nomeado + receipt auditável', async () => {
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({
        // venv "criada" mas bin nunca sai 0 — verify é a última linha de defesa
        failOn: (cmd) => (cmd.includes('apiforge') ? { exitCode: 127 } : null),
      }),
    });
    expect(res).toMatchObject({ stage: 'verify' });
    // receipt gravado para auditoria + state consistente com verify.ok=false
    const receipt = JSON.parse(readFileSync(receiptPath(tmp, 'api-forge'), 'utf8'));
    expect(receipt.verify.ok).toBe(false);
    expect(loadForgeState(tmp).forges['api-forge'].verify.ok).toBe(false);
  });

  it('pip fail → stage pip + cleanup total + state de outras Forjas intocado', async () => {
    seed('0.0.9'); // Forja já instalada convive — não pode ser afetada
    const res = await registryInstall(registryEntry('platform-forge')!, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(pypiPayload('platformforge')) }),
      run: runner({ failOn: (_c, a) => (a.includes('install') ? { exitCode: 1 } : null) }),
    });
    // platformforge resolve para 0.2.0 (mesmo payload) → pip install falha
    expect(res).toMatchObject({ stage: 'pip' });
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.0.9');
    expect(existsSync(path.join(forgesRoot(tmp), 'platform-forge'))).toBe(false);
  });

  it('pacote 404 no PyPI → resolve not-found + zero escrita', async () => {
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: async () => ({ status: 404, body: 'not found' }),
      run: runner({}),
    });
    expect(res).toMatchObject({
      stage: 'resolve',
      error: { kind: 'not-found', dist: 'apiforge-af' },
    });
    expect(existsSync(forgeDir())).toBe(false);
  });

  it('versão yanked: só instala por pin explícito e marca o receipt', async () => {
    const yanked = pypiPayload('apiforge-af', () => ({ yanked: true }));
    // sem pin: nenhuma estável instalável → malformed, nunca instala yanked
    const unpinned = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(yanked) }),
      run: runner({}),
    });
    expect(unpinned).toMatchObject({ stage: 'resolve' });
    expect(existsSync(forgeDir())).toBe(false);
    // com pin: instala e o receipt carrega yanked:true (evidência honesta)
    const pinned = await registryInstall(ENTRY, '0.1.0', {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(yanked) }),
      run: runner({}),
    });
    expect(pinned).not.toHaveProperty('stage');
    if ('stage' in pinned) return;
    expect(pinned.yanked).toBe(true);
  });
});

describe('fault injection — state.json corrompido', () => {
  it('parse falha → degrada para vazio sem mutar nada (load é puro)', () => {
    mkdirSync(path.dirname(forgeStatePath(tmp)), { recursive: true });
    writeFileSync(forgeStatePath(tmp), '{ corrupt json !!!');
    const state = loadForgeState(tmp);
    expect(state.forges).toEqual({});
    // Leitura NUNCA escreve: a quarentena .corrupt só acontece na próxima
    // escrita (saveForgeState) — um load em --plan/--check não pode
    // produzir efeito colateral.
    const corrupt = `${forgeStatePath(tmp)}.corrupt`;
    expect(existsSync(corrupt)).toBe(false);
    // state.json original é preservado (não sobrescrito silenciosamente)
    expect(readFileSync(forgeStatePath(tmp), 'utf8')).toBe('{ corrupt json !!!');
  });

  it('saveForgeState sobre state corrompido → .corrupt preserva evidência', () => {
    mkdirSync(path.dirname(forgeStatePath(tmp)), { recursive: true });
    writeFileSync(forgeStatePath(tmp), '{ corrupt json !!!');
    saveForgeState(tmp, { forges: {} });
    const corrupt = `${forgeStatePath(tmp)}.corrupt`;
    expect(existsSync(corrupt)).toBe(true);
    expect(readFileSync(corrupt, 'utf8')).toBe('{ corrupt json !!!');
    // e o novo state é válido
    expect(loadForgeState(tmp).forges).toEqual({});
  });

  it('install sobre state corrompido → novo state válido sem perder .corrupt', async () => {
    mkdirSync(path.dirname(forgeStatePath(tmp)), { recursive: true });
    writeFileSync(forgeStatePath(tmp), 'not json');
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
    });
    expect(res).not.toHaveProperty('stage');
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.2.0');
    expect(existsSync(`${forgeStatePath(tmp)}.corrupt`)).toBe(true);
  });
});

describe('fault injection — lifecycle (update/rollback interrompidos)', () => {
  it('update com download interrompido → instalação anterior restaurada', async () => {
    seed('0.1.0');
    const codes = exitCodes();
    await runRegistryUpdate(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({
        failOn: (_c, a) =>
          a.includes('download') ? { exitCode: 1, stderr: 'connection reset mid-download' } : null,
      }),
    });
    expect(codes).toContain(1);
    // estado final consistente: versão antiga ainda instalada, venv+receipt íntegros
    const state = loadForgeState(tmp).forges['api-forge'];
    expect(state.version).toBe('0.1.0');
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(true);
    expect(existsSync(receiptPath(tmp, 'api-forge'))).toBe(true);
    expect(existsSync(`${forgeDir()}.restore-${process.pid}`)).toBe(false);
  });

  it('update com pip fail → instalação anterior restaurada (sem half-state)', async () => {
    seed('0.1.0');
    const codes = exitCodes();
    await runRegistryUpdate(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({
        failOn: (_c, a) => (a.includes('install') ? { exitCode: 1, stderr: 'boom' } : null),
      }),
    });
    expect(codes).toContain(1);
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.1.0');
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(true);
  });

  it('rollback interrompido (pip fail) → versão corrente restaurada', async () => {
    seed('0.2.0', { history: [{ version: '0.1.0', installedAt: '2026-01-01T00:00:00Z' }] });
    const codes = exitCodes();
    await runRegistryRollback(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({
        failOn: (_c, a) => (a.includes('install') ? { exitCode: 1, stderr: 'boom' } : null),
      }),
    });
    expect(codes).toContain(1);
    // 0.2.0 continua instalada — rollback não destruiu a versão corrente
    const state = loadForgeState(tmp).forges['api-forge'];
    expect(state.version).toBe('0.2.0');
    expect(state.history).toEqual([{ version: '0.1.0', installedAt: '2026-01-01T00:00:00Z' }]);
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(true);
  });

  it('rollback sem history → erro nomeado + nada muda', async () => {
    seed('0.1.0');
    const before = readFileSync(forgeStatePath(tmp), 'utf8');
    const codes = exitCodes();
    await runRegistryRollback(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
    });
    expect(codes).toContain(1);
    expect(readFileSync(forgeStatePath(tmp), 'utf8')).toBe(before);
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(true);
  });

  it('update para versão yanked → resolve ignora yanked, instalação intacta', async () => {
    seed('0.1.0');
    const yankedLatest = pypiPayload('apiforge-af', (f) =>
      f.filename.includes('0.2.0') ? { yanked: true } : {},
    );
    const codes = exitCodes();
    await runRegistryUpdate(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(yankedLatest) }),
      run: runner({}),
    });
    // 0.2.0 yanked não é instalável → "já na mais recente" → exit ≠ 1, versão intacta
    expect(codes).not.toContain(1);
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.1.0');
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(true);
  });

  it('uninstall parcial: alvo conhecido removido, desconhecido é erro nomeado', async () => {
    seed('0.1.0');
    const codes = exitCodes();
    await runRegistryUninstall(cli(), ['api-forge', 'bogus-forge'], { home: tmp });
    expect(codes).toContain(2); // desconhecido é falha nomeada — nunca silencioso
    expect(loadForgeState(tmp).forges['api-forge']).toBeUndefined();
    expect(existsSync(forgeDir())).toBe(false);
  });
});

describe('fault injection — recovery após falha', () => {
  it('retry após download interrompido instala normalmente', async () => {
    const deps = {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
    };
    const fail = await registryInstall(ENTRY, undefined, {
      ...deps,
      run: runner({
        failOn: (_c, a) =>
          a.includes('download') ? { exitCode: 1, stderr: 'connection reset' } : null,
      }),
    });
    expect(fail).toMatchObject({ stage: 'download' });
    const ok = await registryInstall(ENTRY, undefined, { ...deps, run: runner({}) });
    expect(ok).not.toHaveProperty('stage');
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.2.0');
  });

  it('retry após hash-mismatch baixa de novo e instala (.rejected não bloqueia)', async () => {
    const tamperedRun: RunLike = async (cmd, args) => {
      const di = args.indexOf('--dest');
      if (args.includes('download') && di !== -1) {
        writeFileSync(path.join(args[di + 1], WHEEL_NAME), 'tampered');
        writeFileSync(path.join(args[di + 1], WHEEL_NAME_2), 'tampered');
      }
      return { exitCode: 0 };
    };
    const fail = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: tamperedRun,
    });
    expect(fail).toMatchObject({ stage: 'hash-mismatch' });
    const ok = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
    });
    expect(ok).not.toHaveProperty('stage');
    if ('stage' in ok) return;
    expect(ok.verifiedHash).toBe(WHEEL_SHA);
  });
});

// ---------------------------------------------------------------------------
// Cenários P0 faltantes — determinísticos: fs wrapper (spy), lockfile com
// pid e subprocesso real para SIGKILL. Nunca disco real cheio nem rede real.
// ---------------------------------------------------------------------------

/** Sentinel que interrompe no primeiro process.exit — emitJson não cai. */
class ExitSentinel extends Error {}

/** JSON emitido por emitJson (stdout) — captura para asserção de contrato. */
const collectJson = async (fn: () => unknown): Promise<Record<string, unknown>> => {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: unknown) => {
    chunks.push(String(c));
    return true;
  }) as typeof origWrite;
  const spy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new ExitSentinel();
  }) as never);
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ExitSentinel)) throw e;
  } finally {
    process.stdout.write = origWrite;
    spy.mockRestore();
  }
  for (const chunk of chunks) {
    try {
      return JSON.parse(chunk) as Record<string, unknown>;
    } catch {
      // saída de UI (note/log) não é JSON — pula
    }
  }
  throw new Error('nenhum JSON emitido');
};

describe('fault injection — EACCES/ENOSPC (fs wrapper)', () => {
  it('EACCES na escrita do receipt (após pip, antes do registro) → persist + nunca saudável', async () => {
    fsFault({ needle: 'install.json', code: 'EACCES' });
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
    });
    fsFault(undefined);
    // Erro nomeado 'persist': pip instalou, o commit não aconteceu.
    expect(res).toMatchObject({ stage: 'persist' });
    expect((res as { detail?: string }).detail).toContain('EACCES');
    // A venv existe sem state/receipt — installConsistency nomeia, nunca ok.
    const c = installConsistency(tmp, 'api-forge');
    expect(c.ok).toBe(false);
    expect(c.status).toBe('orphaned');
    // `registry` (list) também a expõe — consistent:false, não "instalada".
    const doc = await collectJson(() =>
      runRegistryList(cli(), { home: tmp, names: ['api-forge'] }),
    );
    const row = (doc.forges as Record<string, unknown>[])[0];
    expect(row.consistent).toBe(false);
    expect(row.consistency).toBe('orphaned');
    expect(row.installed).toBeNull();
  });

  it('ENOSPC na escrita do state (receipt gravado) → persist + divergência detectada', async () => {
    fsFault({ needle: 'state.json', code: 'ENOSPC' });
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
    });
    fsFault(undefined);
    expect(res).toMatchObject({ stage: 'persist' });
    expect((res as { detail?: string }).detail).toContain('ENOSPC');
    // install.json ficou mas state.json não — entrada ausente no state ⇒
    // a instalação NÃO pode se apresentar como saudável.
    const c = installConsistency(tmp, 'api-forge');
    expect(c.ok).toBe(false);
    expect(loadForgeState(tmp).forges['api-forge']).toBeUndefined();
    // Reexecução (sem --clean) recusa com 'incomplete' — a saída honesta.
    const retry = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
    });
    expect(retry).toMatchObject({ stage: 'incomplete' });
    // O reparo documentado fecha o ciclo: uninstall remove a órfã.
    exitCodes();
    await runRegistryUninstall(cli(), ['api-forge'], { home: tmp });
    expect(existsSync(forgeDir())).toBe(false);
  });

  it('EACCES antes do pip (venv intocada) → falha nomeada, zero registro', async () => {
    // Permissão negada na criação do lock — nem o lifecycle começa.
    fsFault({ lockMkdir: true });
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
    });
    fsFault(undefined);
    expect(res).toMatchObject({ stage: 'busy' });
    expect((res as { detail?: string }).detail).toContain('EACCES');
    expect(existsSync(forgeDir())).toBe(false);
  });
});

describe('fault injection — concorrência (lifecycle lock)', () => {
  it('duas instalações simultâneas da mesma Forja → uma instala, outra recusa already-installed', async () => {
    const deps = {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
      lifecycleLock: { pollMs: 5, timeoutMs: 15_000 },
    };
    const [a, b] = await Promise.all([
      registryInstall(ENTRY, undefined, deps),
      registryInstall(ENTRY, undefined, deps),
    ]);
    const installed = [a, b].filter((r) => !('stage' in r));
    const refused = [a, b].filter((r) => 'stage' in r);
    expect(installed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // O perdedor re-checa sob o lock e recusa com o mesmo contrato do gate.
    expect(['already-installed', 'incomplete', 'busy']).toContain(
      (refused[0] as { stage: string }).stage,
    );
    // Estado final consistente: uma entrada, venv, receipt — lock liberado.
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.2.0');
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(true);
    expect(existsSync(receiptPath(tmp, 'api-forge'))).toBe(true);
    expect(existsSync(forgeLockDir(tmp))).toBe(false);
    expect(installConsistency(tmp, 'api-forge').ok).toBe(true);
  });

  it('lock ocupado por titular vivo → recusa nomeada busy (não espera nem corrompe)', async () => {
    const held = await acquireForgeLock(tmp, { pollMs: 5 });
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    try {
      const res = await registryInstall(ENTRY, undefined, {
        home: tmp,
        cacheDir: cacheDir(),
        pythons: py(),
        fetchImpl: fetchOk,
        run: runner({}),
        lifecycleLock: { timeoutMs: 50, pollMs: 5 },
      });
      expect(res).toMatchObject({ stage: 'busy' });
      expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(false);
      expect(existsSync(forgeLockDir(tmp))).toBe(true); // lock do titular intacto
    } finally {
      held.lock.release();
    }
  });

  it('lock órfão de pid morto → quebra documentada e aquisição imediata', async () => {
    // Titular simulado: lock dir + info com pid que não existe mais.
    const dir = forgeLockDir(tmp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'info.json'),
      JSON.stringify({ pid: 424_242, at: '2026-01-01T00:00:00Z' }),
    );
    const res = await acquireForgeLock(tmp, { pidAlive: () => false, pollMs: 5 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      res.lock.release();
      expect(existsSync(dir)).toBe(false);
    }
  });
});

describe('fault injection — SIGKILL real no meio da escrita', () => {
  it('processo morto segurando lock + tmp órfão → próximo run recupera e limpa', async () => {
    const lockDir = forgeLockDir(tmp);
    const info = path.join(lockDir, 'info.json');
    const orphan = path.join(forgesRoot(tmp), `state.json.${process.pid}-dead.${Date.now()}.tmp`);
    // Subprocesso real: cria o lock (pid dele), grava um tmp parcial e
    // fica vivo — o SIGKILL do pai mata ANTES de qualquer rename.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('fs');
         fs.mkdirSync(process.argv[1],{recursive:true});
         fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
         fs.writeFileSync(process.argv[3],'{"forges":{"x":');
         setInterval(()=>{},1000);`,
        lockDir,
        info,
        orphan,
      ],
      { stdio: 'ignore' },
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(info) || !existsSync(orphan)) {
      if (Date.now() > deadline) throw new Error('child nunca gravou os artefatos');
      await new Promise((r) => setTimeout(r, 10));
    }
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));

    // 1) Lock órfão de pid morto é recuperável imediatamente.
    const got = await acquireForgeLock(tmp, { timeoutMs: 5_000, pollMs: 10 });
    expect(got.ok).toBe(true);
    if (got.ok) got.lock.release();

    // 2) Instalação seguinte funciona e o *.tmp órfão é varrido na escrita.
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
    });
    expect(res).not.toHaveProperty('stage');
    const leftovers = readdirSync(forgesRoot(tmp)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    // 3) State final é válido — a metade escrita pelo processo morto não vaza.
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.2.0');
    expect(installConsistency(tmp, 'api-forge').ok).toBe(true);
    expect(existsSync(forgeLockDir(tmp))).toBe(false);
  });
});

describe('fault injection — commit boundary: nunca saudável pela metade', () => {
  it('receipt divergente do state (kill entre as duas escritas) → version-mismatch, nunca ok', async () => {
    seed('0.2.0', {
      history: [{ version: '0.1.0', installedAt: '2026-01-01T00:00:00Z' }],
    });
    // Simula o rollback morto entre install.json e state.json:
    // receipt já regressou para 0.1.0, state ainda diz 0.2.0.
    const receipt = JSON.parse(readFileSync(receiptPath(tmp, 'api-forge'), 'utf8'));
    receipt.version = '0.1.0';
    writeFileSync(receiptPath(tmp, 'api-forge'), `${JSON.stringify(receipt, null, 2)}\n`);
    const c = installConsistency(tmp, 'api-forge');
    expect(c.ok).toBe(false);
    expect(c.status).toBe('version-mismatch');
    // `registry` (list) expõe a divergência — consistent:false, nunca "ok".
    const doc = await collectJson(() =>
      runRegistryList(cli(), { home: tmp, names: ['api-forge'] }),
    );
    const row = (doc.forges as Record<string, unknown>[])[0];
    expect(row.consistent).toBe(false);
    expect(row.consistency).toBe('version-mismatch');
    // Reparo documentado fecha o ciclo: reinstall --clean regrava o par.
    const fixed = await registryInstall(ENTRY, '0.1.0', {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
      clean: true,
    });
    expect(fixed).not.toHaveProperty('stage');
    expect(installConsistency(tmp, 'api-forge').ok).toBe(true);
  });

  it('uninstall parcial (receipt removido, venv+state intactos) → missing-receipt + retry documentado', async () => {
    seed('0.1.0');
    rmSync(receiptPath(tmp, 'api-forge'));
    const c = installConsistency(tmp, 'api-forge');
    expect(c.ok).toBe(false);
    expect(c.status).toBe('missing-receipt');
    // Install sem --clean recusa honesto — 'incomplete', não 'already-installed'.
    const retry = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
    });
    expect(retry).toMatchObject({ stage: 'incomplete' });
    // Reparo 1: uninstall termina a remoção parcial (state+venv saem).
    exitCodes();
    await runRegistryUninstall(cli(), ['api-forge'], { home: tmp });
    expect(existsSync(forgeDir())).toBe(false);
    expect(loadForgeState(tmp).forges['api-forge']).toBeUndefined();
    // Reparo 2: install novo fecha consistente.
    const ok = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
    });
    expect(ok).not.toHaveProperty('stage');
    expect(installConsistency(tmp, 'api-forge').ok).toBe(true);
  });

  it('state apagado com venv+receipt presentes → orphaned, nunca saudável', async () => {
    seed('0.1.0');
    rmSync(forgeStatePath(tmp));
    const c = installConsistency(tmp, 'api-forge');
    expect(c.ok).toBe(false);
    expect(c.status).toBe('orphaned');
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: fetchOk,
      run: runner({}),
    });
    expect(res).toMatchObject({ stage: 'incomplete' });
  });
});

describe('fault injection — yanked release (honest, nunca silencioso)', () => {
  it('update para alvo todo-yanked → recusa, instalação intacta e receipt honesto', async () => {
    seed('0.1.0');
    const allYanked = pypiPayload('apiforge-af', () => ({ yanked: true }));
    const codes = exitCodes();
    await runRegistryUpdate(cli(), ['api-forge'], {
      home: tmp,
      pythons: py(),
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(allYanked) }),
      run: runner({}),
    });
    expect(codes).toContain(1); // recusa nomeada — não "up to date" nem silêncio
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.1.0');
  });

  it('pin de versão yanked instala MAS marca receipt + plano (nunca silencioso)', async () => {
    const yanked = pypiPayload('apiforge-af', () => ({ yanked: true }));
    // Plano expõe yanked:true — o efeito é visível ANTES de instalar.
    const doc = await collectJson(() =>
      runRegistryInstall(cli({ plan: true, ref: '0.1.0' }), ['api-forge'], {
        home: tmp,
        pythons: py(),
        fetchImpl: async () => ({ status: 200, body: JSON.stringify(yanked) }),
        run: runner({}),
      }),
    );
    expect((doc.planned as { yanked?: boolean }[])[0].yanked).toBe(true);
    // Execução: receipt carrega a evidência (yanked:true) — nada oculto.
    const res = await registryInstall(ENTRY, '0.1.0', {
      home: tmp,
      cacheDir: cacheDir(),
      pythons: py(),
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(yanked) }),
      run: runner({}),
    });
    expect(res).not.toHaveProperty('stage');
    if ('stage' in res) return;
    expect(res.yanked).toBe(true);
    expect(loadForgeState(tmp).forges['api-forge'].yanked).toBe(true);
  });
});
