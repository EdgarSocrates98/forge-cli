import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostAdapters } from '../src/hosts/index.js';
import type { Prediction } from '../src/intel/contracts.js';
import { predictCompatibility } from '../src/intel/predict.js';
import type { ForgeRepo } from '../src/types.js';
import { commandOutput, commandWorks, resolvePython } from '../src/utils/system.js';

vi.mock('execa', () => ({ execa: vi.fn() }));
import { execa } from 'execa';
const mockedExeca = vi.mocked(execa);

/**
 * §6.5 — predictive compatibility. Every rule: positive case with evidence
 * plus the silence case (no evidence → no finding). Hermetic probes.
 */

vi.mock('../src/utils/system.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/utils/system.js')>();
  return {
    ...mod,
    commandWorks: vi.fn(async () => false),
    commandOutput: vi.fn(async () => null),
    resolvePython: vi.fn(async () => null),
  };
});

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-pred-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-home-'));
  vi.mocked(commandWorks).mockResolvedValue(false);
  vi.mocked(commandOutput).mockResolvedValue(null);
  vi.mocked(resolvePython).mockResolvedValue(null);
  // Pipeline lf-0017 (execa real → mock): o único interpretador do
  // "host" é `python3` → Python 3.12.1; todo o resto falha/ausente.
  mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
    if (cmd === 'sh' && args[1] === 'command -v python3') {
      return Promise.resolve({ exitCode: 0, stdout: '/usr/bin/python3', stderr: '' });
    }
    if (cmd === 'python3' && args.join(' ') === '--version') {
      return Promise.resolve({ exitCode: 0, stdout: 'Python 3.12.1', stderr: '' });
    }
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
  }) as never);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const write = (rel: string, content: string) => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};

const repo = (name: string, kind: 'python' | 'node' = 'python'): ForgeRepo => ({
  name,
  url: `https://local.test/${name}`,
  description: name,
  kind,
});

const noHosts = () => ({ home, adapters: hostAdapters({ output: async () => null }) });

const byKind = (preds: Prediction[], kind: Prediction['kind']) =>
  preds.filter((p) => p.kind === kind);

function assertShape(preds: Prediction[]) {
  for (const p of preds) {
    expect(p.id.length).toBeGreaterThan(0);
    expect(p.evidence.length).toBeGreaterThan(0);
    expect(['high', 'medium', 'low']).toContain(p.certainty);
    expect(p.version).toHaveProperty('from');
    expect(p.version).toHaveProperty('to');
    expect(p.explanation.length).toBeGreaterThan(0);
  }
  // determinism: ids sorted, no duplicates
  const ids = preds.map((p) => p.id);
  expect(ids).toEqual([...ids].sort());
  expect(new Set(ids).size).toBe(ids.length);
}

describe('§6.5 — schema-change', () => {
  it('flags a manifest declaring an unknown contract id', async () => {
    write('repo-a/forge.json', JSON.stringify({ schema: 'forge/NoSuch/v9', forge_id: 'repo-a' }));
    const preds = await predictCompatibility(dir, [repo('repo-a')], noHosts());
    const hits = byKind(preds, 'schema-change');
    expect(hits.length).toBe(1);
    expect(hits[0].version.from).toBe('forge/NoSuch/v9');
    expect(hits[0].evidence.length).toBeGreaterThan(0);
    assertShape(preds);
  });

  it('flags a manifest that no longer validates against its declared contract', async () => {
    // ForgeDescriptor/v1 requires forge_id — missing → contract violation.
    write('repo-a/forge.json', JSON.stringify({ schema: 'forge/ForgeDescriptor/v1' }));
    const preds = await predictCompatibility(dir, [repo('repo-a')], noHosts());
    expect(byKind(preds, 'schema-change').length).toBe(1);
  });

  it('is silent without a manifest or without a schema field', async () => {
    write('repo-a/README.md', 'x');
    expect(
      byKind(await predictCompatibility(dir, [repo('repo-a')], noHosts()), 'schema-change'),
    ).toEqual([]);
    write('repo-a/forge.json', JSON.stringify({ forge_id: 'repo-a', version: '1.0.0' }));
    const preds = await predictCompatibility(dir, [repo('repo-a')], noHosts());
    expect(byKind(preds, 'schema-change')).toEqual([]);
    expect(byKind(preds, 'breaking-change')).toEqual([]);
  });
});

