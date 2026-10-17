import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli-args.js';
import { MENU_ITEMS, actionNeedsRepos, actionToPositionals, shouldShowMenu } from '../src/menu.js';

describe('shouldShowMenu', () => {
  it('aparece só com TTY e sem comando/seleção/plano', () => {
    expect(shouldShowMenu(parseCliArgs([]), true)).toBe(true);
    expect(shouldShowMenu(parseCliArgs(['--dir', 'x']), true)).toBe(true);
  });

  it('não aparece sem TTY (CI, pipes)', () => {
    expect(shouldShowMenu(parseCliArgs([]), false)).toBe(false);
  });

  it('não aparece com comando, --all, --only, --plan, --retry-failed ou --help', () => {
    for (const argv of [
      ['status'],
      ['--all', '--yes'],
      ['--only', 'api-forge'],
      ['--plan'],
      ['--retry-failed'],
      ['--help'],
    ]) {
      expect(shouldShowMenu(parseCliArgs(argv), true)).toBe(false);
    }
  });

  it('não aparece com --method registry (menu não sabe rotear — evita dead-end)', () => {
    expect(shouldShowMenu(parseCliArgs(['--method', 'registry']), true)).toBe(false);
  });
});

describe('ações do menu', () => {
  it('traduz para posicionais do CLI', () => {
    expect(actionToPositionals('install', ['a'])).toEqual([]);
    expect(actionToPositionals('update', ['a', 'b'])).toEqual(['update', 'a', 'b']);
    expect(actionToPositionals('repair', [])).toEqual(['doctor']);
    expect(actionToPositionals('doctor', [])).toEqual(['doctor']);
    expect(actionToPositionals('uninstall', ['a'])).toEqual(['uninstall', 'a']);
  });

  it('só pergunta repositórios quando a ação precisa', () => {
    expect(actionNeedsRepos('update')).toBe(true);
    expect(actionNeedsRepos('uninstall')).toBe(true);
    expect(actionNeedsRepos('doctor')).toBe(false);
    expect(actionNeedsRepos('status')).toBe(false);
  });

  it('o menu expõe as operações do roadmap', () => {
    const values = MENU_ITEMS.map((i) => i.value);
    for (const v of [
      'install',
      'update',
      'reinstall',
      'repair',
      'versions',
      'uninstall',
      'doctor',
      'exit',
    ]) {
      expect(values).toContain(v);
    }
  });
});

import { PassThrough } from 'node:stream';
import { applyMenu, askMenu, type MenuAction, type MenuDeps } from '../src/menu.js';

function deps(
  action: MenuAction,
  picked: string[] = ['api-forge'],
): MenuDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ask: async () => action,
    workspace: async () => {
      calls.push('workspace');
      return '/ws/asked';
    },
    resolveDir: (d) => {
      calls.push('resolve');
      return `/abs/${d}`;
    },
    pickRepos: async (dir) => {
      calls.push(`pick:${dir}`);
      return picked;
    },
  };
}

describe('applyMenu (fluxo do menu sem TTY)', () => {
  const base = parseCliArgs([]);

  it('sair retorna null', async () => {
    expect(await applyMenu(base, deps('exit'))).toBeNull();
  });

  it('instalar mantém as opções e segue o fluxo interativo padrão', async () => {
    const d = deps('install');
    expect(await applyMenu(base, d)).toBe(base);
    expect(d.calls).toEqual([]);
  });

  it('atualizar pergunta workspace e Forjas e monta o comando', async () => {
    const d = deps('update', ['api-forge', 'the-forge']);
    const next = await applyMenu(base, d);
    expect(next).toMatchObject({
      dir: '/ws/asked',
      positionals: ['update', 'api-forge', 'the-forge'],
      fix: false,
    });
    expect(d.calls).toEqual(['workspace', 'pick:/ws/asked']);
  });

  it('usa --dir quando informado e não pergunta o workspace', async () => {
    const d = deps('uninstall', ['x']);
    const next = await applyMenu(parseCliArgs(['--dir', 'meu']), d);
    expect(next?.dir).toBe('/abs/meu');
    expect(next?.positionals).toEqual(['uninstall', 'x']);
    expect(d.calls).toEqual(['resolve', 'pick:/abs/meu']);
  });

  it('reparar vira doctor --fix sem escolher Forjas', async () => {
    const d = deps('repair');
    const next = await applyMenu(parseCliArgs(['--dir', 'w']), d);
    expect(next).toMatchObject({ positionals: ['doctor'], fix: true });
    expect(d.calls.some((c) => c.startsWith('pick'))).toBe(false);
  });
});

describe('askMenu renderiza e navega com teclas reais (streams simulados)', () => {
  const stripAnsi = (s: string) =>
    s.replace(new RegExp(String.raw`\u001B\[[0-9;?]*[A-Za-z]`, 'g'), '');

  function makeIo() {
    const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void };
    input.isTTY = true;
    input.setRawMode = () => undefined;
    const output = new PassThrough();
    let text = '';
    output.on('data', (c) => (text += c.toString()));
    return { input, output, text: () => stripAnsi(text) };
  }
  const DOWN = '\u001B[B';

  it('Enter escolhe o padrão (instalar) e o menu lista as operações', async () => {
    const io = makeIo();
    const pending = askMenu({ input: io.input, output: io.output });
    setTimeout(() => io.input.write('\r'), 50);
    expect(await pending).toBe('install');
    const screen = io.text();
    for (const label of ['Instalar Forjas', 'Atualizar Forjas', 'Desinstalar Forjas', 'Sair']) {
      expect(screen).toContain(label);
    }
  });

  it('seta para baixo + Enter escolhe a próxima opção (wizard)', async () => {
    const io = makeIo();
    const pending = askMenu({ input: io.input, output: io.output });
    setTimeout(() => io.input.write(DOWN), 50);
    setTimeout(() => io.input.write('\r'), 120);
    expect(await pending).toBe('wizard');
  });

  it('duas setas para baixo + Enter escolhe atualizar', async () => {
    const io = makeIo();
    const pending = askMenu({ input: io.input, output: io.output });
    setTimeout(() => io.input.write(DOWN), 50);
    setTimeout(() => io.input.write(DOWN), 90);
    setTimeout(() => io.input.write('\r'), 140);
    expect(await pending).toBe('update');
  });
});
