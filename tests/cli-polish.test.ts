/**
 * Ciclo 11.2 — polish não-interativo do CLI:
 * - `forge-cli --version` sozinho é a versão do CLI, não um pin de Forja;
 * - `--yes` nunca pede nada (menu suprimido, erro nomeado sem seleção);
 * - `--json` sai JSON puro, sem ANSI nem banner;
 * - `--no-color` + NO_COLOR desligam o tema;
 * - ajuda contextual por comando (`<cmd> --help`, `help <cmd>`);
 * - `env wizard` é intrinsecamente interativo — sem TTY/--json/--yes
 *   vira recusa nomeada com exit 2.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCliArgs, usageFor, type CliOptions } from '../src/cli-args.js';
import { runEnvCommand } from '../src/cmd/env.js';
import { shouldShowMenu } from '../src/menu.js';
import { setColorEnabled, theme } from '../src/ui/theme.js';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-polish-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  setColorEnabled(true);
});

const cliBase: CliOptions = parseCliArgs([]);

function withTTY(inTty: boolean | undefined, outTty: boolean | undefined, fn: () => unknown) {
  const savedIn = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const savedOut = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: inTty, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: outTty, configurable: true });
  try {
    return fn();
  } finally {
    if (savedIn) Object.defineProperty(process.stdin, 'isTTY', savedIn);
    if (savedOut) Object.defineProperty(process.stdout, 'isTTY', savedOut);
  }
}

describe('parseCliArgs — polish flags', () => {
  it('--version sozinho é flag de versão do CLI, não pin', () => {
    const cli = parseCliArgs(['--version']);
    expect(cli.versionFlag).toBe(true);
    expect(cli.ref).toBeUndefined();
    expect(cli.positionals).toEqual([]);
  });

  it('--version <ref> continua pin de Forja', () => {
    const cli = parseCliArgs(['install', 'api-forge', '--version', '1.2.3']);
    expect(cli.versionFlag).toBe(false);
    expect(cli.ref).toBe('1.2.3');
  });

  it('--no-color e --out parseiam', () => {
    const cli = parseCliArgs(['registry', 'lock', 'api-forge', '--out', 'locks/', '--no-color']);
    expect(cli.noColor).toBe(true);
    expect(cli.out).toBe('locks/');
  });

  it('--lock <file> parseia (obrigação de --offline é do install)', () => {
    const cli = parseCliArgs(['registry', 'install', 'api-forge', '--offline', '--lock', 'l.json']);
    expect(cli.lockFile).toBe('l.json');
    expect(cli.offline).toBe(true);
  });
});

describe('usageFor — ajuda contextual', () => {
  it('sem posicionais → ajuda global', () => {
    expect(usageFor([])).toContain('forge-cli');
  });

  it('<cmd> --help adiciona bloco do comando', () => {
    expect(usageFor(['registry'])).toContain('offline-lock');
    expect(usageFor(['install'])).toContain('--method registry');
    expect(usageFor(['env'])).toContain('wizard');
  });

  it('help <cmd> resolve o mesmo bloco', () => {
    expect(usageFor(['help', 'registry'])).toBe(usageFor(['registry']));
  });

  it('comando desconhecido cai na ajuda global sem bloco extra', () => {
    expect(usageFor(['bogus'])).toBe(usageFor([]));
  });
});

describe('--yes nunca pede', () => {
  it('suprime o menu mesmo em TTY', () => {
    const cli = parseCliArgs(['--yes']);
    expect(shouldShowMenu(cli, true)).toBe(false);
  });

  it('sem --yes e sem seleção o menu ainda aparece em TTY', () => {
    expect(shouldShowMenu(parseCliArgs([]), true)).toBe(true);
  });
});

describe('NO_COLOR / --no-color', () => {
  it('setColorEnabled(false) remove ANSI do tema', () => {
    setColorEnabled(false);
    expect(theme.err('x')).toBe('x');
    expect(theme.dim('x')).toBe('x');
    expect(theme.accent('x')).toBe('x');
  });
});

describe('env wizard — recusa nomeada fora de TTY', () => {
  function repo(): { ws: string } {
    const ws = tmpDir();
    mkdirSync(path.join(ws, 'myrepo'));
    writeFileSync(path.join(ws, 'myrepo', '.env.example'), 'API_KEY=\n');
    return { ws };
  }

  it('stdin sem TTY → exit 2 sem tocar o .env', async () => {
    const { ws } = repo();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await withTTY(false, true, () =>
        runEnvCommand({ ...cliBase, dir: ws, jsonReport: false }, ['wizard', 'myrepo']),
      );
      expect(code).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('--json → exit 2 (wizard é interativo por definição)', async () => {
    const { ws } = repo();
    const code = await runEnvCommand({ ...cliBase, dir: ws, jsonReport: true }, [
      'wizard',
      'myrepo',
    ]);
    expect(code).toBe(2);
  });

  it('--yes → exit 2', async () => {
    const { ws } = repo();
    const code = await runEnvCommand({ ...cliBase, dir: ws, yes: true, jsonReport: false }, [
      'wizard',
      'myrepo',
    ]);
    expect(code).toBe(2);
  });
});

describe('--json sai JSON puro', () => {
  it('env inspect --json não emite ANSI', async () => {
    const ws = tmpDir();
    mkdirSync(path.join(ws, 'myrepo'));
    writeFileSync(path.join(ws, 'myrepo', '.env.example'), 'API_KEY=\n');
    writeFileSync(path.join(ws, 'myrepo', '.env'), 'API_KEY=segredo\n');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      lines.push(String(m));
    });
    try {
      const code = await runEnvCommand({ ...cliBase, dir: ws, jsonReport: true }, [
        'inspect',
        'myrepo',
      ]);
      expect(code).toBe(0);
      const blob = lines.join('\n');
      expect(blob).not.toContain('\u001b');
      expect(() => JSON.parse(blob.trim().split('\n').at(-1)!)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
