import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registryEntry } from '../src/registry/catalog.js';
import {
  extrasSuffix,
  forgeVenv,
  forgesRoot,
  ghostEntry,
  wheelCacheDir,
  wheelCacheForHome,
  loadForgeState,
  pipSpec,
  receiptPath,
  registryInstall,
  registryUninstall,
  type RegistryInstallReceipt,
  type RunLike,
  type RunResult,
} from '../src/registry/install.js';
import type { FetchLike } from '../src/registry/pypi.js';
import { emitForgeShim } from '../src/registry/shims.js';
import { parseVersion } from '../src/registry/versions.js';

let tmp: string;
beforeEach(() => (tmp = mkdtempSync(path.join(os.tmpdir(), 'reg-inst-'))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

// Conteúdo fake da wheel; o digest do PyPI é o sha256 real do conteúdo
// (o install agora instala pelo caminho verificado — o arquivo precisa existir).
const WHEEL_BYTES = 'fake-wheel-bytes';
const WHEEL_SHA = createHash('sha256').update(WHEEL_BYTES).digest('hex');
const WHEEL_NAME = 'apiforge_af-0.1.0-py3-none-any.whl';

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
  },
};
const fetchOk: FetchLike = async () => ({ status: 200, body: JSON.stringify(PYPI) });
const py = (v: string) => ({ exe: ['python3'], version: v, parsed: parseVersion(v)! });

const ENTRY = registryEntry('api-forge')!;

function runOk(calls: string[][]): RunLike {
  return runWith(calls, async () => ({ exitCode: 0, stdout: 'ok' }));
}

/** Runner que grava a wheel fake no `pip download` e delega o resto. */
function runWith(
  calls: string[][],
  handler: (cmd: string, args: string[]) => Promise<RunResult> | RunResult,
): RunLike {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    // `pip download --dest <dir>` → grava a wheel fake como pip faria
    const di = args.indexOf('--dest');
    if (args.includes('download') && di !== -1) {
      writeFileSync(path.join(args[di + 1], WHEEL_NAME), WHEEL_BYTES);
    }
    return handler(cmd, args);
  };
}