describe('§6.5 — breaking-change', () => {
  it('flags a declared major bump (manifest version vs pin)', async () => {
    write('repo-v/forge.json', JSON.stringify({ forge_id: 'repo-v', version: '1.0.0' }));
    write(
      '.forge-cli/state.json',
      JSON.stringify({ version: 1, repos: {}, pins: { 'repo-v': '2.0.0' } }),
    );
    const preds = await predictCompatibility(dir, [repo('repo-v')], noHosts());
    const hits = byKind(preds, 'breaking-change');
    expect(hits.length).toBe(1);
    expect(hits[0].version).toEqual({ from: '1.0.0', to: '2.0.0' });
    assertShape(preds);
  });

  it('is silent for a minor bump and with no second reference', async () => {
    write('repo-v/forge.json', JSON.stringify({ forge_id: 'repo-v', version: '1.0.0' }));
    write(
      '.forge-cli/state.json',
      JSON.stringify({ version: 1, repos: {}, pins: { 'repo-v': '1.4.0' } }),
    );
    expect(
      byKind(await predictCompatibility(dir, [repo('repo-v')], noHosts()), 'breaking-change'),
    ).toEqual([]);
  });
});

describe('§6.5 — runtime-incompat', () => {
  it('flags a declared python floor no probe satisfies', async () => {
    write('repo-p/pyproject.toml', '[project]\nrequires-python = ">=99"\n');
    const preds = await predictCompatibility(dir, [repo('repo-p')], noHosts());
    const hits = byKind(preds, 'runtime-incompat');
    const py = hits.find((p) => p.subject.includes('Python >=99'));
    expect(py).toBeTruthy();
    expect(py?.version.to).toBe('>=99');
    assertShape(preds);
  });

  it('flags the manifest python floor against the detected interpreter', async () => {
    // Pipeline lf-0017: o interpretador "detectado" sai de
    // `discoverPythons` (execa) — `command -v python3` resolve o nome e
    // `python3 --version` executa e responde a versão.
    mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
      if (cmd === 'sh' && args[1] === 'command -v python3') {
        return Promise.resolve({ exitCode: 0, stdout: '/usr/bin/python3', stderr: '' });
      }
      if (cmd === 'python3' && args.join(' ') === '--version') {
        return Promise.resolve({ exitCode: 0, stdout: 'Python 3.12.1', stderr: '' });
      }
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
    }) as never);
    vi.mocked(commandOutput).mockImplementation(async (cmd, args = []) => {
      const a = args.join(' ');
      if (a.includes('-m pip')) return 'pip 24.0';
      if (/--version/.test(a)) return 'Python 3.12.1';
      return null;
    });
    vi.mocked(commandWorks).mockResolvedValue(true);
    write('repo-p/forge.json', JSON.stringify({ forge_id: 'repo-p', python: '>=99' }));
    const preds = await predictCompatibility(dir, [repo('repo-p')], noHosts());
    const hits = byKind(preds, 'runtime-incompat');
    expect(hits.some((p) => p.id === 'runtime-incompat:repo-p:python')).toBe(true);
    expect(hits[0].version.to).toBe('>=99');
    expect(hits[0].version.from).toContain('3.12.1');
  });

  it('is silent when the declared floor is satisfied', async () => {
    vi.mocked(commandOutput).mockImplementation(async (_cmd, args = []) => {
      const a = args.join(' ');
      if (a.includes('-m pip')) return 'pip 24.0';
      if (/--version/.test(a)) return 'Python 3.12.1';
      return null;
    });
    vi.mocked(commandWorks).mockResolvedValue(true);
    write('repo-p/pyproject.toml', '[project]\nrequires-python = ">=3.10"\n');
    write('repo-p/forge.json', JSON.stringify({ forge_id: 'repo-p', python: '>=3.10' }));
    const preds = await predictCompatibility(dir, [repo('repo-p')], noHosts());
    expect(byKind(preds, 'runtime-incompat')).toEqual([]);
  });
});

describe('§6.5 — host-version', () => {
  it('flags a detected host below a manifest-declared floor', async () => {
    write(
      'repo-h/forge.json',
      JSON.stringify({ forge_id: 'repo-h', min_host_versions: { claude: '>=2.0.0' } }),
    );
    const adapters = hostAdapters({
      output: async (cmd) => (cmd === 'claude' ? 'claude 1.5.0' : null),
    });
    const preds = await predictCompatibility(dir, [repo('repo-h')], { home, adapters });
    const hits = byKind(preds, 'host-version');
    expect(hits.length).toBe(1);
    expect(hits[0].version).toEqual({ from: '1.5.0', to: '>=2.0.0' });
    assertShape(preds);
  });

  it('is silent without a declared floor, even with a detected host', async () => {
    write('repo-h/forge.json', JSON.stringify({ forge_id: 'repo-h' }));
    const adapters = hostAdapters({
      output: async (cmd) => (cmd === 'claude' ? 'claude 0.0.1' : null),
    });
    const preds = await predictCompatibility(dir, [repo('repo-h')], { home, adapters });
    expect(byKind(preds, 'host-version')).toEqual([]);
  });

  it('is silent when the floor is satisfied or the host is absent', async () => {
    write(
      'repo-h/forge.json',
      JSON.stringify({ forge_id: 'repo-h', min_host_versions: { claude: '>=1.0.0' } }),
    );
    const adapters = hostAdapters({
      output: async (cmd) => (cmd === 'claude' ? 'claude 1.5.0' : null),
    });
    expect(
      byKind(await predictCompatibility(dir, [repo('repo-h')], { home, adapters }), 'host-version'),
    ).toEqual([]);
    // host absent (probe returns null) → no version evidence → silence
    expect(
      byKind(await predictCompatibility(dir, [repo('repo-h')], noHosts()), 'host-version'),
    ).toEqual([]);
  });
});

