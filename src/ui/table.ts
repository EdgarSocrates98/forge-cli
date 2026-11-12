import { visibleWidth } from './progress.js';

export interface TableOptions {
  /** Espaços entre colunas (default 2). */
  gap?: number;
  /** Alinhamento por coluna ('l' default, 'r' encosta à direita). */
  align?: ('l' | 'r')[];
  /** Indentação à esquerda de cada linha (default 0). */
  indent?: number;
}

/**
 * Tabela alinhada ANSI-aware: cada coluna é preenchida pela largura visível,
 * nunca pelo comprimento da string — cores não quebram o alinhamento.
 * Colunas `null`/`undefined` viram string vazia.
 */
export function renderTable(
  rows: (string | null | undefined)[][],
  opts: TableOptions = {},
): string {
  const gap = ' '.repeat(opts.gap ?? 2);
  const indent = ' '.repeat(opts.indent ?? 0);
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const widths: number[] = Array.from({ length: cols }, () => 0);
  for (const row of rows) {
    for (let c = 0; c < cols; c++) {
      const w = visibleWidth(row[c] ?? '');
      if (w > widths[c]!) widths[c] = w;
    }
  }
  return rows
    .map((row) => {
      const cells = row.map((cell, c) => {
        const text = cell ?? '';
        const pad = widths[c]! - visibleWidth(text);
        // Última coluna não é preenchida (evita trailing space).
        if (c === cols - 1) return text;
        return opts.align?.[c] === 'r' ? ' '.repeat(pad) + text : text + ' '.repeat(pad);
      });
      return indent + cells.join(gap).replace(/\s+$/, '');
    })
    .join('\n');
}
