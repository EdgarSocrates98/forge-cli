import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadForgeState,
  receiptPath,
  saveForgeState,
  type RegistryInstallReceipt,
  type RunLike,
} from '../src/registry/install.js';
import {
  localInstall,
  localRepair,
  localUninstall,
  localUpdate,
  type LocalDeps,
} from '../src/source/install.js';

let tmp: string;
let home: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'local-src-'));
  home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Fonte gitless instalável: forge.json + setup.sh + marcador de projeto. */
function makeSource(dir: string, forgeId = 'custom-forge', extra: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'forge.json'),
    JSON.stringify({ forge_id: forgeId, cli: 'custom-cli', version: '1.0.0' }),
  );
  writeFileSync(path.join(dir, 'setup.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "custom"\n');
  for (const [file, content] of Object.entries(extra)) {
    writeFileSync(path.join(dir, file), content);
  }
}

/**
 * RunLike fake: registra TODO spawn e simula o bootstrap — cria
 * `dist-marker/` dentro do cwd (artefato gerenciado) e responde ok ao
 * verify `<cli> --help`. Nenhum spawn real: zero git, zero rede.
 */
function fakeRun(opts: { verifyFail?: boolean } = {}): {
  run: RunLike;
  calls: { cmd: string; args: string[]; cwd?: string }[];
} {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const run: RunLike = async (cmd, args, runOpts) => {
    calls.push({ cmd, args, cwd: runOpts?.cwd });
    if (args.some((a) => a.includes('--help'))) {
      return { exitCode: opts.verifyFail ? 1 : 0, stderr: opts.verifyFail ? 'boom' : '' };
    }
    if (runOpts?.cwd) mkdirSync(path.join(runOpts.cwd, 'dist-marker'), { recursive: true });
    return { exitCode: 0 };
  };
  return { run, calls };
}

const deps = (run: RunLike): LocalDeps => ({
  home,
  run,
  yes: true,
  platform: 'linux' as NodeJS.Platform,
  now: () => '2026-01-02T03:04:05.000Z',
});

/** Todo spawn é inspecionável — git e rede nunca aparecem no caminho local. */
function expectNoGitOrNet(calls: { cmd: string; args: string[] }[]) {
  for (const c of calls) {
    const argv = [c.cmd, ...c.args].join(' ');
    expect(argv).not.toMatch(/\bgit\b/);
    expect(argv).not.toMatch(/\b(pip|npm|npx|curl|wget|fetch)\b/);
  }
}

describe('localInstall', () => {
  it('instala fonte gitless válida: receipt auditável + state persistido, zero git', async () => {
    const dir = path.join(tmp, 'zip-source');
    makeSource(dir);
    const { run, calls } = fakeRun();
    const out = await localInstall(dir, deps(run));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = out.receipt;
    expect(r.method).toBe('local');
    expect(r.install_method).toBe('local');
    expect(r.source_dir).toBe(path.resolve(dir));
    expect(r.is_git).toBe(false);
    expect(r.manifest_valid).toBe(true);
    expect(r.source_trust).toBe('B');
    expect(r.integrity).toBe('unverified');
    expect(r.execution_environment.platform).toBe('linux');
    expect(r.execution_environment.shell).toBe('sh');
    expect(r.setup_script).toBe('setup.sh');
    expect(r.managed_artifacts).toContain('dist-marker');
    expect(r.source_files).toContain('forge.json');
    expect(r.verify.ok).toBe(true);
    // Bootstrap + verify rodaram DENTRO da fonte.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c.cwd === path.resolve(dir))).toBe(true);
    expectNoGitOrNet(calls);
    // Persistência: install.json + state.json.
    expect(existsSync(receiptPath(home, 'custom-forge'))).toBe(true);
    const state = loadForgeState(home).forges['custom-forge'];
    expect(state?.method).toBe('local');
    expect(state && 'source_dir' in state ? state.source_dir : null).toBe(path.resolve(dir));
  });

  it('recusa manifesto inválido com FORGE-SOURCE-INVALID — zero escrita', async () => {
    const dir = path.join(tmp, 'bad');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'forge.json'), '{broken');
    const { run, calls } = fakeRun();
    const out = await localInstall(dir, deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-INVALID');
    expect(calls).toEqual([]); // recusa antes de qualquer spawn/escrita
    expect(loadForgeState(home).forges['custom-forge']).toBeUndefined();
  });

  it('recusa caminho inexistente com FORGE-SOURCE-NOT-FOUND', async () => {
    const { run, calls } = fakeRun();
    const out = await localInstall(path.join(tmp, 'missing'), deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-NOT-FOUND');
    expect(calls).toEqual([]);
  });

  it('fonte parcial exige confirmação — sem yes/confirm recusa FORGE-SOURCE-GITLESS', async () => {
    const dir = path.join(tmp, 'partial');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'forge.json'), JSON.stringify({ forge_id: 'part-forge' }));
    const { run, calls } = fakeRun();
    const d = deps(run);
    delete d.yes; // interativo sem confirmação
    const out = await localInstall(dir, d);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-GITLESS');
    expect(calls).toEqual([]);
  });

  it('receipt PyPI pré-existente é conflito nomeado — local não sobrescreve', async () => {
    const dir = path.join(tmp, 'src');
    makeSource(dir, 'api-forge');
    const state = loadForgeState(home);
    state.forges['api-forge'] = {
      forge: 'api-forge',
      method: 'pypi',
      dist: 'apiforge',
      version: '0.1.0',
      python: '3.12',
      source: 'latest-stable',
      venv: '/x',
      bin: '/x/bin/af',
      installedAt: '2026-01-01T00:00:00Z',
      verify: { command: ['af', '--help'], ok: true },
      files: [],
    } satisfies RegistryInstallReceipt;
    saveForgeState(home, state);
    const { run, calls } = fakeRun();
    const out = await localInstall(dir, deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-CONFLICT');
    expect(calls).toEqual([]);
    expect(loadForgeState(home).forges['api-forge']?.method).toBe('pypi');
  });

  it('verify pós-bootstrap falhando → FORGE-INSTALL-VERIFICATION-FAILED (receipt gravado)', async () => {
    const dir = path.join(tmp, 'src');
    makeSource(dir);
    const { run } = fakeRun({ verifyFail: true });
    const out = await localInstall(dir, deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-INSTALL-VERIFICATION-FAILED');
    // A instalação aconteceu — a falha é pós-bootstrap; receipt fica p/ diagnóstico.
    expect(loadForgeState(home).forges['custom-forge']?.method).toBe('local');
  });
});

