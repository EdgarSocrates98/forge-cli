import { execFileSync } from 'node:child_process';
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
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'index.ts');
const ANSI = new RegExp(String.raw`\u001B\[[0-9;]*m`, 'g');

let ws: string;
let home: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-e2e-ws-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-e2e-home-'));
});
afterEach(() => {
  for (const d of [ws, home])
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function cli(...args: string[]) {
  const res = await execa('node', ['--import', 'tsx', ENTRY, ...args], {
    cwd: ROOT,
    reject: false,
    timeout: 60_000,
    stdin: 'ignore',
    env: { HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
    extendEnv: true,
  });
  const out = `${res.stdout}\n${res.stderr}`.replace(ANSI, '');
  const stdout = res.stdout.replace(ANSI, '');
  return { code: res.exitCode ?? -1, out, stdout };
}

function fakeClone(name: string, url: string): string {
  const dir = path.join(ws, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('remote', 'add', 'origin', url);
  writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

describe('CLI ponta a ponta (processo real, diretórios temporários)', { timeout: 180_000 }, () => {
  it('help e comando desconhecido', async () => {
    const help = await cli('help');
    expect(help.code).toBe(0);
    expect(help.out).toContain('forge-cli');
    const bogus = await cli('bogus');
    expect(bogus.code).toBe(2);
    expect(bogus.out).toContain('Comando desconhecido');
  });

  it('status lista as 8 Forjas como não clonadas sem criar nada', async () => {
    const res = await cli('status', '--dir', ws);
    expect(res.code).toBe(0);
    expect(res.out.match(/não clonado/g)).toHaveLength(8);
    expect(readdirSync(ws)).toEqual([]);
  });

  it('components mostra instalador nativo e Forjas sem suporte', async () => {
    const res = await cli('components', 'api-forge', 'forge-portal', '--dir', ws);
    expect(res.code).toBe(0);
    expect(res.out).toContain('apiforge install');
    expect(res.out).toContain('sem instalador nativo');
  });

  it('valida argumentos antes de qualquer operação', async () => {
    expect((await cli('clone', '--dir', ws)).code).toBe(2);
    expect((await cli('install', 'nao-existe', '--dir', ws, '--yes')).code).toBe(2);
    expect((await cli('install', 'api-forge', '--ref', 'a', '--version', 'b')).code).toBe(2);
    expect(
      (await cli('install', 'api-forge', 'the-forge', '--ref', 'v1', '--plan', '--dir', ws)).code,
    ).toBe(2);
    expect((await cli('install', 'api-forge', '--profile', 'max', '--dir', ws)).code).toBe(2);
    expect(readdirSync(ws)).toEqual([]);
  });

  it('uninstall mostra o plano, só remove com --yes e faz backup do .env', async () => {
    const dir = fakeClone('the-forge', 'https://github.com/EdgarSocrates98/the-forge');
    writeFileSync(path.join(dir, '.env'), 'SECRET=1');

    const plan = await cli('uninstall', 'the-forge', '--dir', ws);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain('--yes');
    expect(existsSync(dir)).toBe(true);

    const run = await cli('uninstall', 'the-forge', '--yes', '--dir', ws);
    expect(run.code).toBe(0);
    expect(existsSync(dir)).toBe(false);
    const backups = path.join(ws, '.forge-cli', 'backups');
    const [entry] = readdirSync(backups);
    expect(readFileSync(path.join(backups, entry, '.env'), 'utf8')).toBe('SECRET=1');
  });

  it('uninstall recusa remote que não é do catálogo', async () => {
    const dir = fakeClone('the-forge', 'https://github.com/evil/the-forge');
    const res = await cli('uninstall', 'the-forge', '--yes', '--dir', ws);
    expect(res.code).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });

  it('pin e unpin persistem no estado do workspace', async () => {
    expect((await cli('pin', 'api-forge', '--version', 'v1.2.0', '--dir', ws)).code).toBe(0);
    const state = JSON.parse(readFileSync(path.join(ws, '.forge-cli', 'state.json'), 'utf8'));
    expect(state.pins['api-forge']).toBe('v1.2.0');
    expect((await cli('unpin', 'api-forge', '--dir', ws)).code).toBe(0);
    const after = JSON.parse(readFileSync(path.join(ws, '.forge-cli', 'state.json'), 'utf8'));
    expect(after.pins['api-forge']).toBeUndefined();
  });

  it('update --check em workspace vazio não falha e não altera nada', async () => {
    const res = await cli('update', '--check', '--dir', ws);
    expect(res.code).toBe(0);
    expect(readdirSync(ws)).toEqual([]);
  });

  it('clone --offline não toca na rede e reporta erro claro', async () => {
    const res = await cli('clone', 'api-forge', '--offline', '--dir', ws);
    expect(res.code).toBe(1);
    expect(res.out).toContain('offline');
    expect(existsSync(path.join(ws, 'api-forge'))).toBe(false);
  });

  it('self update por código-fonte mostra o passo manual e não executa nada', async () => {
    const res = await cli('self', 'update');
    expect(res.code).toBe(0);
    expect(res.out).toContain('git pull');
  });

  it('self install/uninstall usam o HOME informado e não tocam no workspace', async () => {
    if (process.platform === 'win32') return; // no Windows alteraria o PATH real do usuário
    const dir = fakeClone('the-forge', 'https://github.com/EdgarSocrates98/the-forge');
    await cli('self', 'install');
    expect(existsSync(path.join(home, '.forge-cli', 'bin'))).toBe(true);
    await cli('self', 'uninstall');
    expect(existsSync(path.join(home, '.forge-cli', 'bin'))).toBe(false);
    expect(existsSync(path.join(dir, '.git'))).toBe(true);
  });
});

describe('saída --json dos comandos de consulta', { timeout: 180_000 }, () => {
  it('status --json imprime só JSON (sem banner)', async () => {
    const res = await cli('status', '--json', '--dir', ws);
    expect(res.code).toBe(0);
    const data = JSON.parse(res.out);
    expect(data).toHaveLength(8);
    expect(data[0]).toMatchObject({ name: 'the-forge', phase: 'not-installed', dirty: false });
  });

  it('components --json expõe flags e ops nativas', async () => {
    const res = await cli('components', 'spark-forge-aws', 'forge-portal', '--json', '--dir', ws);
    const data = JSON.parse(res.out);
    expect(data[0].nativeInstall.flags).toContain('gateway-profile');
    expect(data[0].nativeInstall.ops.update).toEqual(['sparkforge-aws', 'update']);
    expect(data[1].nativeInstall).toBeNull();
  });

  it('update --check --json lista estado por Forja', async () => {
    const res = await cli('update', '--check', '--json', '--dir', ws);
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.out);
    expect(doc.repos.every((r: { state: string }) => r.state === 'not-installed')).toBe(true);
    expect(doc.manifest === null || typeof doc.manifest.sha256 === 'string').toBe(true);
  });

  it('update --check reporta no-upstream honesto para clone sem remote', async () => {
    const dir = path.join(ws, 'api-forge');
    mkdirSync(dir, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(path.join(dir, '.gitignore'), '.env\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    const res = await cli('update', '--check', '--json', '--dir', ws);
    const doc = JSON.parse(res.out);
    const row = doc.repos.find((r: { name: string }) => r.name === 'api-forge');
    expect(row.failure).toBe('no-upstream');
    expect(res.code).toBe(0); // não conta como pendência de update

    const text = await cli('update', '--check', '--dir', ws);
    expect(text.out).toContain('sem upstream configurado');
    expect(text.out).not.toContain('(unknown)');
  });

  it('uninstall --native sem a operação nativa preserva o clone', async () => {
    const dir = fakeClone('forge-portal', 'https://github.com/EdgarSocrates98/forge-portal');
    const res = await cli('uninstall', 'forge-portal', '--native', '--yes', '--dir', ws);
    expect(res.code).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('dispatch --method registry', () => {
  it('install sem nomes recusa com orientação', async () => {
    const res = await cli('install', '--method', 'registry', '--yes');
    expect(res.code).toBe(2);
    expect(res.out).toContain('--method registry');
  });

  it('--ref em multi-Forja recusa como no fluxo git', async () => {
    const res = await cli(
      'install',
      'api-forge',
      'platform-forge',
      '--method',
      'registry',
      '--ref',
      'v0.1.0',
      '--yes',
    );
    expect(res.code).toBe(2);
    expect(res.out).toContain('exigem exatamente uma Forja');
  });

  it.each([
    'update',
    'clone',
    'reinstall',
    'rollback',
    'pin',
    'unpin',
    'versions',
    'status',
    'list',
  ])('%s --method registry é recusado antes de qualquer dispatch', async (verb) => {
    const res = await cli(verb, 'api-forge', '--method', 'registry', '--yes');
    expect(res.code).toBe(2);
    expect(res.out).toContain('só é suportado em install|uninstall');
  });

  it('self update --method registry é recusado (não roda npm)', async () => {
    const res = await cli('self', 'update', '--method', 'registry');
    expect(res.code).toBe(2);
    expect(res.out).toContain('só é suportado em install|uninstall');
  });

  it('uninstall --method registry --json misto → stdout é JSON puro', async () => {
    const res = await cli(
      'uninstall',
      'api-forge',
      'platform-forge',
      '--method',
      'registry',
      '--yes',
      '--json',
    );
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.stdout);
    expect(doc.method).toBe('pypi');
    expect(doc.skipped).toEqual(['api-forge', 'platform-forge']);
    expect(doc.warnings.length).toBe(2);
  });

  it('uninstall --method registry --json sem --yes → erro JSON, exit 2, nada removido', async () => {
    const forges = path.join(home, '.forge-cli', 'forges');
    mkdirSync(forges, { recursive: true });
    writeFileSync(
      path.join(forges, 'state.json'),
      JSON.stringify({
        forges: {
          'api-forge': {
            forge: 'api-forge',
            method: 'pypi',
            dist: 'apiforge-af',
            version: '0.1.0',
            verify: { command: [], ok: true },
          },
        },
      }),
    );
    const res = await cli('uninstall', 'api-forge', '--method', 'registry', '--json');
    expect(res.code).toBe(2);
    const doc = JSON.parse(res.stdout);
    expect(doc.error).toBeTruthy();
    expect(doc.planned).toEqual(['api-forge']);
    expect(
      JSON.parse(readFileSync(path.join(forges, 'state.json'), 'utf8')).forges['api-forge'],
    ).toBeTruthy();
  });

  it('uninstall --method registry sem nomes/only/all recusa (não cai no legado)', async () => {
    const res = await cli('uninstall', '--method', 'registry', '--yes');
    expect(res.code).toBe(2);
    expect(res.out).toContain('uninstall --method registry exige nomes');
    expect(res.out).not.toContain('PATH');
  });

  it('uninstall --method registry de nome desconhecido → código 2', async () => {
    const res = await cli('uninstall', 'bogus-name', '--method', 'registry', '--yes');
    expect(res.code).toBe(2);
    expect(res.out).toContain('sem dist no catálogo registry');
  });

  it('registry <dist-name> filtra pelo nome canônico', async () => {
    const res = await cli('registry', 'apiforge-af', '--json');
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.stdout);
    expect(doc.forges).toEqual([expect.objectContaining({ forge: 'api-forge' })]);
  });

  it('uninstall --method registry de alias de dist resolve o nome canônico', async () => {
    const res = await cli('uninstall', 'apiforge-af', '--method', 'registry', '--yes');
    expect(res.code).toBe(0);
    expect(res.out).toContain('api-forge: não estava instalado via registry');
  });

  it('uninstall --method registry --yes de não-instalado avisa e sai 0', async () => {
    const res = await cli('uninstall', 'api-forge', '--method', 'registry', '--yes');
    expect(res.code).toBe(0);
    expect(res.out).toContain('não estava instalado via registry');
  });

  it('registry --json emite JSON parseável (sem banner)', async () => {
    const res = await cli('registry', '--json');
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.out);
    expect(doc.forges.map((f: { forge: string }) => f.forge)).toContain('api-forge');
  });
});