describe('registryInstall', () => {
  it('cria venv, instala pinado, verifica e grava receipt + state', async () => {
    const calls: string[][] = [];
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'cache'),
      pythons: [py('3.12.4')],
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
    expect(calls[1]).toContain('download');
    expect(calls[1]).toContain('--no-input');
    // api-forge declara extras:['mcp'] — o pedido é o spec PEP 508 completo
    expect(calls[1].slice(-1)).toEqual(['apiforge-af[mcp]==0.1.0']);
    expect(calls[2]).toContain('install');
    expect(calls[2]).toContain('--no-input');
    expect(calls[2].at(-1)).toMatch(/apiforge_af-0\.1\.0-py3-none-any\.whl\[mcp\]$/);
    // online o índice resolve as deps — wheel cache não compete (--find-links só offline)
    expect(calls[2]).not.toContain('--find-links');
    expect(calls[2]).not.toContain('--no-index');
    expect(calls[3][0]).toBe(res.bin);
    expect(calls[3][1]).toBe('--help');

    const receipt = JSON.parse(readFileSync(receiptPath(tmp, 'api-forge'), 'utf8'));
    expect(receipt.version).toBe('0.1.0');
    expect(receipt.files[0].sha256).toBe(WHEEL_SHA);
    // provenance: via de resolução + artefato + URL publicada no índice
    expect(receipt.provenance).toEqual({
      registry: 'pypi.org',
      file: WHEEL_NAME,
      url: 'https://f/apiforge_af-0.1.0.whl',
      resolvedVia: 'pypi',
    });
    const state = loadForgeState(tmp);
    expect(state.forges['api-forge'].dist).toBe('apiforge-af');
    // state dir é privado (POSIX) — chmod 0700, ignorado no Windows
    if (process.platform !== 'win32') {
      const mode = statSync(forgesRoot(tmp)).mode & 0o777;
      expect(mode).toBe(0o700);
    }
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
      info: { requires_python: '>=3.13' },
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
      pythons: [py('3.12.4')],
      run: runWith([], async (_c, args) =>
        args.includes('install')
          ? { exitCode: 1, stderr: 'ResolutionImpossible' }
          : { exitCode: 0 },
      ),
      fetchImpl: fetchOk,
    });
    expect(res).toMatchObject({ stage: 'pip' });
  });

  it('verify falha → stage verify mas receipt já gravado (auditoria)', async () => {
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.12.4')],
      run: runWith([], async (cmd) =>
        cmd.endsWith('/bin/apiforge') || cmd.endsWith('apiforge.exe')
          ? { exitCode: 2 }
          : { exitCode: 0 },
      ),
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

describe('segurança e edge cases do install', () => {
  const base = () => ({
    home: tmp,
    cacheDir: path.join(tmp, 'c'),
    pythons: [py('3.12.4')],
    fetchImpl: fetchOk,
  });

  it('offline sem artefato em cache → offline-missing-artifact + venv removida', async () => {
    const metaDir = path.join(tmp, 'c');
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(
      path.join(metaDir, 'apiforge-af.json'),
      JSON.stringify({ fetchedAt: Date.now(), payload: PYPI }),
    );
    const res = await registryInstall(ENTRY, undefined, {
      ...base(),
      offline: true,
      run: async () => ({ exitCode: 0 }),
    });
    expect(res).toMatchObject({ stage: 'offline-missing-artifact' });
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(false);
  });

  it('offline com artefato → pip recebe --no-index --find-links', async () => {
    const wheels = wheelCacheDir(path.join(tmp, 'c'), 'apiforge-af');
    mkdirSync(wheels, { recursive: true });
    writeFileSync(path.join(wheels, 'apiforge_af-0.1.0-py3-none-any.whl'), 'wb');
    // resolve offline exige metadata cache também — digest real do artefato
    const realHash = createHash('sha256').update('wb').digest('hex');
    const pypi = structuredClone(PYPI);
    pypi.releases['0.1.0'][0].digests.sha256 = realHash;
    const metaDir = path.join(tmp, 'c');
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(
      path.join(metaDir, 'apiforge-af.json'),
      JSON.stringify({ fetchedAt: Date.now(), payload: pypi }),
    );
    const calls: string[][] = [];
    const res = await registryInstall(ENTRY, undefined, {
      ...base(),
      offline: true,
      run: runOk(calls),
    });
    if ('stage' in res) throw new Error(`unexpected: ${JSON.stringify(res)}`);
    const pipArgs = calls.find((c) => c.includes('install'))!;
    expect(pipArgs).toContain('--no-index');
    expect(pipArgs).toContain('--find-links');
  });

  it('offline com artefato adulterado → hash-mismatch (cache verificado também)', async () => {
    const wheels = wheelCacheDir(path.join(tmp, 'c'), 'apiforge-af');
    mkdirSync(wheels, { recursive: true });
    writeFileSync(path.join(wheels, 'apiforge_af-0.1.0-py3-none-any.whl'), 'tampered');
    mkdirSync(path.join(tmp, 'c'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'c', 'apiforge-af.json'),
      JSON.stringify({ fetchedAt: Date.now(), payload: PYPI }),
    );
    const res = await registryInstall(ENTRY, undefined, {
      ...base(),
      offline: true,
      run: async () => ({ exitCode: 0 }),
    });
    expect(res).toMatchObject({ stage: 'hash-mismatch' });
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(false);
  });

  it('prefere interpretador estável sobre pré-release quando ambos satisfazem', async () => {
    const calls: string[][] = [];
    const res = await registryInstall(ENTRY, undefined, {
      ...base(),
      pythons: [py('3.14.0a1'), py('3.12.4')],
      run: runOk(calls),
    });
    expect(res).not.toHaveProperty('stage');
    if ('stage' in res) return;
    expect(res.python).toBe('3.12.4');
    expect(calls[0][0]).toBe('python3');
  });

  it('--clean remove venv e state existentes antes de instalar', async () => {
    mkdirSync(path.join(forgeVenv(tmp, 'api-forge'), 'stale'), { recursive: true });
    const res = await registryInstall(ENTRY, undefined, {
      ...base(),
      clean: true,
      run: runOk([]),
    });
    expect(res).not.toHaveProperty('stage');
    expect(existsSync(path.join(forgeVenv(tmp, 'api-forge'), 'stale'))).toBe(false);
  });

  it('--clean + falha posterior → instalação anterior restaurada (backup/restore)', async () => {
    // instalação prévia bem-sucedida grava state
    const ok = await registryInstall(ENTRY, undefined, { ...base(), run: runOk([]) });
    expect(ok).not.toHaveProperty('stage');
    expect(loadForgeState(tmp).forges['api-forge']).toBeTruthy();
    // --clean preserva a instalação anterior até a nova estar pronta:
    // pip falha depois → venv+receipt antigos voltam, state não aponta órfã.
    const res = await registryInstall(ENTRY, undefined, {
      ...base(),
      clean: true,
      run: runWith([], async (_c, args) =>
        args.includes('install') ? { exitCode: 9, stderr: 'pip falhou' } : { exitCode: 0 },
      ),
    });
    expect(res).toMatchObject({ stage: 'pip' });
    expect(loadForgeState(tmp).forges['api-forge']?.version).toBe('0.1.0');
    // dir da Forja restaurado com o receipt anterior — nada de half-state
    expect(existsSync(receiptPath(tmp, 'api-forge'))).toBe(true);
    expect(
      existsSync(`${path.join(tmp, '.forge-cli', 'forges', 'api-forge')}.restore-${process.pid}`),
    ).toBe(false);
  });

  it('sha256 divergente → hash-mismatch + venv removida', async () => {
    const wheels = wheelCacheDir(path.join(tmp, 'c'), 'apiforge-af');
    mkdirSync(wheels, { recursive: true });
    writeFileSync(path.join(wheels, 'apiforge_af-0.1.0-py3-none-any.whl'), 'tampered');
    const res = await registryInstall(ENTRY, undefined, {
      ...base(),
      run: async () => ({ exitCode: 0 }),
    });
    expect(res).toMatchObject({ stage: 'hash-mismatch' });
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(false);
  });

  it('sha256 correto → verifiedHash gravado no receipt', async () => {
    const wheels = wheelCacheDir(path.join(tmp, 'c'), 'apiforge-af');
    mkdirSync(wheels, { recursive: true });
    const content = 'real-wheel-bytes';
    writeFileSync(path.join(wheels, 'apiforge_af-0.1.0-py3-none-any.whl'), content);
    const sha = createHash('sha256').update(content).digest('hex');
    const payload = JSON.parse(JSON.stringify(PYPI));
    payload.releases['0.1.0'][0].digests.sha256 = sha;
    const res = await registryInstall(ENTRY, undefined, {
      ...base(),
      run: async () => ({ exitCode: 0 }),
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(payload) }),
    });
    if ('stage' in res) throw new Error(`unexpected: ${JSON.stringify(res)}`);
    expect(res.verifiedHash).toBe(sha);
  });

  it('falha no pip → venv órfã removida', async () => {
    const res = await registryInstall(ENTRY, undefined, {
      ...base(),
      run: runWith([], async (_c, args) =>
        args.includes('install') ? { exitCode: 1, stderr: 'x' } : { exitCode: 0 },
      ),
    });
    expect(res).toMatchObject({ stage: 'pip' });
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(false);
    // sem dir órfão da Forja — venv era o único conteúdo desta tentativa
    expect(existsSync(path.join(tmp, '.forge-cli', 'forges', 'api-forge'))).toBe(false);
  });

  it('specifier fora do subconjunto → specifier-unknown, não incompatible', async () => {
    const payload = {
      info: { requires_python: '===3.12' },
      releases: PYPI.releases,
    };
    const res = await registryInstall(ENTRY, undefined, {
      ...base(),
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(payload) }),
    });
    expect(res).toMatchObject({ stage: 'resolve', error: { kind: 'specifier-unknown' } });
  });

  it('pin "toString" → version-not-found (membership é own-property)', async () => {
    const res = await registryInstall(ENTRY, 'toString', {
      ...base(),
      run: runOk([]),
    });
    expect(res).toMatchObject({ stage: 'resolve', error: { kind: 'version-not-found' } });
  });

  it('reinstall sem --clean recusa — nunca destrói venv boa', async () => {
    const first = await registryInstall(ENTRY, undefined, { ...base(), run: runOk([]) });
    expect(first).not.toHaveProperty('stage');
    // o mock não cria a venv de verdade — simula o estado pós-install real
    mkdirSync(forgeVenv(tmp, 'api-forge'), { recursive: true });
    const second = await registryInstall(ENTRY, undefined, { ...base(), run: runOk([]) });
    expect(second).toMatchObject({ stage: 'already-installed' });
    expect(loadForgeState(tmp).forges['api-forge'].version).toBe('0.1.0');
    expect(existsSync(forgeVenv(tmp, 'api-forge'))).toBe(true);
  });

  it('artefato plantado no cache (fora dos metadados) nunca é escolhido', async () => {
    const calls: string[][] = [];
    const res = await registryInstall(ENTRY, undefined, {
      ...base(),
      run: runWith(calls, async (_c, args) => {
        const di = args.indexOf('--dest');
        if (args.includes('download') && di !== -1) {
          // simula arquivo plantado no destino além da wheel legítima
          writeFileSync(
            path.join(args[di + 1], 'apiforge_af-0.1.0-cp312-cp312-linux_x86_64.whl'),
            'evil',
          );
        }
        return { exitCode: 0 };
      }),
    });
    expect(res).not.toHaveProperty('stage');
    const pipCall = calls.find((c) => c.includes('install'))!;
    // instala pelo caminho da wheel verificada — nunca pelo nome/spec
    // ([mcp] é o sufixo de extras, não resolução por nome)
    expect(pipCall.at(-1)).toMatch(/apiforge_af-0\.1\.0-py3-none-any\.whl\[mcp\]$/);
    expect(pipCall.at(-1)).not.toContain('cp312');
  });

  it('release toda yanked: pin explícito instala e marca receipt', async () => {
    const payload = {
      info: { requires_python: '>=3.10' },
      releases: {
        '0.1.0': [
          {
            filename: WHEEL_NAME,
            url: 'https://f/x.whl',
            digests: { sha256: WHEEL_SHA },
            packagetype: 'bdist_wheel',
            yanked: true,
          },
        ],
      },
    };
    const res = await registryInstall(ENTRY, '0.1.0', {
      ...base(),
      run: runOk([]),
      fetchImpl: async () => ({ status: 200, body: JSON.stringify(payload) }),
    });
    if ('stage' in res) throw new Error(`unexpected: ${JSON.stringify(res)}`);
    expect(res.yanked).toBe(true);
  });
});

