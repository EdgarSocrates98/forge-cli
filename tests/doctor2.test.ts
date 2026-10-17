import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeHealthScore,
  renderDoctorReport,
  runDoctor2,
  type Doctor2Options,
  type DoctorReport,
} from '../src/doctor2/index.js';
import { hostAdapters } from '../src/hosts/index.js';
import type { HostProbe } from '../src/hosts/types.js';
import type { ForgeRepo } from '../src/types.js';

// ---------------------------------------------------------------------------
// Doctor 2.0 (spec C5/§5.1) — hermetic tests: tmp workspaces, tmp homes,
// injected catalog/adapters/clock. No real CLI is ever spawned.
// ---------------------------------------------------------------------------

const NOW = '2026-01-02T03:04:05.000Z';
const tmpDirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-doc2-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const repo = (name: string, extra: Partial<ForgeRepo> = {}): ForgeRepo => ({
  name,
  url: `https://x/${name}`,
  description: 'd',
  kind: 'python',
  verify: ['x', '--help'],
  ...extra,
});

const nullProbe: HostProbe = { output: async () => null };
const probe = (map: Record<string, string>): HostProbe => ({
  output: async (command, args) => map[[command, ...args].join(' ')] ?? null,
});

function baseOpts(dir: string, home: string, over: Partial<Doctor2Options> = {}): Doctor2Options {
  return {
    now: () => NOW,
    home,
    adapters: hostAdapters(nullProbe),
    catalog: [repo('alpha'), repo('beta')],
    ...over,
  };
}

const find = (report: DoctorReport, id: string) => report.checks.find((c) => c.id === id);

