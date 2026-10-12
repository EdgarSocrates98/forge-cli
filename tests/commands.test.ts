import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCommand } from '../src/commands.js';
import { collectStatus, phaseOf } from '../src/status.js';
import type { ForgeRepo } from '../src/types.js';

describe('resolveCommand', () => {
  it('sem posicionais é o fluxo padrão', () => {
    expect(resolveCommand({ positionals: [] })).toEqual({ command: 'run', names: [] });
  });
  it('install com nomes', () => {
    expect(resolveCommand({ positionals: ['install', 'api-forge', 'the-forge'] })).toEqual({
      command: 'install',
      names: ['api-forge', 'the-forge'],
    });
  });
  it('clone, status, update e versions', () => {
    for (const c of ['clone', 'status', 'update', 'versions'] as const) {
      expect(resolveCommand({ positionals: [c, 'x'] })).toEqual({ command: c, names: ['x'] });
    }
  });
  it('self install/uninstall registram o PATH', () => {
    expect(resolveCommand({ positionals: ['self', 'install'] }).command).toBe('self-install');
    expect(resolveCommand({ positionals: ['self', 'uninstall'] }).command).toBe('self-uninstall');
    expect(resolveCommand({ positionals: ['self', 'foo'] }).command).toBe('unknown');
  });
  it('comando inexistente é reportado', () => {
    expect(resolveCommand({ positionals: ['bogus'] })).toMatchObject({
      command: 'unknown',
      unknown: 'bogus',
    });
  });
});

describe('phaseOf', () => {
  const at = '2026-01-01T00:00:00Z';
  it('classifica fases', () => {
    expect(phaseOf(false)).toBe('not-installed');
    expect(phaseOf(true)).toBe('cloned');
    expect(phaseOf(true, { status: 'ok', detail: '', at })).toBe('installed');
    expect(phaseOf(true, { status: 'error', detail: '', at })).toBe('failed');
  });
});

describe('collectStatus', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-status-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const repo = (name: string): ForgeRepo => ({
    name,
    url: 'https://github.com/a/b',
    description: '',
    kind: 'node',
  });

  it('distingue não clonado, clonado limpo e alterado (repo local temporário)', async () => {
    const dir = path.join(tmp, 'demo');
    mkdirSync(dir);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(path.join(dir, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    let infos = await collectStatus([repo('demo'), repo('ausente')], tmp, null);
    expect(infos[0]).toMatchObject({ name: 'demo', phase: 'cloned', dirty: false });
    expect(infos[0].head).toHaveLength(7);
    expect(infos[1]).toMatchObject({ name: 'ausente', phase: 'not-installed' });

    writeFileSync(path.join(dir, 'b.txt'), 'b');
    infos = await collectStatus([repo('demo')], tmp, null);
    expect(infos[0].dirty).toBe(true);
  });
});

describe('help e components', () => {
  it('resolve help e components com nomes', () => {
    expect(resolveCommand({ positionals: ['help'] }).command).toBe('help');
    expect(resolveCommand({ positionals: ['components', 'api-forge'] })).toEqual({
      command: 'components',
      names: ['api-forge'],
    });
  });
  it('doctor aceita nomes de Forjas', () => {
    expect(resolveCommand({ positionals: ['doctor', 'api-forge'] })).toEqual({
      command: 'doctor',
      names: ['api-forge'],
    });
  });
});

describe('fases persistidas', () => {
  it('usa a fase registrada e sinaliza drift quando o HEAD mudou', async () => {
    const at = '2026-01-01T00:00:00Z';
    expect(phaseOf(true, { status: 'warning', detail: '', at, phase: 'prepared' })).toBe(
      'prepared',
    );
    expect(phaseOf(true, { status: 'ok', detail: '', at, phase: 'validated' })).toBe('validated');
  });
});
