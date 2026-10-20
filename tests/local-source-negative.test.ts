/**
 * Matriz de recusa da fonte local (lf-0019 A1) — um teste por recusa
 * FORGE-*, com a prova de que nenhuma escrita/spawn precedeu a saída
 * nomeada. Os positivos vivem em local-source.test.ts; aqui só o lado
 * negativo + o comportamento defensivo (traversal em managed_artifacts).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadForgeState,
  saveForgeState,
  type LocalInstallReceipt,
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
import { detectSource } from '../src/source/detect.js';

let tmp: string;
let home: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'local-neg-'));
  home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  try {
    chmodSync(tmp, 0o755);
    chmodSync(path.join(tmp, 'src'), 0o755);
  } catch {
    /* já removido ou não criado */
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

/** Fonte gitless instalável mínima (forge.json + setup.sh + marcador). */
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

function fakeRun(opts: { verifyFail?: boolean; setupExit?: number } = {}): {
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
    return { exitCode: opts.setupExit ?? 0 };
  };
  return { run, calls };
}

const deps = (run: RunLike, extra: Partial<LocalDeps> = {}): LocalDeps => ({
  home,
  run,
  yes: true,
  platform: 'linux' as NodeJS.Platform,
  now: () => '2026-01-02T03:04:05.000Z',
  ...extra,
});

/** Receipt local mínimo gravado direto no state (testes de lifecycle). */
function seedLocalReceipt(dir: string, managedArtifacts: string[] = ['dist-marker']) {
  const receipt: LocalInstallReceipt = {
    forge: 'custom-forge',
    method: 'local',
    install_method: 'local',
    dist: 'custom',
    version: '1.0.0',
    installedAt: '2026-01-01T00:00:00Z',
    verify: { command: ['custom-cli', '--help'], ok: true },
    files: [],
    source_dir: path.resolve(dir),
    is_git: false,
    source_trust: 'B',
    manifest_valid: true,
    integrity: 'unverified',
    execution_environment: { platform: 'linux', arch: 'x64', node: 'v22', shell: 'sh' },
    source_state: 'GITLESS_VALID_FORGE',
    setup_script: 'setup.sh',
    managed_artifacts: managedArtifacts,
    source_files: ['forge.json', 'setup.sh', 'pyproject.toml'],
  };
  const state = loadForgeState(home);
  state.forges['custom-forge'] = receipt;
  saveForgeState(home, state);
  return receipt;
}

