import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliOptions } from '../src/cli-args.js';
import { runHostsCommand } from '../src/cmd/hosts.js';
import { adapterFor, hostAdapters } from '../src/hosts/index.js';
import type { HostAdapter, HostProbe } from '../src/hosts/types.js';

// ---------------------------------------------------------------------------
// Testes §2.5 — homes falsos em tmp + probe injetado. Nenhum CLI real é tocado.
// ---------------------------------------------------------------------------

const FORGE = { forge_id: 'apiforge', mcp_command: ['apiforge', 'mcp', 'serve'] } as const;

let home: string;
let ws: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-hosts-home-'));
  ws = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-hosts-ws-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

const nullProbe: HostProbe = { output: async () => null };
const probe = (map: Record<string, string>): HostProbe => ({
  output: async (command, args) => map[[command, ...args].join(' ')] ?? null,
});
const adapter = (id: string, p: HostProbe = nullProbe): HostAdapter =>
  adapterFor(id, hostAdapters(p))!;

const claudeJson = () => path.join(home, '.claude.json');
const codexToml = () => path.join(home, '.codex', 'config.toml');
const writeJson = (file: string, obj: unknown) =>
  writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');

const baseCli: CliOptions = {
  all: false,
  yes: false,
  plan: false,
  skipScripts: false,
  skipVerify: false,
  timeoutSecs: 900,
  help: false,
  jsonReport: false,
  retryFailed: false,
  fix: false,
  timeoutSet: false,
  jsonSet: false,
  jobs: 1,
  jobsSet: false,
  onlyChanged: false,
  shallow: false,
  check: false,
  native: false,
  rollback: false,
  verbose: false,
  offline: false,
  clean: false,
  trustCustom: false,
  runAfterSyncFailure: false,
  positionals: [],
};
const cli = (p: Partial<CliOptions>): CliOptions => ({ ...baseCli, ...p });

function seedForge(): void {
  const dir = path.join(ws, 'api-forge');
  mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'forge.json'), {
    forge_id: FORGE.forge_id,
    mcp_command: [...FORGE.mcp_command],
  });
}

describe('detect — estados nunca pulados', () => {
  it('host ausente → absent', async () => {
    const d = await adapter('claude').detect(home);
    expect(d.state).toBe('absent');
    expect(d.found).toBe(false);
    expect(d.configPaths).toEqual([]);
  });

  it('só binário → installed', async () => {
    const d = await adapter('claude', probe({ 'claude --version': '1.2.3' })).detect(home);
    expect(d.state).toBe('installed');
    expect(d.version).toBe('1.2.3');
    expect(d.auth).toBe('unknown');
  });

  it('binário + config → configured, NUNCA authenticated (auth não é inferida)', async () => {
    writeJson(claudeJson(), {});
    const d = await adapter('claude', probe({ 'claude --version': 'claude 1.2.3' })).detect(home);
    expect(d.state).toBe('configured');
    expect(d.auth).toBe('unknown'); // claude não tem probe documentado
  });

  it('codex: probe documentado de auth ⇒ authenticated/verified', async () => {
    mkdirSync(path.dirname(codexToml()), { recursive: true });
    writeFileSync(codexToml(), 'model = "x"\n', 'utf8');
    const p = probe({ 'codex --version': '0.1.0', 'codex login status': 'Logged in' });
    const d = await adapter('codex', p).detect(home);
    expect(d.state).toBe('authenticated');
    expect(d.auth).toBe('verified');
  });

  it('codex: probe de auth falhando ⇒ configured + auth absent', async () => {
    mkdirSync(path.dirname(codexToml()), { recursive: true });
    writeFileSync(codexToml(), 'model = "x"\n', 'utf8');
    const p = probe({ 'codex --version': '0.1.0' });
    const d = await adapter('codex', p).detect(home);
    expect(d.state).toBe('configured');
    expect(d.auth).toBe('absent');
  });

  it('integração presente na config ⇒ integrated', async () => {
    writeJson(claudeJson(), { mcpServers: { apiforge: { command: 'apiforge', args: [] } } });
    const d = await adapter('claude').detect(home);
    expect(d.state).toBe('integrated');
  });
});

