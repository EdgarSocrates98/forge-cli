import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, discoverEnvironment } from '../src/discovery.js';
import { commandOutput, commandWorks, resolvePython } from '../src/utils/system.js';

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
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-disc-'));
  vi.mocked(commandWorks).mockResolvedValue(false);
  vi.mocked(commandOutput).mockResolvedValue(null);
  vi.mocked(resolvePython).mockResolvedValue(null);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, content: string) => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const now = () => 0;
const markerSignals = (report: Awaited<ReturnType<typeof discoverEnvironment>>) =>
  new Map(report.workspace.markers.map((m) => [m.file, m.signals]));

describe('DEFAULT_LIMITS', () => {
  it('declara os limites do spec', () => {
    expect(DEFAULT_LIMITS).toMatchObject({
      maxDepth: 3,
      maxEntriesPerDir: 500,
      maxTotalEntries: 5000,
      timeoutMs: 2000,
    });
    expect(DEFAULT_LIMITS.skipDirs).toEqual(
      expect.arrayContaining(['node_modules', '.git', '.venv', 'venv', '.forge-cli']),
    );
  });
});

describe('discoverEnvironment — marcadores', () => {
  it('detecta marcadores por tipo de arquivo', async () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^4.0.0' } }));
    write('pyproject.toml', '[project]\ndependencies = ["fastapi"]\n');
    write('Dockerfile', 'FROM scratch\n');
    write('compose.yaml', 'services: {}\n');
    write('main.tf', 'provider "aws" {}\n');
    write('pom.xml', '<project/>\n');
    write('build.gradle', 'plugins {}\n');
    write('.github/workflows/ci.yml', 'name: ci\n');
    write('Chart.yaml', 'apiVersion: v2\n');
    write('forge.json', JSON.stringify({ forge_id: 'x-forge' }));
    const report = await discoverEnvironment(dir, { now });
    const markers = markerSignals(report);
    expect(markers.get('package.json')).toEqual(expect.arrayContaining(['node-app', 'api']));
    expect(markers.get('pyproject.toml')).toEqual(expect.arrayContaining(['python-app', 'api']));
    expect(markers.get('Dockerfile')).toEqual(['docker']);
    expect(markers.get('compose.yaml')).toEqual(['docker']);
    expect(markers.get('main.tf')).toEqual(expect.arrayContaining(['terraform', 'aws']));
    expect(markers.get('pom.xml')).toEqual(['java-app']);
    expect(markers.get('build.gradle')).toEqual(['java-app']);
    expect(markers.get('.github/workflows')).toEqual(['ci']);
    expect(markers.get('Chart.yaml')).toEqual(['kubernetes']);
    expect(markers.get('forge.json')).toEqual(['forge-manifest']);
    for (const s of [
      'node-app',
      'api',
      'python-app',
      'docker',
      'terraform',
      'aws',
      'java-app',
      'ci',
      'kubernetes',
      'forge-manifest',
    ]) {
      expect(report.signals).toContain(s);
    }
  });

  it('requirements.txt com pyspark+boto3 → sinais pyspark e aws', async () => {
    write('requirements.txt', 'pyspark==3.5.1\nboto3>=1.28\npandas\n');
    const report = await discoverEnvironment(dir, { now });
    expect(report.signals).toEqual(
      expect.arrayContaining(['python-app', 'pyspark', 'aws', 'data']),
    );
  });

  it('ignora marcadores dentro de diretórios pulados', async () => {
    write('node_modules/lib/package.json', '{"dependencies":{"express":"*"}}');
    write('.venv/requirements.txt', 'pyspark\n');
    const report = await discoverEnvironment(dir, { now });
    expect(report.workspace.markers).toEqual([]);
    expect(report.signals).not.toContain('node-app');
    expect(report.signals).not.toContain('pyspark');
  });

  it('nunca lê conteúdo de .env — só registra caminhos', async () => {
    const secret = 'shhh-ultra-secret-value-42';
    write('.env', `TOKEN=${secret}\nPASSWORD=${secret}\n`);
    write('.env.example', 'TOKEN=\n');
    const report = await discoverEnvironment(dir, { now });
    expect(report.workspace.env_files).toEqual(['.env', '.env.example']);
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});

describe('discoverEnvironment — limites', () => {
  it('árvore mais profunda que maxDepth trunca sem explodir', async () => {
    const deep = path.join(dir, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10');
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, 'requirements.txt'), 'pyspark\n');
    const report = await discoverEnvironment(dir, { now });
    expect(report.truncated).toBe(true);
    expect(report.signals).not.toContain('pyspark');
    // a parte rasa da árvore ainda aparece
    expect(report.workspace.markers.every((m) => m.file.split('/').length <= 5)).toBe(true);
  });

  it('diretório com mais de maxEntriesPerDir entradas trunca', async () => {
    for (let i = 0; i < 10; i++) write(`f${i}.txt`, 'x');
    const report = await discoverEnvironment(dir, {
      now,
      limits: { maxEntriesPerDir: 3 },
    });
    expect(report.truncated).toBe(true);
    expect(report.workspace.markers.length).toBeLessThanOrEqual(3);
  });

  it('maxTotalEntries limita a varredura total', async () => {
    for (let i = 0; i < 10; i++) write(`sub${i}/requirements.txt`, 'boto3\n');
    const report = await discoverEnvironment(dir, {
      now,
      limits: { maxTotalEntries: 6 },
    });
    expect(report.truncated).toBe(true);
    expect(report.workspace.markers.length).toBeLessThan(10);
  });
});