// E2E 11.2.1: `sparkforge-aws` instalado sem `[mcp]` deixou o servidor
// MCP sem dependências. O pedido é `dist[extra]==v`; receipt/state/dist
// continuam com o nome limpo da distribuição.
describe('extras PEP 508 — [mcp] no pedido, dist limpa na identidade', () => {
  const receiptStub = (over: Partial<RegistryInstallReceipt>): RegistryInstallReceipt => ({
    forge: 'ghost-x',
    method: 'pypi',
    dist: 'apiforge-af',
    version: '0.1.0',
    python: '3.12.4',
    source: 'latest-stable',
    venv: '/v',
    bin: '/v/bin/apiforge',
    installedAt: 'x',
    verify: { command: [], ok: true },
    files: [],
    ...over,
  });

  it('pipSpec/extrasSuffix montam o requerimento; entry sem extras → sufixo vazio', () => {
    expect(pipSpec(ENTRY, '0.1.0')).toBe('apiforge-af[mcp]==0.1.0');
    const bare = { ...ENTRY, extras: undefined };
    expect(extrasSuffix(bare)).toBe('');
    expect(pipSpec(bare, '0.1.0')).toBe('apiforge-af==0.1.0');
    // dedup + ordenação — contrato estável para spec e lock
    expect(pipSpec({ ...ENTRY, extras: ['mcp', 'mcp', 'a'] }, '1')).toBe('apiforge-af[a,mcp]==1');
  });

  it('catálogo: só extras verificados no pyproject do sibling', () => {
    for (const name of [
      'api-forge',
      'platform-forge',
      'spark-forge-aws',
      'spark-forge-azure',
      'forge-doctor-api',
    ]) {
      expect(registryEntry(name)!.extras).toEqual(['mcp']);
    }
    // forge-doctor-data tem servidor MCP mas NÃO declara extra `mcp` no
    // pyproject (watch/lsp/schemas/sql) — extra nunca é inventado de `mcp`.
    expect(registryEntry('forge-doctor-data')!.extras).toBeUndefined();
    expect(registryEntry('the-forge')!.extras).toBeUndefined();
  });

  it('install grava extras no receipt e mantém dist/forge limpos', async () => {
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.12.4')],
      run: runOk([]),
      fetchImpl: fetchOk,
    });
    if ('stage' in res) throw new Error(`unexpected: ${JSON.stringify(res)}`);
    expect(res.extras).toEqual(['mcp']);
    expect(res.dist).toBe('apiforge-af'); // identidade nunca é dist[extra]
    const receipt = JSON.parse(readFileSync(receiptPath(tmp, 'api-forge'), 'utf8'));
    expect(receipt.extras).toEqual(['mcp']);
    expect(receipt.dist).toBe('apiforge-af');
    const state = loadForgeState(tmp);
    expect(state.forges['api-forge'].extras).toEqual(['mcp']);
    expect(state.forges['api-forge'].dist).toBe('apiforge-af');
  });

  it('offline pede o caminho[mcp] — deps do extra resolvem no --find-links', async () => {
    const wheels = wheelCacheDir(path.join(tmp, 'c'), 'apiforge-af');
    mkdirSync(wheels, { recursive: true });
    writeFileSync(path.join(wheels, WHEEL_NAME), WHEEL_BYTES);
    mkdirSync(path.join(tmp, 'c'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'c', 'apiforge-af.json'),
      JSON.stringify({ fetchedAt: Date.now(), payload: PYPI }),
    );
    const calls: string[][] = [];
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      offline: true,
      pythons: [py('3.12.4')],
      run: runOk(calls),
    });
    if ('stage' in res) throw new Error(`unexpected: ${JSON.stringify(res)}`);
    const pipCall = calls.find((c) => c.includes('install'))!;
    expect(pipCall).toContain('--no-index');
    expect(pipCall).toContain('--find-links');
    expect(pipCall.at(-1)).toMatch(/apiforge_af-0\.1\.0-py3-none-any\.whl\[mcp\]$/);
  });

  it('ghostEntry propaga extras do receipt — lifecycle do ghost pede dist[mcp]', () => {
    expect(ghostEntry('ghost-x', receiptStub({ extras: ['mcp'] })).extras).toEqual(['mcp']);
    expect(ghostEntry('ghost-x', receiptStub({})).extras).toBeUndefined();
  });
});

