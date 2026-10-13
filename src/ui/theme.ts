import pc from 'picocolors';

export const theme = {
  brand: (text: string) => pc.bold(pc.yellow(text)),
  accent: (text: string) => pc.cyan(text),
  ok: (text: string) => pc.green(text),
  warn: (text: string) => pc.yellow(text),
  err: (text: string) => pc.red(text),
  dim: (text: string) => pc.dim(text),
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