describe('discoverEnvironment — forjas e hosts', () => {
  it('forja com checkout git + forge.json → declared (nunca integrada)', async () => {
    mkdirSync(path.join(dir, 'the-forge', '.git'), { recursive: true });
    write('the-forge/forge.json', JSON.stringify({ forge_id: 'the-forge', cli: 'theforge' }));
    const report = await discoverEnvironment(dir, { now });
    const forge = report.forges.find((f) => f.name === 'the-forge');
    expect(forge?.state).toBe('declared');
    expect(forge?.state).not.toBe('integrated');
    expect(report.workspace.forges).toEqual([
      { name: 'the-forge', path: 'the-forge', git: true, manifest: true },
    ]);
  });

  it('checkout sem forge.json → detected; ausente → unknown', async () => {
    mkdirSync(path.join(dir, 'api-forge', '.git'), { recursive: true });
    const report = await discoverEnvironment(dir, { now });
    expect(report.forges.find((f) => f.name === 'api-forge')?.state).toBe('detected');
    expect(report.forges.find((f) => f.name === 'forge-portal')?.state).toBe('unknown');
  });

  it('state.json instalado → configured; validado → validated; falho → degraded', async () => {
    write(
      '.forge-cli/state.json',
      JSON.stringify({
        version: 1,
        repos: {
          'api-forge': { status: 'ok', detail: 'ok', at: 'x', phase: 'installed' },
          'the-forge': { status: 'ok', detail: 'ok', at: 'x', phase: 'validated' },
          'platform-forge': { status: 'error', detail: 'boom', at: 'x', phase: 'failed' },
          'forge-portal': { status: 'ok', detail: 'ok', at: 'x', phase: 'installed' },
        },
      }),
    );
    for (const name of ['api-forge', 'the-forge', 'platform-forge']) {
      mkdirSync(path.join(dir, name, '.git'), { recursive: true });
    }
    const report = await discoverEnvironment(dir, { now });
    const state = (n: string) => report.forges.find((f) => f.name === n)?.state;
    expect(state('api-forge')).toBe('configured');
    expect(state('the-forge')).toBe('validated');
    expect(state('platform-forge')).toBe('degraded');
    // registro diz instalada, mas o checkout não existe → evidência falhando
    expect(state('forge-portal')).toBe('degraded');
  });

  it('forja fora do catálogo com forge.json entra como declared', async () => {
    mkdirSync(path.join(dir, 'minha-forja', '.git'), { recursive: true });
    write('minha-forja/forge.json', JSON.stringify({ forge_id: 'minha-forja' }));
    const report = await discoverEnvironment(dir, { now });
    expect(report.forges.find((f) => f.name === 'minha-forja')?.state).toBe('declared');
  });

  it('probes de host preenchem hosts e sinais', async () => {
    vi.mocked(commandWorks).mockImplementation(async (cmd) => cmd === 'claude');
    vi.mocked(commandOutput).mockImplementation(async (cmd) =>
      cmd === 'claude' ? 'claude 1.2.3' : null,
    );
    const report = await discoverEnvironment(dir, { now });
    const claude = report.hosts.find((h) => h.name === 'claude');
    expect(claude).toMatchObject({ name: 'claude', detected: true, version: 'claude 1.2.3' });
    expect(report.hosts.filter((h) => h.detected)).toHaveLength(1);
    expect(report.signals).toContain('claude-host');
  });

  it('probes de ferramentas com versão', async () => {
    vi.mocked(commandOutput).mockImplementation(async (cmd) =>
      cmd === 'git' ? 'git version 2.45.0.windows.1' : null,
    );
    vi.mocked(resolvePython).mockResolvedValue(['py', '-3']);
    const report = await discoverEnvironment(dir, { now });
    const git = report.tools.find((t) => t.name === 'git');
    expect(git).toMatchObject({ found: true, version: 'git version 2.45.0.windows.1' });
    expect(report.tools.find((t) => t.name === 'python')).toMatchObject({ found: true });
    expect(report.tools.find((t) => t.name === 'docker')?.found).toBe(false);
  });
});

describe('discoverEnvironment — robustez e determinismo', () => {
  it('diretório vazio → relatório vazio, sem crash', async () => {
    const report = await discoverEnvironment(dir, { now });
    expect(report.schema).toBe('forge-cli/EnvReport/v1');
    expect(report.signals).toEqual([]);
    expect(report.workspace.markers).toEqual([]);
    expect(report.workspace.env_files).toEqual([]);
    expect(report.truncated).toBe(false);
    expect(report.forges.every((f) => f.state === 'unknown')).toBe(true);
    expect(report.tools.every((t) => !t.found)).toBe(true);
    expect(report.hosts.every((h) => !h.detected)).toBe(true);
  });

  it('diretório inexistente → relatório vazio, sem crash', async () => {
    const report = await discoverEnvironment(path.join(dir, 'nao-existe'), { now });
    expect(report.signals).toEqual([]);
    expect(report.truncated).toBe(false);
  });

  it('determinístico — mesma entrada duas vezes → saída idêntica', async () => {
    write('requirements.txt', 'pyspark\nboto3\n');
    write('Dockerfile', 'FROM scratch\n');
    const a = await discoverEnvironment(dir, { now });
    const b = await discoverEnvironment(dir, { now });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
