/**
 * E2E do ciclo de vida gitless (lf-0019 A2/A3) — processo real do CLI,
 * home hermético, fonte simulando um ZIP do GitHub extraído
 * (`acme-forge-1.0.0/` SEM `.git`):
 *
 *   install → status/doctor enxergam → update por diretório mais novo →
 *   repair recria artefatos → uninstall remove só os gerenciados.
 *
 * Invariante forte: `git` é substituído por um STUB de PATH que registra
 * toda invocação — o caminho gitless inteiro (incluindo status/doctor)
 * deve sair com ZERO operação git de repo. No Windows a sonda de shells
 * pode rodar `git --exec-path` para localizar o Git Bash empacotado —
 * probe de descoberta (argv sem repo), único padrão permitido.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'index.ts');
const ANSI = new RegExp(String.raw`\u001B\[[0-9;]*m`, 'g');

let ws: string;
let home: string;
let stubBin: string;
let gitLog: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), 'forge-gitless-ws-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'forge-gitless-home-'));
  stubBin = path.join(ws, 'stub-bin');
  gitLog = path.join(ws, 'git-stub.log');
  mkdirSync(stubBin, { recursive: true });
  // Stub POSIX (`git`) + Windows (`git.cmd`/`git.bat`): loga e falha —
  // qualquer operação git real ficaria registrada E quebraria o fluxo.
  writeFileSync(path.join(stubBin, 'git'), '#!/bin/sh\necho "git $*" >> "$GIT_STUB_LOG"\nexit 1\n');
  chmodSync(path.join(stubBin, 'git'), 0o755);
  writeFileSync(
    path.join(stubBin, 'git.cmd'),
    '@echo off\r\necho git %* >> "%GIT_STUB_LOG%"\r\nexit /b 1\r\n',
  );
});

afterEach(() => {
  for (const d of [ws, home])
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Spawns o CLI real com home isolado e o stub de git primeiro no PATH. */
async function cli(...args: string[]) {
  const res = await execa('node', ['--import', 'tsx', ENTRY, ...args], {
    cwd: ROOT,
    reject: false,
    timeout: 90_000,
    stdin: 'ignore',
    env: {
      HOME: home,
      USERPROFILE: home,
      FORGE_CLI_HOME: home,
      FORCE_COLOR: '0',
      GIT_STUB_LOG: gitLog,
      PATH: `${stubBin}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    extendEnv: true,
  });
  const out = `${res.stdout}\n${res.stderr}`.replace(ANSI, '');
  const stdout = res.stdout.replace(ANSI, '');
  return { code: res.exitCode ?? -1, out, stdout };
}

/**
 * Fonte "ZIP extraído": forge.json + scripts + marcador de projeto —
 * deliberadamente SEM `.git`. `acme-forge` não está no catálogo, então
 * o nome do diretório não dispara CONFLICTING_IDENTITY.
 */
function makeZipLikeSource(dir: string, version: string, files: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'forge.json'),
    JSON.stringify({ forge_id: 'acme-forge', version, python: '>=3.10' }),
  );
  writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "acme"\n');
  writeFileSync(path.join(dir, '.env.example'), '# ACME_KEY=\n');
  // Bootstrap POSIX real (roda no install) — cria artefatos gerenciados.
  writeFileSync(
    path.join(dir, 'setup.sh'),
    '#!/bin/sh\nmkdir -p .venv/bin dist-marker\necho ok > .venv/bin/acme-ready\n',
  );
  // Rota Git Bash no Windows (a mesma convenção das Forjas reais).
  writeFileSync(
    path.join(dir, 'install.windows.sh'),
    '#!/usr/bin/env bash\nmkdir -p .venv/bin dist-marker\necho ok > .venv/bin/acme-ready\n',
  );
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, file), content);
  }
}

/** Linhas do log do stub que NÃO são probes de descoberta permitidos. */
function gitRepoOps(): string[] {
  if (!existsSync(gitLog)) return [];
  return readFileSync(gitLog, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .filter((l) => !/^git "?--(exec-path|version)/.test(l.trim()));
}

describe('E2E gitless — ciclo de vida completo (processo real)', { timeout: 300_000 }, () => {
  it('install→status→doctor→update→repair→uninstall sem nenhuma operação git', async () => {
    const v1 = path.join(ws, 'acme-forge-1.0.0');
    makeZipLikeSource(v1, '1.0.0', { 'app.py': 'v1\n', 'obsolete.py': 'gone\n' });

    // 1) install — exit 0, JSON local, receipt persistido.
    const inst = await cli('install', v1, '--yes', '--json');
    expect(inst.code).toBe(0);
    const instDoc = JSON.parse(inst.stdout);
    expect(instDoc.method).toBe('local');
    expect(instDoc.results[0].ok).toBe(true);
    expect(instDoc.results[0].forge).toBe('acme-forge');
    expect(instDoc.results[0].is_git).toBe(false);
    expect(instDoc.results[0].source_trust).toBe('B');
    const receipt = JSON.parse(
      readFileSync(path.join(home, '.forge-cli', 'forges', 'acme-forge', 'install.json'), 'utf8'),
    );
    expect(receipt.install_method).toBe('local');
    expect(receipt.is_git).toBe(false);
    expect(receipt.source_state).toBe('GITLESS_VALID_FORGE');
    expect(receipt.manifest_valid).toBe(true);
    expect(receipt.managed_artifacts).toEqual(
      expect.arrayContaining(['.env', '.venv', 'dist-marker']),
    );
    expect(receipt.source_files).toEqual(
      expect.arrayContaining(['forge.json', 'setup.sh', 'app.py']),
    );
    expect(receipt.source_files).not.toContain('.env');
    expect(existsSync(path.join(v1, '.venv', 'bin', 'acme-ready'))).toBe(true);

    // 2) status enxerga a instalação local sem consultar git.
    const st = await cli('status', '--dir', path.join(ws, 'workspace'), '--json');
    expect(st.code).toBe(0);
    const stDoc = JSON.parse(st.stdout) as {
      name: string;
      phase: string;
      install_method?: string;
      is_git?: boolean;
    }[];
    const row = stDoc.find((i) => i.name === 'acme-forge');
    expect(row?.phase).toBe('installed');
    expect(row?.install_method).toBe('local');
    expect(row?.is_git).toBe(false);

    // 3) doctor 2.0 — o check dedicado de fontes locais passa.
    const doc = await cli('doctor', '--dir', path.join(ws, 'workspace'), '--json');
    expect([0, 1]).toContain(doc.code);
    const report = JSON.parse(doc.stdout) as {
      checks: { id: string; result: string; evidence?: string[] }[];
    };
    const localCheck = report.checks.find((c) => c.id === 'installation.local-sources.present');
    expect(localCheck?.result).toBe('pass');
    expect((localCheck?.evidence ?? []).join('\n')).toContain('acme-forge');

    // 4) update por diretório mais novo — reconcilia na fonte original.
    const v2 = path.join(ws, 'acme-forge-2.0.0');
    makeZipLikeSource(v2, '2.0.0', { 'app.py': 'v2\n', 'new-feature.py': 'new\n' });
    const upd = await cli('update', v2, '--yes', '--json');
    expect(upd.code).toBe(0);
    const updDoc = JSON.parse(upd.stdout);
    expect(updDoc.results[0].ok).toBe(true);
    expect(readFileSync(path.join(v1, 'app.py'), 'utf8')).toBe('v2\n'); // atualizado
    expect(existsSync(path.join(v1, 'new-feature.py'))).toBe(true); // copiado
    expect(existsSync(path.join(v1, 'obsolete.py'))).toBe(false); // registrado e ausente → saiu
    const receipt2 = JSON.parse(
      readFileSync(path.join(home, '.forge-cli', 'forges', 'acme-forge', 'install.json'), 'utf8'),
    );
    expect(receipt2.version).toBe('2.0.0');
    expect(receipt2.history?.length).toBe(1);
    expect(receipt2.history[0].version).toBe('1.0.0');

    // 5) repair recria artefato gerenciado removido.
    rmSync(path.join(v1, 'dist-marker'), { recursive: true, force: true });
    writeFileSync(path.join(v1, 'user-notes.txt'), 'arquivo do usuário — nunca tocar\n');
    const rep = await cli('reinstall', 'acme-forge', '--yes', '--json');
    expect(rep.code).toBe(0);
    expect(existsSync(path.join(v1, 'dist-marker'))).toBe(true);
    expect(existsSync(path.join(v1, 'user-notes.txt'))).toBe(true);

    // 6) uninstall — só managed_artifacts saem; fonte e arquivo ficam.
    const un = await cli('uninstall', 'acme-forge', '--yes', '--json');
    expect(un.code).toBe(0);
    const unDoc = JSON.parse(un.stdout);
    expect(unDoc.results[0].ok).toBe(true);
    expect(unDoc.results[0].removed).toEqual(
      expect.arrayContaining(['.env', '.venv', 'dist-marker']),
    );
    expect(existsSync(path.join(v1, '.venv'))).toBe(false);
    expect(existsSync(path.join(v1, 'dist-marker'))).toBe(false);
    expect(existsSync(path.join(v1, 'forge.json'))).toBe(true); // fonte inteira
    expect(existsSync(path.join(v1, 'user-notes.txt'))).toBe(true); // usuário
    expect(existsSync(path.join(home, '.forge-cli', 'forges', 'acme-forge'))).toBe(false);

    // 7) Invariante A3: nenhuma operação git de repo em TODO o ciclo
    //    (probes `git --exec-path`/`--version` da descoberta são ok —
    //    win32 os usa para LOCALIZAR o Git Bash, nunca contra a fonte).
    expect(gitRepoOps()).toEqual([]);
  });

  it('install --method git em fonte sem .git → FORGE-SOURCE-GITLESS (exit 2, zero mutação)', async () => {
    const dir = path.join(ws, 'acme-forge-1.0.0');
    makeZipLikeSource(dir, '1.0.0');
    const res = await cli('install', dir, '--method', 'git', '--yes', '--json');
    expect(res.code).toBe(2);
    expect(res.out).toContain('FORGE-SOURCE-GITLESS');
    expect(existsSync(path.join(home, '.forge-cli', 'forges', 'acme-forge'))).toBe(false);
    expect(gitRepoOps()).toEqual([]);
  });

  it('update <nome> de fonte local → FORGE-SOURCE-GITLESS com a rota correta (exit 2)', async () => {
    const dir = path.join(ws, 'acme-forge-1.0.0');
    makeZipLikeSource(dir, '1.0.0');
    expect((await cli('install', dir, '--yes')).code).toBe(0);
    const res = await cli('update', 'acme-forge', '--yes');
    expect(res.code).toBe(2);
    expect(res.out).toContain('FORGE-SOURCE-GITLESS');
    expect(res.out).toContain(dir); // o remédio aponta o diretório-fonte
    expect(gitRepoOps()).toEqual([]);
  });
});