describe('§6.5 — renamed-var / obsolete', () => {
  it('hints a rename when an unknown .env key resembles a schema key', async () => {
    write('repo-e/.env.example', 'APIFORGE_HOME=\nOTHER_VAR=\n');
    write('repo-e/.env', 'API_FORGE_HOME=x\nRANDOM_JUNK=y\n');
    const preds = await predictCompatibility(dir, [repo('repo-e')], noHosts());
    const renamed = byKind(preds, 'renamed-var');
    expect(renamed.length).toBe(1);
    expect(renamed[0].version).toEqual({ from: 'API_FORGE_HOME', to: 'APIFORGE_HOME' });
    const obsolete = byKind(preds, 'obsolete');
    expect(obsolete.length).toBe(1);
    expect(obsolete[0].version).toEqual({ from: 'RANDOM_JUNK', to: null });
    // never raw values
    expect(JSON.stringify(preds)).not.toContain('=x');
    assertShape(preds);
  });

  it('is silent when every .env key is in the schema or no schema exists', async () => {
    write('repo-e/.env.example', 'A_KEY=\n');
    write('repo-e/.env', 'A_KEY=x\n');
    expect(await predictCompatibility(dir, [repo('repo-e')], noHosts())).toEqual([]);
    // no schema anywhere → nothing to compare against
    write('repo-f/.env', 'ORPHAN=z\n');
    expect(await predictCompatibility(dir, [repo('repo-f')], noHosts())).toEqual([]);
  });
});

describe('§6.5 — install-conflict', () => {
  it('flags two repos claiming the same MCP server key', async () => {
    write('dup-a/forge.json', JSON.stringify({ forge_id: 'dup-a', mcp_server_name: 'same-key' }));
    write('dup-b/forge.json', JSON.stringify({ forge_id: 'dup-b', mcp_server_name: 'same-key' }));
    const preds = await predictCompatibility(dir, [repo('dup-a'), repo('dup-b')], noHosts());
    const hits = byKind(preds, 'install-conflict');
    expect(hits.length).toBe(1);
    expect(hits[0].subject).toContain('same-key');
    expect(hits[0].evidence.length).toBe(2);
    assertShape(preds);
  });

  it('flags two repos claiming the same managed cli path', async () => {
    write('dup-a/forge.json', JSON.stringify({ forge_id: 'dup-a', cli: 'forge' }));
    write('dup-b/forge.json', JSON.stringify({ forge_id: 'dup-b', cli: 'forge' }));
    const preds = await predictCompatibility(dir, [repo('dup-a'), repo('dup-b')], noHosts());
    expect(byKind(preds, 'install-conflict').length).toBe(1);
  });

  it('is silent when claims are distinct', async () => {
    write('dup-a/forge.json', JSON.stringify({ forge_id: 'dup-a', mcp_server_name: 'a-key' }));
    write('dup-b/forge.json', JSON.stringify({ forge_id: 'dup-b', mcp_server_name: 'b-key' }));
    const preds = await predictCompatibility(dir, [repo('dup-a'), repo('dup-b')], noHosts());
    expect(byKind(preds, 'install-conflict')).toEqual([]);
  });
});

describe('§6.5 — determinism', () => {
  it('two runs on the same workspace deep-equal and stay sorted', async () => {
    write('repo-e/.env.example', 'APIFORGE_HOME=\n');
    write('repo-e/.env', 'API_FORGE_HOME=x\n');
    write('repo-v/forge.json', JSON.stringify({ schema: 'forge/NoSuch/v9', forge_id: 'repo-v' }));
    const a = await predictCompatibility(dir, [repo('repo-e'), repo('repo-v')], noHosts());
    const b = await predictCompatibility(dir, [repo('repo-v'), repo('repo-e')], noHosts());
    expect(a).toEqual(b);
    assertShape(a);
    expect(a.length).toBeGreaterThan(0);
  });
});