function checkout(dir: string, name: string): void {
  mkdirSync(path.join(dir, name, '.git'), { recursive: true });
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function writeState(dir: string, repos: Record<string, unknown>): void {
  writeJson(path.join(dir, '.forge-cli', 'state.json'), { version: 1, repos });
}

describe('runDoctor2 — report shape', () => {
  it('emits forge/DoctorReport/v1 with >=1 check per domain', async () => {
    const dir = tmp();
    const home = tmp();
    const report = await runDoctor2(dir, baseOpts(dir, home));
    expect(report.schema).toBe('forge/DoctorReport/v1');
    expect(report.generatedAt).toBe(NOW);
    const domains = new Set(report.checks.map((c) => c.domain));
    for (const d of ['system', 'installation', 'environment', 'hosts', 'operations']) {
      expect(domains.has(d as never), `domain ${d}`).toBe(true);
    }
    for (const c of report.checks) {
      expect(c.timestamp).toBe(NOW);
      expect(c.evidence.length).toBeGreaterThan(0);
    }
  });

  it('orders checks deterministically by id across runs', async () => {
    const dir = tmp();
    const home = tmp();
    const a = await runDoctor2(dir, baseOpts(dir, home));
    const b = await runDoctor2(dir, baseOpts(dir, home));
    const ids = a.checks.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(b.checks.map((c) => c.id));
  });

  it('scores with a number when enough evidence-backed checks ran', async () => {
    const dir = tmp();
    const home = tmp();
    const report = await runDoctor2(dir, baseOpts(dir, home));
    expect(report.score.model).toBe('forge-health/v1');
    expect(report.score.sufficiency.sufficient).toBe(true);
    expect(typeof report.score.value).toBe('number');
  });
});

describe('system domain', () => {
  it('reports the real node version with pass evidence', async () => {
    const dir = tmp();
    const home = tmp();
    const report = await runDoctor2(dir, baseOpts(dir, home));
    const c = find(report, 'system.runtime.node');
    expect(c?.result).toBe('pass');
    expect(c?.evidence).toContain(`process.version=${process.version}`);
  });
});

describe('installation domain — pinned ids', () => {
  it('installation.forge-dir.absent fails low+reversible when .forge-cli is missing', async () => {
    const dir = tmp();
    const home = tmp();
    const report = await runDoctor2(dir, baseOpts(dir, home));
    const c = find(report, 'installation.forge-dir.absent');
    expect(c?.result).toBe('fail');
    expect(c?.severity).toBe('low');
    expect(c?.correctiveAction).toBe('create .forge-cli state dir');
    expect(c?.reversible).toBe(true);
  });

  it('installation.forge-dir.absent passes when .forge-cli exists', async () => {
    const dir = tmp();
    const home = tmp();
    mkdirSync(path.join(dir, '.forge-cli'), { recursive: true });
    const report = await runDoctor2(dir, baseOpts(dir, home));
    expect(find(report, 'installation.forge-dir.absent')?.result).toBe('pass');
  });

  it('installation.lockfile.drift is unverified without a lockfile', async () => {
    const dir = tmp();
    const home = tmp();
    const report = await runDoctor2(dir, baseOpts(dir, home));
    const c = find(report, 'installation.lockfile.drift');
    expect(c?.result).toBe('unverified');
    expect(c?.evidence.join(' ')).toContain('sem lockfile');
  });

  it('installation.lockfile.drift is unverified when the lockfile covers nothing', async () => {
    const dir = tmp();
    const home = tmp();
    writeJson(path.join(dir, '.forge-cli', 'env.lock.json'), {
      schema: 'forge-cli/EnvLock/v1',
      generated_at: NOW,
      forges: {},
    });
    const report = await runDoctor2(dir, baseOpts(dir, home));
    expect(find(report, 'installation.lockfile.drift')?.result).toBe('unverified');
  });

  it('installation.lockfile.drift warns medium on digest mismatch', async () => {
    const dir = tmp();
    const home = tmp();
    checkout(dir, 'alpha');
    writeJson(path.join(dir, 'alpha', 'package.json'), { name: 'alpha' });
    writeJson(path.join(dir, '.forge-cli', 'env.lock.json'), {
      schema: 'forge-cli/EnvLock/v1',
      generated_at: NOW,
      forges: { alpha: { env_files: ['package.json'], digest: 'deadbeef' } },
    });
    const report = await runDoctor2(dir, baseOpts(dir, home));
    const c = find(report, 'installation.lockfile.drift');
    expect(c?.result).toBe('warn');
    expect(c?.severity).toBe('medium');
    expect(c?.correctiveAction).toBe('regenerate lockfile');
    expect(c?.reversible).toBe(true);
    expect(c?.evidence.join(' ')).toContain('alpha=drifted');
  });

  it('installation.backup.present skips without backups and passes with one', async () => {
    const dir = tmp();
    const home = tmp();
    let report = await runDoctor2(dir, baseOpts(dir, home));
    expect(find(report, 'installation.backup.present')?.result).toBe('skip');
    writeJson(path.join(home, '.forge-cli', 'backups', 'hosts-claude-1', 'manifest.json'), {
      host: 'claude',
      files: [],
    });
    report = await runDoctor2(dir, baseOpts(dir, home));
    const c = find(report, 'installation.backup.present');
    expect(c?.result).toBe('pass');
    expect(c?.evidence.join(' ')).toContain('hosts-claude-1');
  });

  it('installation.checkouts.present warns on registry-without-checkout', async () => {
    const dir = tmp();
    const home = tmp();
    writeState(dir, { alpha: { status: 'ok', detail: 'x', at: NOW, phase: 'installed' } });
    const report = await runDoctor2(dir, baseOpts(dir, home));
    const c = find(report, 'installation.checkouts.present');
    expect(c?.result).toBe('warn');
    expect(c?.evidence.join(' ')).toContain('alpha');
  });
});

describe('environment domain — pinned ids + honesty', () => {
  it('environment.env.missing-key is unverified when no schema exists', async () => {
    const dir = tmp();
    const home = tmp();
    const report = await runDoctor2(dir, baseOpts(dir, home));
    const c = find(report, 'environment.env.missing-key');
    expect(c?.result).toBe('unverified');
    expect(c?.evidence.join(' ')).toContain('schema');
  });

  it('environment.env.missing-key warns medium and lists names, never values', async () => {
    const dir = tmp();
    const home = tmp();
    writeJson(path.join(dir, 'forge.env.schema.json'), [
      { key: 'API_KEY', required: true, secret: true },
      { key: 'DB_URL', required: true },
    ]);
    writeFileSync(path.join(dir, '.env'), 'API_KEY=supersecretvalue123\n', 'utf8');
    const report = await runDoctor2(dir, baseOpts(dir, home));
    const c = find(report, 'environment.env.missing-key');
    expect(c?.result).toBe('warn');
    expect(c?.severity).toBe('medium');
    expect(c?.correctiveAction).toBe('restore missing keys');
    expect(c?.reversible).toBe(true);
    const ev = c?.evidence.join(' ') ?? '';
    expect(ev).toContain('DB_URL');
    expect(ev).not.toContain('supersecretvalue123');
  });

  it('environment.ports.conflict skips honestly when there is no .env', async () => {
    const dir = tmp();
    const home = tmp();
    const report = await runDoctor2(dir, baseOpts(dir, home));
    const c = find(report, 'environment.ports.conflict');
    expect(c?.result).toBe('skip');
    expect(c?.evidence.join(' ')).toContain('probing de socket');
  });
});

describe('hosts domain — honest detection/auth', () => {
  it('detected host without auth probe is unverified, absent host skips', async () => {
    const dir = tmp();
    const home = tmp();
    const adapters = hostAdapters(probe({ 'claude --version': 'claude 1.2.3' }));
    const report = await runDoctor2(dir, baseOpts(dir, home, { adapters }));
    const claude = find(report, 'hosts.claude.detected');
    expect(claude?.result).toBe('unverified');
    expect(claude?.evidence.join(' ')).toContain('no auth probe');
    expect(claude?.evidence.join(' ')).toContain('state=');
    expect(find(report, 'hosts.codex.detected')?.result).toBe('skip');
    expect(find(report, 'hosts.devin.detected')?.result).toBe('skip');
  });

  it('verified auth probe passes the check', async () => {
    const dir = tmp();
    const home = tmp();
    const adapters = hostAdapters(
      probe({ 'codex --version': '0.1.0', 'codex login status': 'Logged in' }),
    );
    const report = await runDoctor2(dir, baseOpts(dir, home, { adapters }));
    const c = find(report, 'hosts.codex.detected');
    expect(c?.result).toBe('pass');
    expect(c?.evidence).toContain('auth=verified');
  });
});

describe('operations domain — receipts, failures, recovery', () => {
  it('warns on recurring failures across state + receipts', async () => {
    const dir = tmp();
    const home = tmp();
    writeState(dir, { alpha: { status: 'error', detail: 'boom', at: NOW } });
    writeJson(path.join(dir, '.forge-cli', 'reports', 'forge-cli-20260101-000000.json'), {
      generatedAt: NOW,
      results: [{ repo: { name: 'alpha' }, status: 'error', detail: 'boom' }],
    });
    const report = await runDoctor2(dir, baseOpts(dir, home));
    const c = find(report, 'operations.failures.recurring');
    expect(c?.result).toBe('warn');
    expect(c?.evidence.join(' ')).toContain('alpha: 2 falha(s)');
  });

  it('warns on interrupted runs recorded in state.json', async () => {
    const dir = tmp();
    const home = tmp();
    writeState(dir, { beta: { status: 'warning', detail: 'x', at: NOW, phase: 'partial' } });
    const report = await runDoctor2(dir, baseOpts(dir, home));
    const c = find(report, 'operations.recovery.interrupted');
    expect(c?.result).toBe('warn');
    expect(c?.evidence.join(' ')).toContain('beta: partial → reinstall');
  });

  it('marks the report truncated when receipts exceed the scan bound', async () => {
    const dir = tmp();
    const home = tmp();
    for (let i = 0; i < 5; i++) {
      writeJson(path.join(dir, '.forge-cli', 'reports', `forge-cli-2026010${i}-000000.json`), {
        results: [],
      });
    }
    const report = await runDoctor2(dir, baseOpts(dir, home, { maxReceipts: 3 }));
    expect(report.truncated).toBe(true);
    expect(find(report, 'operations.receipts.recent')?.evidence.join(' ')).toContain(
      'analisados=3',
    );
  });
});

describe('health score — sufficiency gate', () => {
  it('value is null under insufficient evidence (never a fake 100)', () => {
    const score = computeHealthScore([
      {
        id: 'x',
        domain: 'system',
        result: 'pass',
        severity: 'info',
        diagnosis: 'd',
        evidence: ['e'],
        reversible: null,
        timestamp: NOW,
      },
    ]);
    expect(score.value).toBeNull();
    expect(score.sufficiency).toEqual({ required: 8, observed: 1, sufficient: false });
  });

  it('unverified checks do not count toward sufficiency', () => {
    const mk = (n: number) => ({
      id: `c${n}`,
      domain: 'system' as const,
      result: 'unverified' as const,
      severity: 'info' as const,
      diagnosis: 'd',
      evidence: ['e'],
      reversible: null,
      timestamp: NOW,
    });
    expect(
      computeHealthScore([mk(1), mk(2), mk(3), mk(4), mk(5), mk(6), mk(7), mk(8)]).value,
    ).toBeNull();
  });
});

describe('renderDoctorReport — PT-BR renderer', () => {
  it('renders title, check ids and evidence lines', async () => {
    const dir = tmp();
    const home = tmp();
    const report = await runDoctor2(dir, baseOpts(dir, home));
    const out = renderDoctorReport(report);
    expect(out).toContain('Diagnóstico Forge');
    expect(out).toContain('installation.forge-dir.absent');
    expect(out).toContain('evidência');
    expect(existsSync(path.join(dir, '.forge-cli'))).toBe(false); // renderer/engine mutated nothing
  });

  it('renders NÃO VERIFICADO instead of a fake score', () => {
    const report: DoctorReport = {
      schema: 'forge/DoctorReport/v1',
      generatedAt: NOW,
      checks: [],
      score: computeHealthScore([]),
      truncated: false,
    };
    const out = renderDoctorReport(report);
    expect(out).toContain('NÃO VERIFICADO');
    expect(out).not.toContain('/100');
  });
});

describe('doctor2/context — helpers compartilhados', () => {
  it('listDir retorna ordenado; ausente/ilegível → null (nunca lança)', async () => {
    const { listDir } = await import('../src/doctor2/context.js');
    const dir = tmp();
    writeFileSync(path.join(dir, 'b.txt'), 'x');
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    expect(listDir(dir)).toEqual(['a.txt', 'b.txt']);
    expect(listDir(path.join(dir, 'nope'))).toBeNull();
    expect(listDir(path.join(dir, 'a.txt'))).toBeNull(); // arquivo, não diretório
  });

  it('readJson: objeto ok; inválido/ausente → {ok:false,error}', async () => {
    const { readJson } = await import('../src/doctor2/context.js');
    const dir = tmp();
    const good = path.join(dir, 'ok.json');
    writeFileSync(good, '{"a":1}', 'utf8');
    expect(readJson(good)).toEqual({ ok: true, value: { a: 1 } });
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{oops', 'utf8');
    const r = readJson(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    expect(readJson(path.join(dir, 'missing.json')).ok).toBe(false);
  });

  it('boundEntries: ≤cap passa inteiro; acima trunca e marca o report', async () => {
    const { boundEntries } = await import('../src/doctor2/context.js');
    const ctx = {
      root: '',
      home: '',
      now: () => NOW,
      catalog: [],
      adapters: [],
      maxReceipts: 20,
      maxEntries: 3,
      state: null,
      truncated: { value: false },
    };
    expect(boundEntries(ctx, ['a', 'b'])).toEqual({ shown: ['a', 'b'], total: 2 });
    expect(ctx.truncated.value).toBe(false);
    const over = boundEntries(ctx, ['a', 'b', 'c', 'd', 'e']);
    expect(over.shown).toEqual(['a', 'b', 'c']);
    expect(over.total).toBe(5);
    expect(ctx.truncated.value).toBe(true);
  });

  it('mkCheck carimba o relógio injetado; errMsg preserva message', async () => {
    const { errMsg, mkCheck } = await import('../src/doctor2/context.js');
    const check = mkCheck(() => NOW, {
      id: 'x',
      domain: 'system',
      result: 'pass',
      severity: 'info',
      diagnosis: 'd',
      evidence: [],
      reversible: null,
    });
    expect(check.timestamp).toBe(NOW);
    expect(errMsg(new Error('boom'))).toBe('boom');
    expect(errMsg('plain')).toBe('plain');
  });
});
