/**
 * lf-0017 — pipeline universal de descoberta Python. Tudo hermético:
 * `run`/`exists`/`readdir`/`realpath`/`env` injetados — nenhum probe
 * toca o host real. Cobre estágios, precedência explícita, vereditos,
 * piso, seleção e dedup determinístico.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PYTHON_FLOOR,
  PYTHON_DISCOVERY_MAX_CANDIDATES,
  PYTHON_PROBE_TIMEOUT_MS,
  discoverPythons,
  normalizePythonFloor,
  type PythonDeps,
} from '../src/env/python.js';
import type { ProbeOutcome, ProbeRun } from '../src/env/shells.js';
import { receiptPythonInfo } from '../src/registry/install.js';

const ok = (output: string): ProbeOutcome => ({ ok: true, output, timed_out: false });
const fail = (output = ''): ProbeOutcome => ({ ok: false, output, timed_out: false });
const timeout = (): ProbeOutcome => ({ ok: false, output: null, timed_out: true });

/**
 * Mapa `cmd args…` → outcome. `command -v <nome>`/`where.exe <nome>`
 * resolvem olhando `pathMap` — nomes não mapeados saem absent.
 */
function fakeRun(pathMap: Record<string, string>, probes: Record<string, ProbeOutcome>): ProbeRun {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (probes[key]) return probes[key];
    if (cmd === 'sh' && /^command -v \S+$/.test(args[1] ?? '')) {
      const name = (args[1] as string).replace('command -v ', '');
      return pathMap[name] ? ok(pathMap[name]) : fail();
    }
    if (cmd === 'where.exe') {
      return pathMap[args[0] ?? ''] ? ok(pathMap[args[0] as string]) : fail();
    }
    if (cmd === 'reg.exe') return fail();
    return fail();
  };
}

/** exists/readdir controlados por conjuntos — nada toca o fs real. */
function fakeFs(files: string[], dirs: Record<string, string[]> = {}) {
  const fileSet = new Set(files);
  return {
    exists: (t: string) => fileSet.has(t),
    readdir: (d: string) => dirs[d] ?? [],
    realpath: (t: string) => t,
  };
}

const baseDeps = (over: Partial<PythonDeps> = {}): PythonDeps => ({
  platform: 'linux',
  env: {},
  osHome: '/home/x',
  targetDir: '/ws',
  cwd: '/ws',
  ...over,
});

