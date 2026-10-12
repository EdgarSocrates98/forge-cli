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
