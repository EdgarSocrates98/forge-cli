import { gradient, theme } from './theme.js';

export type ChipTone = 'ok' | 'warn' | 'err' | 'accent' | 'dim';

const CHIP_PAINT: Record<ChipTone, (t: string) => string> = {
  ok: (t) => theme.ok(t),
  warn: (t) => theme.warn(t),
  err: (t) => theme.err(t),
  accent: (t) => theme.accent(t),
  dim: (t) => theme.dim(t),
};

/** Chip visual de estado: `● label` colorido por tom. */
export function chip(label: string, tone: ChipTone): string {
  const paint = CHIP_PAINT[tone];
  return `${paint('●')} ${paint(label)}`;
}

const TAGLINE_DELAY_MS = 9;

/**
 * Tagline do banner — reveal caractere a caractere em TTY (gradiente no
 * texto inteiro posicionado na rampa); estática em pipe, sempre respeitando
 * `--no-color` via `gradient`/`theme` (que já devolvem texto puro).
 */
export async function printTagline(text: string): Promise<void> {
  // Decoração: em pipe/--json a tagline não sai (o banner em si já é TTY-só
  // na prática — saída capturada não deve ganhar ruído decorativo).
  if (!process.stdout.isTTY) return;
  const last = Math.max(1, text.length - 1);
  let acc = '';
  for (const [i, ch] of [...text].entries()) {
    acc += gradient(ch, i / last);
    process.stdout.write(`\r  ${acc}`);
    await new Promise((resolve) => setTimeout(resolve, TAGLINE_DELAY_MS));
  }
  process.stdout.write('\n');
}

const EMBER_FRAMES = ['  ✦    ', '  ✦ ✧  ', '  ✦ ✧ ✦ ', '  ✧ ✦ ✧ ', '  ✦ ✧ ✦ '];

/** Micro-celebração de outro — uma linha de brasas (~350ms, só TTY). */
export async function celebrate(): Promise<void> {
  if (!process.stdout.isTTY) return;
  for (const [i, frame] of EMBER_FRAMES.entries()) {
    process.stdout.write(`\r${gradient(frame, i / (EMBER_FRAMES.length - 1))}`);
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  process.stdout.write('\r\x1b[2K');
}