describe('localUpdate — o diretório É a fonte mais nova', () => {
  it('reconcilia arquivos por substituição: novo copiado, removido só o registrado, usuário preservado', async () => {
    const v1 = path.join(tmp, 'v1');
    makeSource(v1, 'custom-forge', { 'old.py': 'v1', 'keep.py': 'a' });
    const { run, calls } = fakeRun();
    const d = deps(run);
    const inst = await localInstall(v1, d);
    expect(inst.ok).toBe(true);
    // Arquivo plantado pelo usuário DEPOIS do install — fora do snapshot.
    writeFileSync(path.join(v1, 'my-notes.txt'), 'do not touch');
    // Fonte mais nova: old.py some, new.py chega.
    const v2 = path.join(tmp, 'v2');
    makeSource(v2, 'custom-forge', { 'new.py': 'v2', 'keep.py': 'b' });
    const out = await localUpdate(v2, d);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(existsSync(path.join(v1, 'new.py'))).toBe(true); // copiado p/ a fonte registrada
    expect(existsSync(path.join(v1, 'old.py'))).toBe(false); // registrado e ausente na nova → sai
    expect(existsSync(path.join(v1, 'my-notes.txt'))).toBe(true); // usuário: intocado
    expect(out.receipt.history?.length).toBe(1);
    expect(out.receipt.source_files).toContain('new.py');
    expect(out.receipt.source_files).not.toContain('old.py');
    expectNoGitOrNet(calls);
  });

  it('update sem receipt local → FORGE-SOURCE-NOT-FOUND', async () => {
    const dir = path.join(tmp, 'v2');
    makeSource(dir, 'ghost-forge');
    const { run, calls } = fakeRun();
    const out = await localUpdate(dir, deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-NOT-FOUND');
    expect(calls).toEqual([]);
  });
});

describe('localRepair / localUninstall — preservação da fonte', () => {
  it('repair re-executa bootstrap sem git/rede; artefato gerenciado regenerado', async () => {
    const dir = path.join(tmp, 'src');
    makeSource(dir);
    const { run, calls } = fakeRun();
    const d = deps(run);
    await localInstall(dir, d);
    rmSync(path.join(dir, 'dist-marker'), { recursive: true }); // artefato quebrado
    writeFileSync(path.join(dir, 'user.txt'), 'mine');
    const out = await localRepair('custom-forge', d);
    expect(out.ok).toBe(true);
    expect(existsSync(path.join(dir, 'dist-marker'))).toBe(true); // re-criado pelo bootstrap fake
    expect(existsSync(path.join(dir, 'user.txt'))).toBe(true);
    expectNoGitOrNet(calls);
  });

  it('repair de fonte ausente → FORGE-SOURCE-NOT-FOUND', async () => {
    const dir = path.join(tmp, 'src');
    makeSource(dir);
    const { run } = fakeRun();
    const d = deps(run);
    await localInstall(dir, d);
    rmSync(dir, { recursive: true, force: true });
    const out = await localRepair('custom-forge', d);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-NOT-FOUND');
  });

  it('uninstall remove só artefatos gerenciados + receipt — fonte e arquivos ficam', async () => {
    const dir = path.join(tmp, 'src');
    makeSource(dir);
    const { run, calls } = fakeRun();
    const d = deps(run);
    await localInstall(dir, d);
    writeFileSync(path.join(dir, 'user.txt'), 'mine');
    const out = await localUninstall('custom-forge', d);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.removed).toContain('dist-marker');
    expect(existsSync(dir)).toBe(true); // a fonte NUNCA é apagada
    expect(existsSync(path.join(dir, 'forge.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'setup.sh'))).toBe(true);
    expect(existsSync(path.join(dir, 'user.txt'))).toBe(true);
    expect(existsSync(path.join(dir, 'dist-marker'))).toBe(false); // gerenciado sai
    expect(existsSync(receiptPath(home, 'custom-forge'))).toBe(false);
    expect(loadForgeState(home).forges['custom-forge']).toBeUndefined();
    expectNoGitOrNet(calls);
  });

  it('uninstall de receipt PyPI → recusa FORGE-SOURCE-INVALID (rota registry)', async () => {
    const state = loadForgeState(home);
    state.forges['api-forge'] = {
      forge: 'api-forge',
      method: 'pypi',
      dist: 'apiforge',
      version: '0.1.0',
      python: '3.12',
      source: 'latest-stable',
      venv: '/x',
      bin: '/x/bin/af',
      installedAt: '2026-01-01T00:00:00Z',
      verify: { command: ['af', '--help'], ok: true },
      files: [],
    } satisfies RegistryInstallReceipt;
    saveForgeState(home, state);
    const { run, calls } = fakeRun();
    const out = await localUninstall('api-forge', deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-INVALID');
    expect(calls).toEqual([]);
    expect(loadForgeState(home).forges['api-forge']).toBeDefined(); // intocado
  });
});
