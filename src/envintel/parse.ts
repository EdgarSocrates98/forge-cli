import type { EnvEntry, EnvFile } from './model.js';

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Fecha aspas a partir do índice 1, respeitando escapes `\x`. */
function closeQuoteAt(text: string, quote: '"' | "'"): number {
  for (let i = 1; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

function unescapeDoubleQuoted(text: string): string {
  return text.replace(/\\(.)/gs, (_, c: string) => ESCAPES[c] ?? c);
}

function parseLine(line: string, index: number): EnvEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const body = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
  const eq = body.indexOf('=');
  if (eq <= 0) return null;
  const key = body.slice(0, eq).trim();
  if (!ENV_KEY_RE.test(key)) return null;
  const rest = body.slice(eq + 1);
  const lead = rest.trimStart();
  let value: string;
  let comment: string | undefined;
  if (lead.startsWith('"')) {
    const close = closeQuoteAt(lead, '"');
    if (close < 0) {
      value = unescapeDoubleQuoted(lead.slice(1));
    } else {
      value = unescapeDoubleQuoted(lead.slice(1, close));
      const tail = lead.slice(close + 1).trim();
      if (tail.startsWith('#')) comment = tail.slice(1).trim();
    }
  } else if (lead.startsWith("'")) {
    const close = lead.indexOf("'", 1);
    if (close < 0) {
      value = lead.slice(1);
    } else {
      value = lead.slice(1, close);
      const tail = lead.slice(close + 1).trim();
      if (tail.startsWith('#')) comment = tail.slice(1).trim();
    }
  } else {
    // Fora de aspas, '#' só abre comentário quando precedido de espaço (regra dotenv).
    const hash = rest.search(/\s#/);
    if (hash < 0) {
      value = rest.trim();
    } else {
      value = rest.slice(0, hash).trimEnd();
      comment = rest.slice(hash).trim().slice(1).trim();
    }
  }
  return comment === undefined ? { key, value, line: index } : { key, value, line: index, comment };
}

/** Índice das linhas não-vazias/não-comentário que não viraram entradas (kind 'raw'). */
export function malformedLines(env: EnvFile): number[] {
  const ok = new Set(env.entries.map((e) => e.line));
  const bad: number[] = [];
  env.lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || ok.has(i)) return;
    bad.push(i);
  });
  return bad;
}

export function parseEnv(content: string): EnvFile {
  const lines = content.split('\n');
  const entries: EnvEntry[] = [];
  lines.forEach((raw, index) => {
    const entry = parseLine(raw.replace(/\r$/, ''), index);
    if (entry) entries.push(entry);
  });
  return { entries, lines };
}

/** Round-trip byte a byte: conteúdo não tocado sai idêntico. */
export function serializeEnv(env: EnvFile): string {
  return env.lines.join('\n');
}

/** Formata uma linha `KEY=value`, citando quando o valor contém espaços, # ou aspas. */
export function formatEntry(key: string, value: string): string {
  if (/[\s#'"\\]/.test(value)) {
    return `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return `${key}=${value}`;
}