describe('catálogo — pisos reais publicados', () => {
  // Fonte de verdade: requires_python publicado no PyPI (consultado 2026-10-17).
  // minPython é só o fallback offline — não pode ficar abaixo do real.
  it.each([
    ['the-forge', '3.11'],
    ['api-forge', '3.12'],
    ['platform-forge', '3.10'],
    ['spark-forge-aws', '3.10'],
    ['spark-forge-azure', '3.10'],
    ['forge-doctor-data', '3.11'],
    ['forge-doctor-api', '3.11'],
  ])('%s declara piso %s', (name, min) => {
    expect(registryEntry(name)?.minPython).toBe(min);
    expect(registryEntry(name)?.dist).toBeTruthy();
  });
});

describe('registryUninstall', () => {
  it('remove dir + receipt e atualiza state', async () => {
    const calls: string[][] = [];
    await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.12.4')],
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

  it('remove também o wheel cache da dist (reclaim de disco)', () => {
    const wheels = wheelCacheForHome(tmp, 'apiforge-af');
    mkdirSync(wheels, { recursive: true });
    writeFileSync(path.join(wheels, 'x.whl'), 'w');
    const res = registryUninstall({ name: 'api-forge', dist: 'apiforge-af' }, { home: tmp });
    expect(res.cacheRemoved).toBe(true);
    expect(existsSync(wheels)).toBe(false);
  });

  it('idempotente quando não instalado', () => {
    const res = registryUninstall(ENTRY, { home: tmp });
    expect(res.removed).toBe(false);
    expect(res.receiptRemoved).toBe(false);
  });

  it('nome com path traversal é recusado — nada é deletado', () => {
    const sentinel = path.join(tmp, 'fora-do-forges');
    mkdirSync(sentinel, { recursive: true });
    writeFileSync(path.join(sentinel, 'keep.txt'), 'não apague');
    const res = registryUninstall({ name: '../../fora-do-forges' }, { home: tmp });
    expect(res.refused).toBe('unsafe-name');
    expect(res.removed).toBe(false);
    expect(existsSync(path.join(sentinel, 'keep.txt'))).toBe(true);
  });

  it('dist maliciosa no receipt não apaga nada fora do wheel cache', () => {
    // Forja "ghost" (fora do catálogo) com receipt envenenado:
    // `dist: ../../<escape>` — o rmSync do wheel cache não pode escapar.
    const forgeDir = path.join(tmp, '.forge-cli', 'forges', 'ghost-forge');
    mkdirSync(forgeDir, { recursive: true });
    const escape = path.join(tmp, 'escape');
    mkdirSync(escape, { recursive: true });
    writeFileSync(path.join(escape, 'keep.txt'), 'não apague');
    const res = registryUninstall({ name: 'ghost-forge', dist: '../../escape' }, { home: tmp });
    expect(res.refused).toBeUndefined();
    expect(res.removed).toBe(true);
    expect(res.cacheRemoved).toBe(false);
    expect(existsSync(path.join(escape, 'keep.txt'))).toBe(true);
    expect(existsSync(forgeDir)).toBe(false);
  });
});

describe('review-11 — hardening', () => {
  it('state com forges:[] (array) é tratado como vazio', () => {
    const stateDir = path.join(tmp, '.forge-cli', 'forges');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'state.json'), '{"forges": []}');
    expect(loadForgeState(tmp).forges).toEqual({});
  });

  it('hash-mismatch coloca o artefato em quarentena (.rejected)', async () => {
    const calls: string[][] = [];
    const tamperRun: RunLike = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const di = args.indexOf('--dest');
      if (args.includes('download') && di !== -1) {
        writeFileSync(path.join(args[di + 1], WHEEL_NAME), 'tampered-bytes');
      }
      return { exitCode: 0, stdout: 'ok' };
    };
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.12.4')],
      run: tamperRun,
      fetchImpl: fetchOk,
    });
    if ('stage' in res && res.stage === 'hash-mismatch') {
      const wheels = wheelCacheDir(path.join(tmp, 'c'), 'apiforge-af');
      expect(res.detail).toContain('.rejected');
      expect(existsSync(path.join(wheels, `${WHEEL_NAME}.rejected`))).toBe(true);
      expect(existsSync(path.join(wheels, WHEEL_NAME))).toBe(false);
      return;
    }
    throw new Error('esperava hash-mismatch');
  });

  it('piso do catálogo compõe com requires_python (max implícito)', async () => {
    // Release declara >=3.9 (mais permissivo que minPython 3.12 do
    // catálogo): requires_python é autoritativo SOBRE o release, mas o
    // piso é o mínimo suportado pela forge-cli — 3.9 não é habilitado.
    const payload = {
      info: { requires_python: '>=3.9' },
      releases: PYPI.releases,
    };
    const fetch = async () => ({ status: 200, body: JSON.stringify(payload) });
    const low = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.9.9')],
      run: runOk([]),
      fetchImpl: fetch,
    });
    expect(low).toMatchObject({ stage: 'resolve' });
    // e um interpretador dentro das duas restrições instala normalmente
    const ok = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c2'),
      pythons: [py('3.13.1')],
      run: runOk([]),
      fetchImpl: fetch,
    });
    expect(ok).not.toHaveProperty('stage');
  });

  it('venv existente recusa ANTES da resolução (fail fast offline)', async () => {
    mkdirSync(forgeVenv(tmp, 'api-forge'), { recursive: true });
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.12.4')],
      run: runOk([]),
      // fetch que estouraria 'network' se a resolução acontecesse
      fetchImpl: async () => {
        throw new Error('sem rede');
      },
    });
    // Venv sem state/receipt = instalação interrompida — a recusa nomeia
    // 'incomplete' (com o reparo), nunca finge 'already-installed'.
    expect(res).toMatchObject({ stage: 'incomplete' });
  });
});