describe('localInstall — matriz de recusa (zero escrita antes da saída)', () => {
  it('CONFLICTING_IDENTITY → FORGE-SOURCE-CONFLICT sem spawn', async () => {
    // basename 'api-forge' (catálogo) com forge_id divergente — detecção
    // já prova a contradição; a instalação recusa sem tocar em nada.
    const dir = path.join(tmp, 'api-forge');
    makeSource(dir, 'custom-forge');
    expect(detectSource(dir).state).toBe('CONFLICTING_IDENTITY');
    const { run, calls } = fakeRun();
    const out = await localInstall(dir, deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-CONFLICT');
    expect(calls).toEqual([]);
    expect(loadForgeState(home).forges['custom-forge']).toBeUndefined();
  });

  it('UNTRUSTED_SOURCE (fonte por symlink) → FORGE-SOURCE-INVALID sem spawn', async () => {
    const real = path.join(tmp, 'real-src');
    makeSource(real);
    const link = path.join(tmp, 'linked-src');
    symlinkSync(real, link, 'dir');
    const { run, calls } = fakeRun();
    const out = await localInstall(link, deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detection?.state).toBe('UNTRUSTED_SOURCE');
    expect(out.failure.code).toBe('FORGE-SOURCE-INVALID');
    expect(calls).toEqual([]);
  });

  it('GIT_REPOSITORY sem forge.json → FORGE-SOURCE-INVALID ANTES do bootstrap', async () => {
    // Repo git sem manifesto: o detector aceita (o fluxo git cuida), mas
    // a rota local não pode nomear o receipt — a recusa precisa sair sem
    // executar script nenhum (antes da guarda o bootstrap rodava e a
    // persistência quebrava com `forge: undefined`).
    const dir = path.join(tmp, 'git-no-manifest');
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    writeFileSync(path.join(dir, 'setup.sh'), '#!/bin/sh\nexit 0\n');
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    const det = detectSource(dir);
    expect(det.state).toBe('GIT_REPOSITORY');
    expect(det.forge_id).toBeUndefined();
    const { run, calls } = fakeRun();
    const out = await localInstall(dir, deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-INVALID');
    expect(calls).toEqual([]);
    expect(existsSync(path.join(dir, 'dist-marker'))).toBe(false); // bootstrap nunca rodou
  });

  it('UNKNOWN_DIRECTORY existente (sem .git e sem forge.json) → FORGE-SOURCE-NOT-FOUND', async () => {
    const dir = path.join(tmp, 'just-a-folder');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'README.md'), 'hello\n');
    const { run, calls } = fakeRun();
    const out = await localInstall(dir, deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detection?.state).toBe('UNKNOWN_DIRECTORY');
    expect(out.failure.code).toBe('FORGE-SOURCE-NOT-FOUND');
    expect(calls).toEqual([]);
  });

  it('piso do manifesto acima do interpretador selecionado → FORGE-PYTHON-INCOMPATIBLE sem escrita', async () => {
    const dir = path.join(tmp, 'floor');
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, 'forge.json'),
      JSON.stringify({ forge_id: 'floor-forge', version: '1.0.0', python: '>=3.12' }),
    );
    writeFileSync(path.join(dir, 'setup.sh'), '#!/bin/sh\nexit 0\n');
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    const { run, calls } = fakeRun();
    const out = await localInstall(
      dir,
      deps(run, {
        python: { argv: ['/usr/bin/python3.10'], version: '3.10.14', source: 'path' },
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-PYTHON-INCOMPATIBLE');
    expect(calls).toEqual([]);
    expect(loadForgeState(home).forges['floor-forge']).toBeUndefined();
  });

  it('pipeline de Python recusado (stub loja) → código FORGE-PYTHON-* propagado, não SOURCE-INVALID', async () => {
    // Fonte válida mas SEM nenhum script e SEM bootstrap — a causa real
    // é a descoberta de interpretador; o código tem de sobreviver.
    const dir = path.join(tmp, 'no-script');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'forge.json'), JSON.stringify({ forge_id: 'nostub-forge' }));
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    const { run, calls } = fakeRun();
    const out = await localInstall(
      dir,
      deps(run, {
        python: null,
        pythonIssue: {
          code: 'FORGE-PYTHON-UNEXECUTABLE',
          cause: 'candidatos encontrados mas nenhum executa (ex.: stub da Microsoft Store)',
          remedy: 'instale um interpretador real ou aponte --python',
        },
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-PYTHON-UNEXECUTABLE');
    expect(out.failure.cause).toContain('FORGE-PYTHON-UNEXECUTABLE');
    expect(calls).toEqual([]);
  });

  it('python null + sem script e sem issue → FORGE-SOURCE-INVALID (fonte incompleta)', async () => {
    const dir = path.join(tmp, 'bare');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'forge.json'), JSON.stringify({ forge_id: 'bare-forge' }));
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    const { run } = fakeRun();
    const out = await localInstall(dir, deps(run, { python: null, pythonIssue: null }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-INVALID');
  });

  it('winShells={} (sondado, nada executa) + scripts presentes → FORGE-SHELL-NOT-FOUND', async () => {
    // setup.ps1 existe mas não há condutor .ps1; install.windows.sh
    // existe mas Git Bash não executa → a rota é a recusa, não o script.
    const dir = path.join(tmp, 'win-noshell');
    makeSource(dir, 'win-forge', { 'setup.ps1': 'Write-Host ok', 'install.windows.sh': 'true' });
    const { run, calls } = fakeRun();
    const out = await localInstall(dir, deps(run, { platform: 'win32', winShells: {} }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SHELL-NOT-FOUND');
    expect(calls).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'diretório somente-leitura → FORGE-ENV-PERSISTENCE-FAILED (POSIX, não-root)',
    async () => {
      const dir = path.join(tmp, 'readonly-src');
      makeSource(dir, 'ro-forge', { '.env.example': 'A=1\n' });
      chmodSync(dir, 0o555);
      const { run, calls } = fakeRun();
      try {
        const out = await localInstall(dir, deps(run));
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.failure.code).toBe('FORGE-ENV-PERSISTENCE-FAILED');
        // O bootstrap NUNCA roda quando o provisionamento recusa.
        expect(calls).toEqual([]);
        expect(existsSync(path.join(dir, 'dist-marker'))).toBe(false);
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  it('script sai não-zero → falha operacional SEM code (não é recusa nomeada)', async () => {
    const dir = path.join(tmp, 'src');
    makeSource(dir);
    const { run } = fakeRun({ setupExit: 3 });
    const out = await localInstall(dir, deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBeUndefined();
    expect(out.failure.cause).toContain('código 3');
    // Falha operacional não grava receipt.
    expect(loadForgeState(home).forges['custom-forge']).toBeUndefined();
  });
});

describe('localUpdate — recusas da fonte mais nova', () => {
  it('fonte nova INVALID_MANIFEST → FORGE-SOURCE-INVALID sem reconciliar', async () => {
    const v1 = path.join(tmp, 'v1');
    makeSource(v1);
    const { run, calls } = fakeRun();
    const d = deps(run);
    expect((await localInstall(v1, d)).ok).toBe(true);
    writeFileSync(path.join(v1, 'old.py'), 'v1');
    const v2 = path.join(tmp, 'v2');
    mkdirSync(v2);
    writeFileSync(path.join(v2, 'forge.json'), '{broken');
    const out = await localUpdate(v2, d);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-INVALID');
    // Nada foi reconciliado na fonte registrada e nenhum spawn aconteceu
    // no update — os 2 calls são bootstrap+verify do install inicial.
    expect(existsSync(path.join(v1, 'old.py'))).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('receipt registry (pypi) com mesmo forge_id → FORGE-SOURCE-NOT-FOUND apontando rota registry', async () => {
    const state = loadForgeState(home);
    state.forges['custom-forge'] = {
      forge: 'custom-forge',
      method: 'pypi',
      dist: 'custom',
      version: '0.1.0',
      python: '3.12',
      source: 'latest-stable',
      venv: '/x',
      bin: '/x/bin/custom-cli',
      installedAt: '2026-01-01T00:00:00Z',
      verify: { command: ['custom-cli', '--help'], ok: true },
      files: [],
    } satisfies RegistryInstallReceipt;
    saveForgeState(home, state);
    const dir = path.join(tmp, 'v2');
    makeSource(dir);
    const { run, calls } = fakeRun();
    const out = await localUpdate(dir, deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-NOT-FOUND');
    expect(out.failure.remedy).toContain('--method registry');
    expect(calls).toEqual([]);
  });

  it('fonte registrada apagada entre install e update → FORGE-SOURCE-NOT-FOUND', async () => {
    const v1 = path.join(tmp, 'v1');
    makeSource(v1);
    const { run } = fakeRun();
    const d = deps(run);
    expect((await localInstall(v1, d)).ok).toBe(true);
    rmSync(v1, { recursive: true, force: true }); // fonte original sumiu
    const v2 = path.join(tmp, 'v2');
    makeSource(v2);
    const out = await localUpdate(v2, d);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-NOT-FOUND');
  });

  it('win32 sem shells na fonte atualizada → FORGE-SHELL-NOT-FOUND', async () => {
    const v1 = path.join(tmp, 'v1');
    makeSource(v1);
    const { run } = fakeRun();
    const d = deps(run);
    expect((await localInstall(v1, d)).ok).toBe(true);
    // Fonte nova sem nenhum script + sonda win32 vazia → rota inexistente.
    const v2 = path.join(tmp, 'v2');
    mkdirSync(v2);
    writeFileSync(
      path.join(v2, 'forge.json'),
      JSON.stringify({ forge_id: 'custom-forge', version: '2.0.0' }),
    );
    writeFileSync(path.join(v2, 'pyproject.toml'), '[project]\nname = "x"\n');
    const out = await localUpdate(v2, { ...d, platform: 'win32', winShells: {}, python: null });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SHELL-NOT-FOUND');
  });

  it('verify falhando após update → FORGE-INSTALL-VERIFICATION-FAILED (receipt atualizado)', async () => {
    const v1 = path.join(tmp, 'v1');
    makeSource(v1);
    const okRun = fakeRun();
    const d = deps(okRun.run);
    expect((await localInstall(v1, d)).ok).toBe(true);
    const v2 = path.join(tmp, 'v2');
    makeSource(v2);
    // Mesmo dir (sem reconciliação) para isolar o verify do update.
    const { run } = fakeRun({ verifyFail: true });
    const out = await localUpdate(v1, { ...d, run });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-INSTALL-VERIFICATION-FAILED');
    expect(loadForgeState(home).forges['custom-forge']?.method).toBe('local');
  });
});

describe('localRepair / localUninstall — recusas e segurança', () => {
  it('repair sem receipt → FORGE-SOURCE-NOT-FOUND', async () => {
    const { run, calls } = fakeRun();
    const out = await localRepair('ghost', deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-NOT-FOUND');
    expect(calls).toEqual([]);
  });

  it('repair em win32 sem shells e sem script → FORGE-SHELL-NOT-FOUND', async () => {
    const dir = path.join(tmp, 'src');
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, 'forge.json'),
      JSON.stringify({ forge_id: 'custom-forge', version: '1.0.0' }),
    );
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    seedLocalReceipt(dir);
    const { run, calls } = fakeRun();
    const out = await localRepair(
      'custom-forge',
      deps(run, { platform: 'win32', winShells: {}, python: null }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SHELL-NOT-FOUND');
    expect(calls).toEqual([]);
  });

  it('verify do repair falhando → FORGE-INSTALL-VERIFICATION-FAILED', async () => {
    const dir = path.join(tmp, 'src');
    makeSource(dir);
    seedLocalReceipt(dir);
    const { run } = fakeRun({ verifyFail: true });
    const out = await localRepair('custom-forge', deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-INSTALL-VERIFICATION-FAILED');
  });

  it('uninstall de nome desconhecido → FORGE-SOURCE-NOT-FOUND', async () => {
    const { run } = fakeRun();
    const out = await localUninstall('ghost', deps(run));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.code).toBe('FORGE-SOURCE-NOT-FOUND');
  });

  it('managed_artifacts com traversal (../escape.txt) NUNCA deleta fora da fonte', async () => {
    // Tentativa de apagar arquivo plantado do usuário FORA da fonte via
    // receipt malformado — safeJoinInside bloqueia e o arquivo sobrevive.
    const dir = path.join(tmp, 'src');
    makeSource(dir);
    const planted = path.join(tmp, 'escape.txt'); // fora de src/
    writeFileSync(planted, 'não é nosso');
    seedLocalReceipt(dir, ['../escape.txt', 'dist-marker', '..\\win-escape.txt']);
    mkdirSync(path.join(dir, 'dist-marker'), { recursive: true });
    const { run } = fakeRun();
    const out = await localUninstall('custom-forge', deps(run));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(existsSync(planted)).toBe(true); // traversal bloqueado
    expect(out.removed).not.toContain('../escape.txt');
    expect(out.removed).toContain('dist-marker');
    expect(existsSync(path.join(dir, 'dist-marker'))).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('repair ignora managed_artifacts com traversal antes do bootstrap', async () => {
    const dir = path.join(tmp, 'src');
    makeSource(dir);
    const planted = path.join(tmp, 'user-owned.txt');
    writeFileSync(planted, 'meu');
    seedLocalReceipt(dir, ['../user-owned.txt']);
    const { run } = fakeRun();
    const out = await localRepair('custom-forge', deps(run));
    expect(out.ok).toBe(true);
    expect(existsSync(planted)).toBe(true); // intocado pelo ciclo de remoção
    expect(existsSync(path.join(dir, 'dist-marker'))).toBe(true); // bootstrap rodou
  });
});
