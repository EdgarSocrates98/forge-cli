import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliOptions } from '../src/cli-args.js';
import { runRegistryInstall } from '../src/cmd/registry.js';
import {
  askOptionalIntegrations,
  classifyIntegrations,
  classifyIntegrationsSync,
  installableNames,
  integrationsOf,
  OPTIONAL_INTEGRATIONS,
  pendingIntegrations,
} from '../src/integrations.js';
import { FORGE_REPOS } from '../src/constants/repos.js';
import { runDoctor2, type DoctorReport } from '../src/doctor2/index.js';
import { hostAdapters } from '../src/hosts/index.js';
import type { HostProbe } from '../src/hosts/types.js';
import { loadForgeState, saveForgeState, type InstallReceipt } from '../src/registry/install.js';
import { parseVersion } from '../src/registry/versions.js';
import type { ForgeRepo } from '../src/types.js';

// ---------------------------------------------------------------------------
// lf-0031 — optional integrations: declared table, evidence-based detection,
// explicit-consent offer, doctor classification. Hermetic: tmp dirs only,
// injected `which`, no network, no real subprocess.
// ---------------------------------------------------------------------------

const NOW = '2026-01-02T03:04:05.000Z';
const tmpDirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-int-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function checkout(root: string, name: string): void {
  mkdirSync(path.join(root, name, '.git'), { recursive: true });
}

function receipt(name: string, over: Partial<InstallReceipt> = {}): InstallReceipt {
  return {
    forge: name,
    method: 'pypi',
    dist: 'x-dist',
    version: '1.2.3',
    python: '>=3.10',
    source: { kind: 'pypi' },
    venv: `/venv/${name}`,
    bin: `/venv/${name}/bin/x`,
    installedAt: NOW,
    verify: { command: ['x', '--help'], ok: true },
    files: [],
    ...over,
  } as InstallReceipt;
}

const nullProbe: HostProbe = { output: async () => null };

const repo = (name: string): ForgeRepo => ({
  name,
  url: `https://x/${name}`,
  description: 'd',
  kind: 'python',
  verify: ['x', '--help'],
});

const find = (report: DoctorReport, id: string) => report.checks.find((c) => c.id === id);

// ---------------------------------------------------------------------------

describe('OPTIONAL_INTEGRATIONS — declared table', () => {
  it('only references cataloged repos or the documented sentinel gap', () => {
    const catalog = new Set(FORGE_REPOS.map((r) => r.name));
    for (const [consumer, list] of Object.entries(OPTIONAL_INTEGRATIONS)) {
      expect(catalog.has(consumer), `consumer ${consumer} in catalog`).toBe(true);
      for (const i of list) {
        expect(catalog.has(i.name), `${consumer} → ${i.name} in catalog`).toBe(true);
      }
    }
  });

  it('never declares a forge as its own integration (no mandatory sibling loops)', () => {
    for (const [consumer, list] of Object.entries(OPTIONAL_INTEGRATIONS)) {
      expect(list.map((i) => i.name)).not.toContain(consumer);
    }
  });

  it('marks data-sentinel-forge as unadapted and without an install route', () => {
    const declared = Object.values(OPTIONAL_INTEGRATIONS)
      .flat()
      .filter((i) => i.name === 'data-sentinel-forge');
    expect(declared.length).toBeGreaterThan(0);
    for (const i of declared) {
      expect(i.adapter).toBe(false);
      expect(i.installable).toBe(false);
    }
  });

  it('the-forge declares the lf-0031 audit specialists (aws + doctor-data + sentinel)', () => {
    const names = integrationsOf('the-forge').map((i) => i.name);
    expect(names).toContain('spark-forge-aws');
    expect(names).toContain('forge-doctor-data');
    expect(names).toContain('data-sentinel-forge');
  });
});