describe('launchers (~/.forge-cli/bin)', () => {
  it('install emite shim POSIX apontando para o bin da venv', async () => {
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.12.4')],
      run: runOk([]),
      fetchImpl: fetchOk,
      platform: 'linux',
    });
    expect(res).not.toHaveProperty('stage');
    if ('stage' in res) return;
    expect(res.shim).toBe(path.join(tmp, '.forge-cli', 'bin', 'apiforge'));
    const body = readFileSync(res.shim!, 'utf8');
    // o shim escapa `\`, `"`, `$`, backtick dentro das aspas — a asserção
    // replica o escape do shQuote (Windows CI passa um path com `\`)
    expect(body).toContain(`exec "${res.bin.replace(/(["\\$`])/g, '\\$1')}"`);
    // bits POSIX não existem no fs do host Windows — só asseríveis em POSIX real
    if (process.platform !== 'win32') {
      expect(statSync(res.shim!).mode & 0o111).not.toBe(0);
    }
    // shim gravado no state.json — lifecycle lê de lá
    expect(loadForgeState(tmp).forges['api-forge'].shim).toBe(res.shim);
  });

  it('install emite shim .cmd no Windows', async () => {
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.12.4')],
      run: runOk([]),
      fetchImpl: fetchOk,
      platform: 'win32',
    });
    expect(res).not.toHaveProperty('stage');
    if ('stage' in res) return;
    expect(res.shim).toBe(path.join(tmp, '.forge-cli', 'bin', 'apiforge.cmd'));
    expect(readFileSync(res.shim!, 'utf8')).toBe(`@echo off\r\n"${res.bin}" %*\r\n`);
  });

  it('uninstall remove o shim junto da venv', async () => {
    const res = await registryInstall(ENTRY, undefined, {
      home: tmp,
      cacheDir: path.join(tmp, 'c'),
      pythons: [py('3.12.4')],
      run: runOk([]),
      fetchImpl: fetchOk,
      platform: 'linux',
    });
    if ('stage' in res) throw new Error('setup falhou');
    expect(existsSync(res.shim!)).toBe(true);
    const out = registryUninstall({ name: 'api-forge' }, { home: tmp, platform: 'linux' });
    expect(out.shimRemoved).toBe(true);
    expect(existsSync(res.shim!)).toBe(false);
  });

  it('shim POSIX escapa aspas/$ no caminho do bin', () => {
    const bin = path.join(tmp, 'we"ird$dir', 'apiforge');
    const shim = emitForgeShim(tmp, bin, 'linux');
    const body = readFileSync(shim, 'utf8');
    const escaped = bin.replace(/(["\\$`])/g, '\\$1');
    expect(body).toContain(`exec "${escaped}" "$@"`);
    expect(body).not.toContain(`exec "${bin}"`);
  });

  it('shim .cmd recusa bin com aspas/newline', () => {
    // `"` corromperia o .cmd — nunca pode virar shim (recusa em qualquer camada)
    expect(() => emitForgeShim(tmp, 'C:\\ba"d\\cli.exe', 'win32')).toThrow();
    expect(() => emitForgeShim(tmp, 'C:\\ok\\cli.exe\n', 'win32')).toThrow();
    const dir = path.join(tmp, '.forge-cli', 'bin');
    expect(existsSync(dir) ? readdirSync(dir) : []).not.toContainEqual(
      expect.stringMatching(/cli\.cmd/),
    );
  });
});
