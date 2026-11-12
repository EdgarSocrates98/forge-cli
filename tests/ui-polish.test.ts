/**
 * Ciclo de polish visual — utilitários de UI:
 * - progressBar/formatDuration/estimateEtaMs são determinísticos;
 * - renderTable alinha por largura visível (ANSI não quebra colunas);
 * - styledUsage colore só em modo com cor e preserva o texto;
 * - ForgeBoard é silencioso fora de TTY e deixa estado final legível.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { ForgeBoard } from '../src/ui/board.js';
import { chip } from '../src/ui/fx.js';
import { estimateEtaMs, formatDuration, progressBar, visibleWidth } from '../src/ui/progress.js';
import { renderTable } from '../src/ui/table.js';
import { styledUsage } from '../src/ui/usage.js';
import { setColorEnabled, theme } from '../src/ui/theme.js';

afterEach(() => setColorEnabled(true));

describe('progress', () => {
  it('progressBar preenche proporcionalmente e clampa', () => {
    expect(progressBar(0, 10)).toBe('[░░░░░░░░░░]');
    expect(progressBar(0.5, 10)).toBe('[█████░░░░░]');
    expect(progressBar(1, 10)).toBe('[██████████]');
    expect(progressBar(7, 4)).toBe('[████]');
  });

  it('formatDuration humaniza segundos/minutos/horas', () => {
    expect(formatDuration(3400)).toBe('3.4s');
    expect(formatDuration(72_000)).toBe('1m 12s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
  });

  it('estimateEtaMs é linear e honesto nas bordas', () => {
    expect(estimateEtaMs(0, 4, 1000)).toBeNull();
    expect(estimateEtaMs(4, 4, 1000)).toBeNull();
    // 1/4 feito em 1s → 3s restantes
    expect(estimateEtaMs(1, 4, 1000)).toBe(3000);
  });

  it('visibleWidth ignora escapes ANSI', () => {
    expect(visibleWidth('[31mabc[0m')).toBe(3);
  });
});

describe('renderTable', () => {
  it('alinha colunas pela largura visível, não pelo comprimento', () => {
    setColorEnabled(true);
    const out = renderTable([
      [theme.ok('ab'), 'x'],
      ['longer', 'y'],
    ]);
    const lines = out.split('\n');
    // A célula colorida tem padding calculado sobre 'ab' (2), não sobre os escapes.
    // eslint-disable-next-line no-control-regex -- strip ANSI no assert
    expect(lines[0]!.replace(/\x1b\[[0-9;]*m/g, '')).toBe('ab      x');
    expect(lines[1]).toBe('longer  y');
  });

  it('aceita células nulas e não deixa trailing space', () => {
    const out = renderTable([
      ['a', null],
      ['b', undefined],
    ]);
    for (const line of out.split('\n')) expect(line).toBe(line.trimEnd());
  });
});

describe('styledUsage', () => {
  it('sem cor devolve o texto intacto', () => {
    setColorEnabled(false);
    const raw = 'Uso:\n  forge-cli install [forjas]\n  --json   saída JSON';
    expect(styledUsage(raw)).toBe(raw);
  });

  it('com cor marca seções, comandos e flags sem perder texto', () => {
    setColorEnabled(true);
    const raw = 'Uso:\n  forge-cli install [forjas]';
    const out = styledUsage(raw);
    // eslint-disable-next-line no-control-regex -- strip ANSI no assert
    expect(out.replace(/\x1b\[[0-9;]*m/g, '')).toBe(raw);
    expect(out).toContain('\x1b[');
  });
});

describe('chip', () => {
  it('rotula o estado com marcador', () => {
    setColorEnabled(false);
    expect(chip('instalado', 'ok')).toBe('● instalado');
  });
});

describe('ForgeBoard', () => {
  it('fora de TTY é silencioso — nenhum byte em stdout', () => {
    const saved = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const origLog = console.log;
    try {
      process.stdout.write = ((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      console.log = (msg?: unknown) => writes.push(String(msg));
      const board = new ForgeBoard('t', ['a', 'b']);
      board.start('a', 'clonando');
      board.done('a', 'v1.0');
      board.fail('b', 'boom');
      board.log('aviso');
      board.close();
    } finally {
      process.stdout.write = origWrite;
      console.log = origLog;
      if (saved) Object.defineProperty(process.stdout, 'isTTY', saved);
    }
    expect(writes).toEqual([]);
  });
});