describe('classifyIntegrationsSync — detection by evidence', () => {
  it('absent when nothing is detectable', () => {
    const root = tmp();
    const home = tmp();
    const statuses = classifyIntegrationsSync('the-forge', { root, home });
    expect(statuses.length).toBe(integrationsOf('the-forge').length);
    for (const s of statuses) expect(s.state).toBe('absent');
  });

  it('checkout when <root>/<name> exists (git or not)', () => {
    const root = tmp();
    const home = tmp();
    checkout(root, 'spark-forge-aws');
    const s = classifyIntegrationsSync('the-forge', { root, home }).find(
      (x) => x.integration.name === 'spark-forge-aws',
    );
    expect(s?.state).toBe('checkout');
  });

  it('verified when a managed receipt has verify.ok', () => {
    const root = tmp();
    const home = tmp();
    saveForgeState(home, { forges: { 'spark-forge-aws': receipt('spark-forge-aws') } });
    const s = classifyIntegrationsSync('the-forge', { root, home }).find(
      (x) => x.integration.name === 'spark-forge-aws',
    );
    expect(s?.state).toBe('verified');
    expect(s?.evidence.join(' ')).toContain('version=1.2.3');
  });

  it('degraded when a managed receipt verify failed', () => {
    const root = tmp();
    const home = tmp();
    saveForgeState(home, {
      forges: {
        'spark-forge-aws': receipt('spark-forge-aws', {
          verify: { command: [], ok: false },
        }),
      },
    });
    // verify.ok=false is degraded evidence, not "installed".
    const s = classifyIntegrationsSync('the-forge', { root, home }).find(
      (x) => x.integration.name === 'spark-forge-aws',
    );
    expect(s?.state).toBe('degraded');
  });

  it('degraded when a local receipt lost its source_dir', () => {
    const root = tmp();
    const home = tmp();
    const gone = path.join(tmp(), 'gone-source');
    saveForgeState(home, {
      forges: {
        'spark-forge-aws': {
          ...receipt('spark-forge-aws'),
          method: 'local',
          source_dir: gone,
        } as InstallReceipt,
      },
    });
    const s = classifyIntegrationsSync('the-forge', { root, home }).find(
      (x) => x.integration.name === 'spark-forge-aws',
    );
    expect(s?.state).toBe('degraded');
    expect(s?.evidence.join(' ')).toContain('AUSENTE');
  });
});

describe('classifyIntegrations — PATH probe (async, install flows)', () => {
  it('installed via bin found on PATH when nothing managed exists', async () => {
    const root = tmp();
    const home = tmp();
    const statuses = await classifyIntegrations('the-forge', {
      root,
      home,
      which: async (bin) => (bin === 'sparkforge-aws' ? `/usr/bin/${bin}` : null),
      bin: (n) => (n === 'spark-forge-aws' ? 'sparkforge-aws' : undefined),
    });
    const s = statuses.find((x) => x.integration.name === 'spark-forge-aws');
    expect(s?.state).toBe('installed');
    expect(s?.evidence.join(' ')).toContain('PATH');
  });

  it('a PATH probe never overrides receipt evidence', async () => {
    const root = tmp();
    const home = tmp();
    saveForgeState(home, { forges: { 'spark-forge-aws': receipt('spark-forge-aws') } });
    const statuses = await classifyIntegrations('the-forge', {
      root,
      home,
      which: async () => '/usr/bin/fake',
      bin: () => 'sparkforge-aws',
    });
    const s = statuses.find((x) => x.integration.name === 'spark-forge-aws');
    expect(s?.state).toBe('verified');
  });
});

describe('askOptionalIntegrations — explicit consent', () => {
  it('offers only absent/checkout integrations — never already healthy ones', async () => {
    const root = tmp();
    const home = tmp();
    saveForgeState(home, { forges: { 'spark-forge-aws': receipt('spark-forge-aws') } });
    checkout(root, 'api-forge');
    const statuses = classifyIntegrationsSync('the-forge', { root, home });
    const offer = await askOptionalIntegrations(statuses, async (opts) => {
      const names = opts.map((o) => o.value);
      expect(names).toContain('api-forge'); // checkout = candidato
      expect(names).not.toContain('spark-forge-aws'); // verified = fora da oferta
      return [];
    });
    expect(offer.consented).toEqual([]);
    expect(offer.installable).toEqual([]);
  });

  it('empty selection = declined consent, nothing installs', async () => {
    const statuses = classifyIntegrationsSync('the-forge', { root: tmp(), home: tmp() });
    const offer = await askOptionalIntegrations(statuses, async () => []);
    expect(offer.consented).toEqual([]);
    expect(offer.installable).toEqual([]);
    expect(offer.notInstallable).toEqual([]);
  });

  it('cancel (null) is also declined consent', async () => {
    const statuses = classifyIntegrationsSync('the-forge', { root: tmp(), home: tmp() });
    const offer = await askOptionalIntegrations(statuses, async () => null);
    expect(offer.consented).toEqual([]);
  });

  it('consented names split into installable vs no-route (sentinel is honest)', async () => {
    const statuses = classifyIntegrationsSync('the-forge', { root: tmp(), home: tmp() });
    const offer = await askOptionalIntegrations(statuses, async () => [
      'forge-doctor-data',
      'data-sentinel-forge',
    ]);
    expect(offer.consented).toEqual(['forge-doctor-data', 'data-sentinel-forge']);
    expect(offer.installable).toEqual(['forge-doctor-data']);
    expect(offer.notInstallable).toEqual(['data-sentinel-forge']);
  });
});

