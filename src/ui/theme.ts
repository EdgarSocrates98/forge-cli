import pc, { createColors } from 'picocolors';

type Colors = ReturnType<typeof createColors>;

// `--no-color` e NO_COLOR desligam o ANSI mesmo em TTY — JSON continua
// sempre limpo (emitJson não passa pelo theme).
let c: Colors = pc.isColorSupported ? pc : createColors(false);
let colorEnabled = pc.isColorSupported;

export function setColorEnabled(on: boolean): void {
  c = on ? pc : createColors(false);
  colorEnabled = on;
}

// Forja em chamas: âmbar → laranja → vermelho. Truecolor quando o terminal
// suporta; caso contrário cai no brand sólido. `t` ∈ [0,1] posiciona na rampa.
const FIRE_STOPS: Array<[number, number, number]> = [
  [255, 214, 90],
  [255, 140, 0],
  [235, 64, 52],
];

export function gradient(text: string, t: number): string {
  if (!colorEnabled || !text) return text;
  const clamped = Math.min(1, Math.max(0, t));
  const pos = clamped * (FIRE_STOPS.length - 1);
  const i = Math.min(Math.floor(pos), FIRE_STOPS.length - 2);
  const f = pos - i;
  const [r, g, b] = FIRE_STOPS[i]!.map((a, k) => Math.round(a + (FIRE_STOPS[i + 1]![k]! - a) * f));
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
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