describe('constantes e piso', () => {
  it('probe nunca passa de 5 s e o teto de candidatos é finito', () => {
    expect(PYTHON_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(PYTHON_DISCOVERY_MAX_CANDIDATES).toBeGreaterThan(0);
    expect(DEFAULT_PYTHON_FLOOR).toBe('>=3.10');
  });

  it('normalizePythonFloor: vazio → default, versão nua vira >=, spec passa', () => {
    expect(normalizePythonFloor(undefined)).toBe('>=3.10');
    expect(normalizePythonFloor('3.11')).toBe('>=3.11');
    expect(normalizePythonFloor('>=3.11,<3.13')).toBe('>=3.11,<3.13');
  });
});

describe('seleção explícita (estágios 0 e 1)', () => {
  it('FORGE_PYTHON vence a descoberta automática mesmo com versão menor', async () => {
    const fs = fakeFs(['/opt/py313/bin/python3.13']);
    const run = fakeRun(
      { python3: '/usr/bin/python3' },
      {
        '/opt/py313/bin/python3.13 --version': ok('Python 3.13.5'),
        'python3 --version': ok('Python 3.14.0'),
      },
    );
    const d = await discoverPythons(
      baseDeps({ ...fs, run, env: { FORGE_PYTHON: '/opt/py313/bin/python3.13' } }),
    );
    expect(d.explicit_requested).toBe(true);
    expect(d.selected?.argv).toEqual(['/opt/py313/bin/python3.13']);
    expect(d.selected?.version).toBe('3.13.5');
    expect(d.selected?.source).toBe('env');
    expect(d.selected?.selection_reason).toContain('FORGE_PYTHON');
  });

  it('FORGE_PYTHON vence --python quando os dois existem', async () => {
    const fs = fakeFs(['/opt/a/bin/python', '/opt/b/bin/python']);
    const run = fakeRun(
      {},
      {
        '/opt/a/bin/python --version': ok('Python 3.12.1'),
        '/opt/b/bin/python --version': ok('Python 3.13.1'),
      },
    );
    const d = await discoverPythons(
      baseDeps({
        ...fs,
        run,
        env: { FORGE_PYTHON: '/opt/a/bin/python' },
        explicit: '/opt/b/bin/python',
      }),
    );
    expect(d.selected?.argv).toEqual(['/opt/a/bin/python']);
    expect(d.selected?.source).toBe('env');
  });

  it('--python seleciona quando FORGE_PYTHON não existe (invocação com args)', async () => {
    const run = fakeRun(
      { py: 'C:\\Windows\\py.exe' },
      { 'py -3.11 --version': ok('Python 3.11.9') },
    );
    const d = await discoverPythons(
      baseDeps({ platform: 'win32', ...fakeFs([]), run, explicit: 'py -3.11' }),
    );
    expect(d.selected?.argv).toEqual(['py', '-3.11']);
    expect(d.selected?.version).toBe('3.11.9');
    expect(d.selected?.source).toBe('flag');
  });

  it('explícito inválido recusa e NUNCA cai para a auto-descoberta', async () => {
    const fs = fakeFs(['/broken/python']);
    const run = fakeRun(
      { python3: '/usr/bin/python3' },
      {
        '/broken/python --version': fail('enoent'),
        'python3 --version': ok('Python 3.14.0'),
      },
    );
    const d = await discoverPythons(
      baseDeps({ ...fs, run, env: { FORGE_PYTHON: '/broken/python' } }),
    );
    expect(d.selected).toBeNull();
    expect(d.refusal?.code).toBe('FORGE-PYTHON-UNEXECUTABLE');
    expect(d.refusal?.cause).toContain('FORGE_PYTHON=/broken/python');
    // O candidato PATH válido continua no relatório — mas não vira seleção.
    const py3 = d.candidates.find((c) => c.executable === '/usr/bin/python3');
    expect(py3?.verdict).toBe('ok');
  });

  it('explícito abaixo do piso → FORGE-PYTHON-INCOMPATIBLE', async () => {
    const fs = fakeFs(['/opt/py39/bin/python']);
    const run = fakeRun({}, { '/opt/py39/bin/python --version': ok('Python 3.9.18') });
    const d = await discoverPythons(
      baseDeps({ ...fs, run, floor: '>=3.10', explicit: '/opt/py39/bin/python' }),
    );
    expect(d.selected).toBeNull();
    expect(d.refusal?.code).toBe('FORGE-PYTHON-INCOMPATIBLE');
  });
});

describe('seleção automática', () => {
  it('escolhe a maior versão compatível — nunca a primeira do PATH', async () => {
    const run = fakeRun(
      {
        'python3.14': '/usr/bin/python3.14',
        'python3.12': '/usr/bin/python3.12',
        python3: '/usr/bin/python3',
      },
      {
        'python3.14 --version': ok('Python 3.14.2'),
        'python3.12 --version': ok('Python 3.12.8'),
        'python3 --version': ok('Python 3.11.4'),
      },
    );
    const d = await discoverPythons(baseDeps({ ...fakeFs([]), run, floor: '>=3.10' }));
    expect(d.selected?.version).toBe('3.14.2');
    expect(d.selected?.source).toBe('path');
  });

  it('prefere estável a pré-release mesmo quando o pré é mais novo', async () => {
    const run = fakeRun(
      { 'python3.14': '/usr/bin/python3.14', python3: '/usr/bin/python3' },
      {
        'python3.14 --version': ok('Python 3.14.0a1'),
        'python3 --version': ok('Python 3.13.7'),
      },
    );
    const d = await discoverPythons(baseDeps({ ...fakeFs([]), run }));
    expect(d.selected?.version).toBe('3.13.7');
  });

  it('pré-release vence só quando nenhum estável satisfaz', async () => {
    const run = fakeRun(
      { 'python3.14': '/usr/bin/python3.14' },
      { 'python3.14 --version': ok('Python 3.14.0a1') },
    );
    const d = await discoverPythons(baseDeps({ ...fakeFs([]), run }));
    expect(d.selected?.version).toBe('3.14.0a1');
  });

  it('respeita o piso — 3.9 executa mas é incompatible', async () => {
    const run = fakeRun(
      { python3: '/usr/bin/python3' },
      { 'python3 --version': ok('Python 3.9.6') },
    );
    const d = await discoverPythons(baseDeps({ ...fakeFs([]), run, floor: '>=3.10' }));
    expect(d.selected).toBeNull();
    expect(d.refusal?.code).toBe('FORGE-PYTHON-INCOMPATIBLE');
    const c = d.candidates.find((x) => x.argv[0] === 'python3');
    expect(c?.verdict).toBe('incompatible');
    expect(c?.code).toBe('FORGE-PYTHON-INCOMPATIBLE');
  });

  it('range composto >=3.10,<3.13 exclui 3.14', async () => {
    const run = fakeRun(
      { 'python3.14': '/usr/bin/python3.14', 'python3.12': '/usr/bin/python3.12' },
      {
        'python3.14 --version': ok('Python 3.14.0'),
        'python3.12 --version': ok('Python 3.12.4'),
      },
    );
    const d = await discoverPythons(baseDeps({ ...fakeFs([]), run, floor: '>=3.10,<3.13' }));
    expect(d.selected?.version).toBe('3.12.4');
  });
});

describe('vereditos — absent/unexecutable/store-stub', () => {
  it('nome não resolvido no PATH é absent, não unexecutable', async () => {
    const run = fakeRun({}, {});
    const d = await discoverPythons(baseDeps({ ...fakeFs([]), run }));
    const c = d.candidates.find((x) => x.argv[0] === 'python3');
    expect(c?.verdict).toBe('absent');
    expect(c?.code).toBe('FORGE-PYTHON-NOT-FOUND');
  });

  it('shim quebrado (não-zero) e timeout viram unexecutable', async () => {
    const run = fakeRun(
      { 'python3.14': '/usr/bin/python3.14', python3: '/usr/bin/python3' },
      {
        'python3.14 --version': timeout(),
        'python3 --version': fail('Traceback boom'),
      },
    );
    const d = await discoverPythons(baseDeps({ ...fakeFs([]), run }));
    expect(d.selected).toBeNull();
    expect(d.refusal?.code).toBe('FORGE-PYTHON-UNEXECUTABLE');
    const to = d.candidates.find((x) => x.argv[0] === 'python3.14');
    expect(to?.verdict).toBe('unexecutable');
    expect(to?.note).toContain('timeout');
  });

  it('saída sem "Python X.Y.Z" é unexecutable — nome não prova nada', async () => {
    const run = fakeRun(
      { python3: '/usr/bin/python3' },
      { 'python3 --version': ok('definitely-not-a-python') },
    );
    const d = await discoverPythons(baseDeps({ ...fakeFs([]), run }));
    expect(d.selected).toBeNull();
    expect(d.candidates.find((c) => c.argv[0] === 'python3')?.verdict).toBe('unexecutable');
  });

  it('alias da Microsoft Store vira store-stub → FORGE-PYTHON-NOT-FOUND', async () => {
    const storeAlias = 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe';
    const run = fakeRun({ python: storeAlias }, { 'python --version': fail('') });
    const d = await discoverPythons(baseDeps({ platform: 'win32', ...fakeFs([]), run }));
    const c = d.candidates.find((x) => x.argv[0] === 'python');
    expect(c?.verdict).toBe('store-stub');
    expect(c?.code).toBe('FORGE-PYTHON-NOT-FOUND');
    expect(d.refusal?.code).toBe('FORGE-PYTHON-NOT-FOUND');
  });

  it('instalação real da Store que responde --version passa (não é stub)', async () => {
    const storeReal =
      'C:\\Program Files\\WindowsApps\\PythonSoftwareFoundation.Python.3.13\\python.exe';
    const run = fakeRun({ python: storeReal }, { 'python --version': ok('Python 3.13.1') });
    const d = await discoverPythons(baseDeps({ platform: 'win32', ...fakeFs([]), run }));
    expect(d.selected?.version).toBe('3.13.1');
  });
});

describe('determinismo, dedup e orçamento', () => {
  it('candidatos saem na ordem dos estágios (PATH antes de managers/platform)', async () => {
    const fs = fakeFs(['/home/x/.local/share/uv/python/cp/bin/python3'], {
      '/home/x/.local/share/uv/python': ['cp'],
    });
    const run = fakeRun(
      { python3: '/usr/bin/python3' },
      {
        'python3 --version': ok('Python 3.12.0'),
        '/home/x/.local/share/uv/python/cp/bin/python3 --version': ok('Python 3.13.0'),
      },
    );
    const d = await discoverPythons(baseDeps({ ...fs, run }));
    const stages = d.candidates.map((c) => c.stage);
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    // uv (estágio 5) mais novo que PATH (3) — a maior versão vence.
    expect(d.selected?.version).toBe('3.13.0');
  });

  it('dedup por realpath: nome do PATH e caminho absoluto do mesmo binário viram um', async () => {
    const fs = fakeFs(['/usr/bin/python3']);
    const run = fakeRun(
      { python3: '/usr/bin/python3' },
      { 'python3 --version': ok('Python 3.12.0') },
    );
    // /usr/bin/python3 (path absoluto) também é enumerado no estágio 6 —
    // o probe roda como `/usr/bin/python3 --version`, não `python3`.
    const run2: ProbeRun = async (cmd, args) => {
      if (cmd === '/usr/bin/python3' && args.join(' ') === '--version') {
        return ok('Python 3.12.0');
      }
      return run(cmd, args);
    };
    const d = await discoverPythons(baseDeps({ ...fs, run: run2 }));
    const hits = d.candidates.filter((c) => c.verdict === 'ok' && c.version === '3.12.0');
    expect(hits.length).toBe(1);
  });

  it('o teto de candidatos corta e reporta truncated', async () => {
    const run = fakeRun(
      { python3: '/usr/bin/python3' },
      {
        'python3 --version': ok('Python 3.12.0'),
      },
    );
    const d = await discoverPythons(baseDeps({ ...fakeFs([]), run, maxCandidates: 2 }));
    expect(d.candidates.length).toBeLessThanOrEqual(2);
    expect(d.truncated).toBeGreaterThan(0);
  });

  it('duas execuções idênticas produzem resultados iguais (determinismo)', async () => {
    const run = fakeRun(
      { python3: '/usr/bin/python3' },
      { 'python3 --version': ok('Python 3.12.0') },
    );
    const mkDeps = () => baseDeps({ ...fakeFs([]), run });
    const [a, b] = await Promise.all([discoverPythons(mkDeps()), discoverPythons(mkDeps())]);
    expect(a).toEqual(b);
  });
});

describe('receipt — proveniência e legado', () => {
  it('receiptPythonInfo normaliza string legada sem regravar nada', () => {
    const info = receiptPythonInfo('3.12.4');
    expect(info?.version).toBe('3.12.4');
    expect(info?.source).toBe('receipt-legado');
    expect(info?.selection_reason).toContain('lf-0017');
  });

  it('receiptPythonInfo preserva o objeto novo', () => {
    const obj = {
      source: 'path',
      version: '3.13.1',
      executable: '/usr/bin/python3.13',
      selection_reason: 'maior compatível',
    };
    expect(receiptPythonInfo(obj)).toEqual(obj);
  });
});
