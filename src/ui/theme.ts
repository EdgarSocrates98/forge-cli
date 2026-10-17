import pc, { createColors } from 'picocolors';

type Colors = ReturnType<typeof createColors>;

// `--no-color` e NO_COLOR desligam o ANSI mesmo em TTY — JSON continua
// sempre limpo (emitJson não passa pelo theme).
let c: Colors = pc.isColorSupported ? pc : createColors(false);

export function setColorEnabled(on: boolean): void {
  c = on ? pc : createColors(false);
}

export const theme = {
  brand: (text: string) => c.bold(c.yellow(text)),
  accent: (text: string) => c.cyan(text),
  ok: (text: string) => c.green(text),
  warn: (text: string) => c.yellow(text),
  err: (text: string) => c.red(text),
  dim: (text: string) => c.dim(text),
};

export const icons = {
  ok: '✅',
  warn: '⚠️',
  err: '❌',
  fire: '🔥',
  folder: '📁',
  box: '📦',
  rocket: '🚀',
  env: '🔐',
  gear: '⚙️',
};

export const kindIcon = {
  python: '🐍',
  node: '🅰️',
} as const;