describe('pendingIntegrations / installableNames', () => {
  it('pending = absent or checkout; healthy states never offered', () => {
    const root = tmp();
    const home = tmp();
    checkout(root, 'api-forge');
    saveForgeState(home, { forges: { 'api-forge': receipt('api-forge') } });
    const statuses = classifyIntegrationsSync('the-forge', { root, home });
    // receipt beats checkout → api-forge is 'verified', not pending.
    const pending = pendingIntegrations(statuses).map((s) => s.integration.name);
    expect(pending).not.toContain('api-forge');
    expect(pending).toContain('spark-forge-aws');
  });

  it('installableNames excludes the no-route sentinel', () => {
    const statuses = classifyIntegrationsSync('the-forge', { root: tmp(), home: tmp() });
    const names = installableNames(pendingIntegrations(statuses));
    expect(names).toContain('spark-forge-aws');
    expect(names).not.toContain('data-sentinel-forge');
  });
});

describe('doctor2 — installation.integrations.*', () => {
  function doctorOpts(root: string, home: string, catalog: ForgeRepo[]) {
    return {
      now: () => NOW,
      home,
      adapters: hostAdapters(nullProbe),
      catalog,
    };
  }

  it('absent integrations classify as optional — skip, never fail', async () => {
    const root = tmp();
    const home = tmp();
    checkout(root, 'the-forge');
    const report = await runDoctor2(
      root,
      doctorOpts(root, home, [repo('the-forge'), repo('spark-forge-aws')]),
    );
    const c = find(report, 'installation.integrations.the-forge');
    expect(c).toBeDefined();
    expect(c?.result).toBe('skip');
    expect(c?.severity).toBe('info');
    expect(report.checks.some((x) => x.id.includes('integrations') && x.result === 'fail')).toBe(
      false,
    );
  });

  it('present integrations report pass with per-specialist evidence', async () => {
    const root = tmp();
    const home = tmp();
    checkout(root, 'the-forge');
    checkout(root, 'spark-forge-aws');
    saveForgeState(home, { forges: { 'forge-doctor-data': receipt('forge-doctor-data') } });
    const report = await runDoctor2(
      root,
      doctorOpts(root, home, [
        repo('the-forge'),
        repo('spark-forge-aws'),
        repo('forge-doctor-data'),
      ]),
    );
    const c = find(report, 'installation.integrations.the-forge');
    expect(c?.result).toBe('pass');
    const ev = c?.evidence.join('\n') ?? '';
    expect(ev).toContain('spark-forge-aws: state=checkout');
    expect(ev).toContain('forge-doctor-data: state=verified');
    expect(ev).toContain('data-sentinel-forge: state=absent');
    // delegation-adapter + capability dims per specialist
    expect(ev).toContain('adapter=the-forge');
    expect(ev).toContain('adapter=ausente');
    // version + executable-health dims (receipt evidence)
    expect(ev).toContain('version=1.2.3');
    expect(ev).toContain('verify=ok');
    // contract dim (forge.json ausente no checkout fake)
    expect(ev).toContain('contract=sem forge.json');
  });

  it('a degraded optional specialist warns but never fails the main forge', async () => {
    const root = tmp();
    const home = tmp();
    checkout(root, 'the-forge');
    saveForgeState(home, {
      forges: {
        'spark-forge-aws': receipt('spark-forge-aws', {
          verify: { command: ['x', '--help'], ok: false },
        }),
      },
    });
    const report = await runDoctor2(
      root,
      doctorOpts(root, home, [repo('the-forge'), repo('spark-forge-aws')]),
    );
    const c = find(report, 'installation.integrations.the-forge');
    expect(c?.result).toBe('warn');
    expect(c?.severity).toBe('low');
    expect(report.checks.some((x) => x.id.includes('integrations') && x.result === 'fail')).toBe(
      false,
    );
  });

  it('no integrations check is emitted for absent consumers', async () => {
    const root = tmp();
    const home = tmp();
    // nada instalado — consumidor ausente não produz check de integrações.
    const report = await runDoctor2(
      root,
      doctorOpts(root, home, [repo('the-forge'), repo('spark-forge-aws')]),
    );
    expect(find(report, 'installation.integrations.the-forge')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runRegistryInstall end-to-end (mocks: pythons + PyPI + runner) — the real
// post-install offer surface: `optional_integrations` in the report doc and
// zero sibling side-effects. Non-interactive (--yes): offer vira nota,
// consentimento nunca é presumido.
// ---------------------------------------------------------------------------

describe('runRegistryInstall — optional integrations surface', () => {
  const WHEEL_BYTES = 'fake-theforge-wheel';
  const WHEEL_SHA = createHash('sha256').update(WHEEL_BYTES).digest('hex');
  const WHEEL_NAME = 'theforge_core-0.1.0-py3-none-any.whl';
  const PYPI = {
    info: { requires_python: '>=3.11' },
    releases: {
      '0.1.0': [
        {
          filename: WHEEL_NAME,
          url: 'https://f/theforge_core-0.1.0.whl',
          digests: { sha256: WHEEL_SHA },
          packagetype: 'bdist_wheel',
        },
      ],
    },
  };

  const cli = (over: Partial<CliOptions> = {}) =>
    ({
      only: undefined,
      all: false,
      yes: true,
      jsonReport: false,
      timeoutSet: false,
      jobsSet: false,
      ...over,
    }) as CliOptions;

  it('install report lists pending integrations; nothing installs without consent', async () => {
    const home = tmp();
    const root = tmp();
    const reportFile = path.join(tmp(), 'install-report.json');
    const calls: string[][] = [];
    const res = await runRegistryInstall(
      cli({ reportPath: reportFile, dir: root }),
      ['the-forge'],
      {
        home,
        pythons: [{ exe: ['python3'], version: '3.12.4', parsed: parseVersion('3.12.4')! }],
        fetchImpl: async () => ({ status: 200, body: JSON.stringify(PYPI) }),
        run: async (cmd, args) => {
          calls.push([cmd, ...args]);
          const di = args.indexOf('--dest');
          if (args.includes('download') && di !== -1) {
            writeFileSync(path.join(args[di + 1], WHEEL_NAME), WHEEL_BYTES);
          }
          return { exitCode: 0, stdout: 'ok', stderr: '' };
        },
        which: async () => null,
      },
    );
    expect(res[0].ok).toBe(true);

    const doc = JSON.parse(readFileSync(reportFile, 'utf8'));
    const pending = doc.optional_integrations ?? [];
    const names = pending.map((i: { name: string }) => i.name);
    // cenário de auditoria PySpark (lf-0031): aws + doctor-data + sentinel
    expect(names).toContain('spark-forge-aws');
    expect(names).toContain('forge-doctor-data');
    expect(names).toContain('data-sentinel-forge');

    const sentinel = pending.find((i: { name: string }) => i.name === 'data-sentinel-forge');
    expect(sentinel.state).toBe('absent');
    expect(sentinel.installable).toBe(false);
    expect(sentinel.adapter).toBe(false);

    // nenhum sibling foi instalado como efeito colateral da oferta
    const installed = loadForgeState(home).forges;
    expect(Object.keys(installed)).toEqual(['the-forge']);
    expect(installed['spark-forge-aws']).toBeUndefined();
    expect(installed['data-sentinel-forge']).toBeUndefined();
  });

  it('a checkout sibling already present is reported as such, not offered', async () => {
    const home = tmp();
    const root = tmp();
    checkout(root, 'spark-forge-aws'); // já clonado no workspace
    const reportFile = path.join(tmp(), 'install-report.json');
    const res = await runRegistryInstall(
      cli({ reportPath: reportFile, dir: root }),
      ['the-forge'],
      {
        home,
        pythons: [{ exe: ['python3'], version: '3.12.4', parsed: parseVersion('3.12.4')! }],
        fetchImpl: async () => ({ status: 200, body: JSON.stringify(PYPI) }),
        run: async (cmd, args) => {
          const di = args.indexOf('--dest');
          if (args.includes('download') && di !== -1) {
            writeFileSync(path.join(args[di + 1], WHEEL_NAME), WHEEL_BYTES);
          }
          return { exitCode: 0, stdout: 'ok', stderr: '' };
        },
        which: async () => null,
      },
    );
    expect(res[0].ok).toBe(true);
    const doc = JSON.parse(readFileSync(reportFile, 'utf8'));
    const aws = (doc.optional_integrations ?? []).find(
      (i: { name: string }) => i.name === 'spark-forge-aws',
    );
    expect(aws.state).toBe('checkout');
  });
});