describe('plan/apply — claude (merge-json)', () => {
  it('duplicado: mcpServers já tem a chave ⇒ plano manual, nada escrito', async () => {
    const original = { mcpServers: { apiforge: { command: 'old', args: [] } } };
    writeJson(claudeJson(), original);
    const plan = await adapter('claude').planIntegration(FORGE, ws, home);
    expect(plan).not.toBeNull();
    expect(plan!.actions.every((a) => a.kind === 'manual')).toBe(true);
    const result = await adapter('claude').applyIntegration(plan!, { home });
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(readFileSync(claudeJson(), 'utf8')).toBe(JSON.stringify(original, null, 2));
  });

  it('merge-json preserva chaves de outras forjas e do topo', async () => {
    writeJson(claudeJson(), {
      theme: 'dark',
      mcpServers: { other: { command: 'other-bin', args: ['x'] } },
    });
    const plan = await adapter('claude').planIntegration(FORGE, ws, home);
    const result = await adapter('claude').applyIntegration(plan!, { home });
    expect(result.ok).toBe(true);
    const merged = JSON.parse(readFileSync(claudeJson(), 'utf8')) as {
      theme: string;
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(merged.theme).toBe('dark');
    expect(merged.mcpServers.other).toEqual({ command: 'other-bin', args: ['x'] });
    expect(merged.mcpServers.apiforge).toEqual({
      command: 'apiforge',
      args: ['mcp', 'serve'],
    });
    expect(plan!.copyable_command).toContain('claude mcp add apiforge');
  });

  it('backup criado ANTES da escrita; contém os bytes originais', async () => {
    const original = JSON.stringify({ theme: 'dark' }, null, 2);
    writeFileSync(claudeJson(), original, 'utf8');
    const plan = await adapter('claude').planIntegration(FORGE, ws, home);
    const result = await adapter('claude').applyIntegration(plan!, { home });
    expect(result.backup).toBeTruthy();
    expect(readFileSync(path.join(result.backup!, '.claude.json'), 'utf8')).toBe(original);
    expect(existsSync(path.join(result.backup!, 'manifest.json'))).toBe(true);
  });

  it('alvo inexistente ⇒ sentinela .absent no backup', async () => {
    const plan = await adapter('claude').planIntegration(FORGE, ws, home);
    const result = await adapter('claude').applyIntegration(plan!, { home });
    expect(result.ok).toBe(true);
    expect(existsSync(claudeJson())).toBe(true);
    expect(existsSync(path.join(result.backup!, '.claude.json.absent'))).toBe(true);
  });

  it('JSON inválido no alvo ⇒ apply recusa e não clobber', async () => {
    writeFileSync(claudeJson(), '{not json', 'utf8');
    const plan = await adapter('claude').planIntegration(FORGE, ws, home);
    const result = await adapter('claude').applyIntegration(plan!, { home });
    expect(result.ok).toBe(false);
    expect(readFileSync(claudeJson(), 'utf8')).toBe('{not json');
  });

  it('dryRun não escreve nada nem cria backup', async () => {
    const plan = await adapter('claude').planIntegration(FORGE, ws, home);
    const result = await adapter('claude').applyIntegration(plan!, { home, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual([]);
    expect(existsSync(claudeJson())).toBe(false);
    expect(result.backup).toBeUndefined();
  });
});

describe('rollback', () => {
  it('restaura bytes originais do backup', async () => {
    const original = JSON.stringify({ theme: 'dark' }, null, 2);
    writeFileSync(claudeJson(), original, 'utf8');
    const claude = adapter('claude');
    const plan = await claude.planIntegration(FORGE, ws, home);
    await claude.applyIntegration(plan!, { home });
    expect(readFileSync(claudeJson(), 'utf8')).not.toBe(original);
    await claude.rollback(plan!, undefined, home);
    expect(readFileSync(claudeJson(), 'utf8')).toBe(original);
  });

  it('arquivo criado pelo apply é removido (sentinela .absent)', async () => {
    const claude = adapter('claude');
    const plan = await claude.planIntegration(FORGE, ws, home);
    await claude.applyIntegration(plan!, { home });
    expect(existsSync(claudeJson())).toBe(true);
    await claude.rollback(plan!, undefined, home);
    expect(existsSync(claudeJson())).toBe(false);
  });
});

describe('validate — honesto', () => {
  it('falha quando a chave está ausente', async () => {
    writeJson(claudeJson(), { mcpServers: {} });
    const v = await adapter('claude').validateIntegration('apiforge', home);
    expect(v.ok).toBe(false);
    expect(v.checks.some((c) => c.id === 'mcp-key' && c.result === 'fail')).toBe(true);
  });

  it('falha quando nem config existe', async () => {
    const v = await adapter('claude').validateIntegration('apiforge', home);
    expect(v.ok).toBe(false);
    expect(v.checks[0].result).toBe('fail');
  });

  it('passa após apply real', async () => {
    const claude = adapter('claude');
    const plan = await claude.planIntegration(FORGE, ws, home);
    await claude.applyIntegration(plan!, { home });
    const v = await claude.validateIntegration('apiforge', home);
    expect(v.ok).toBe(true);
    expect(v.checks.every((c) => c.result === 'pass')).toBe(true);
  });
});

describe('codex — TOML simplista', () => {
  it('seção existente ⇒ duplicado, nada escrito', async () => {
    mkdirSync(path.dirname(codexToml()), { recursive: true });
    const original = '[mcp_servers."apiforge"]\ncommand = "old"\nargs = []\n';
    writeFileSync(codexToml(), original, 'utf8');
    const plan = await adapter('codex').planIntegration(FORGE, ws, home);
    expect(plan!.actions.every((a) => a.kind === 'manual')).toBe(true);
    const result = await adapter('codex').applyIntegration(plan!, { home });
    expect(result.applied).toEqual([]);
    expect(readFileSync(codexToml(), 'utf8')).toBe(original);
  });

  it('append preserva conteúdo e valida', async () => {
    mkdirSync(path.dirname(codexToml()), { recursive: true });
    writeFileSync(codexToml(), 'model = "o4"\n', 'utf8');
    const codex = adapter('codex');
    const plan = await codex.planIntegration(FORGE, ws, home);
    const result = await codex.applyIntegration(plan!, { home });
    expect(result.ok).toBe(true);
    const content = readFileSync(codexToml(), 'utf8');
    expect(content).toContain('model = "o4"');
    expect(content).toContain('[mcp_servers."apiforge"]');
    expect(content).toContain('command = "apiforge"');
    const v = await codex.validateIntegration('apiforge', home);
    expect(v.ok).toBe(true);
  });
});

describe('hosts sem superfície documentada', () => {
  it('devin ⇒ plan null (hostUnsupported honesto)', async () => {
    const plan = await adapter('devin').planIntegration(FORGE, ws, home);
    expect(plan).toBeNull();
    // detecção continua funcionando
    mkdirSync(path.join(home, '.devin'), { recursive: true });
    const d = await adapter('devin').detect(home);
    expect(d.state).toBe('configured');
  });

  it('copilot sem mcp-config.json ⇒ plan null; com ele ⇒ merge-json', async () => {
    const copilot = adapter('copilot');
    expect(await copilot.planIntegration(FORGE, ws, home)).toBeNull();
    const file = path.join(home, '.copilot', 'mcp-config.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, { mcpServers: {} });
    const plan = await copilot.planIntegration(FORGE, ws, home);
    expect(plan).not.toBeNull();
    expect(plan!.actions[0].kind).toBe('merge-json');
  });
});

describe('runHostsCommand', () => {
  it('register sem --yes ⇒ 0 e nada escrito', async () => {
    seedForge();
    const code = await runHostsCommand(cli({ dir: ws }), ['register', 'claude', 'api-forge'], home);
    expect(code).toBe(0);
    expect(existsSync(claudeJson())).toBe(false);
  });

  it('register --yes ⇒ escreve e imprime backup', async () => {
    seedForge();
    const code = await runHostsCommand(
      cli({ dir: ws, yes: true }),
      ['register', 'claude', 'api-forge'],
      home,
    );
    expect(code).toBe(0);
    const merged = JSON.parse(readFileSync(claudeJson(), 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(merged.mcpServers.apiforge.command).toBe('apiforge');
    // backup do alvo ausente registra sentinela
    const backups = readdirSync(path.join(home, '.forge-cli', 'backups'));
    expect(backups.some((d) => d.startsWith('hosts-claude-'))).toBe(true);
  });

  it('rollback via comando restaura e retorna 0', async () => {
    seedForge();
    await runHostsCommand(cli({ dir: ws, yes: true }), ['register', 'claude', 'api-forge'], home);
    expect(existsSync(claudeJson())).toBe(true);
    const code = await runHostsCommand(cli({ dir: ws }), ['rollback', 'claude', 'api-forge'], home);
    expect(code).toBe(0);
    expect(existsSync(claudeJson())).toBe(false);
  });

  it('validate via comando ⇒ 1 quando ausente', async () => {
    seedForge();
    const code = await runHostsCommand(cli({ dir: ws }), ['validate', 'claude', 'api-forge'], home);
    expect(code).toBe(1);
  });

  it('host desconhecido ⇒ 2', async () => {
    const code = await runHostsCommand(cli({ dir: ws }), ['plan', 'nope', 'api-forge'], home);
    expect(code).toBe(2);
  });
});
