import { theme } from './theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_MS = 70;

export type RowState = 'pending' | 'working' | 'done' | 'failed';

interface Row {
  name: string;
  state: RowState;
  stage: string;
  detail: string;
}

/**
 * Live per-forge install board — one row per forge, braille spinner on the
 * working row, re-rendered in place. Interactive only: when stdout is not a
 * TTY the board is silent and callers keep their plain log lines (JSON mode
 * is untouched — callers gate it with `quiet` before constructing).
 */
export class ForgeBoard {
  private rows: Row[];
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  private rendered = 0;
  private readonly width: number;
  private readonly tty: boolean;

  constructor(title: string, names: readonly string[]) {
    this.tty = Boolean(process.stdout.isTTY);
    this.width = Math.max(14, ...names.map((n) => n.length));
    this.rows = names.map((name) => ({ name, state: 'pending', stage: '', detail: '' }));
    if (this.tty) {
      console.log(`  ${theme.accent('◆')} ${theme.brand(title)}`);
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % FRAMES.length;
        if (this.rows.some((r) => r.state === 'working')) this.render();
      }, TICK_MS);
      this.timer.unref?.();
      this.render();
    }
  }

  private render(): void {
    if (!this.tty) return;
    if (this.rendered) process.stdout.write(`\x1b[${this.rendered}A`);
    const frame = FRAMES[this.frame];
    for (const row of this.rows) {
      const icon =
        row.state === 'done'
          ? theme.ok('✓')
          : row.state === 'failed'
            ? theme.err('✗')
            : row.state === 'working'
              ? theme.accent(frame)
              : theme.dim('◌');
      const stage = row.state === 'working' ? theme.accent(row.stage) : theme.dim(row.stage);
      const detail = row.detail ? ` ${theme.dim(row.detail)}` : '';
      process.stdout.write(`\x1b[2K  ${icon} ${row.name.padEnd(this.width)} ${stage}${detail}\n`);
    }
    this.rendered = this.rows.length;
  }

  /** Print a message above the board (warnings, native-installer notes). */
  log(message: string): void {
    if (!this.tty) return;
    if (this.rendered) process.stdout.write(`\x1b[${this.rendered}A`);
    for (let i = 0; i < this.rendered; i++) process.stdout.write('\x1b[2K\n');
    console.log(`  ${message}`);
    this.rendered = 0;
    this.render();
  }

  start(name: string, stage: string): void {
    this.set(name, 'working', stage);
  }

  stage(name: string, stage: string): void {
    this.set(name, 'working', stage);
  }

  done(name: string, detail = ''): void {
    this.set(name, 'done', 'instalado', detail);
  }

  fail(name: string, detail = ''): void {
    this.set(name, 'failed', 'falhou', detail);
  }

  private set(name: string, state: RowState, stage: string, detail = ''): void {
    const row = this.rows.find((r) => r.name === name);
    if (!row) return;
    row.state = state;
    row.stage = stage;
    row.detail = detail;
    if (this.tty && !this.timer) this.render();
  }

  /** Stop the ticker and leave the final board on screen. */
  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.render();
  }
}
