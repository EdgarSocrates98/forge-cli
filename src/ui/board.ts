import { estimateEtaMs, formatDuration, progressBar } from './progress.js';
import { gradient, theme } from './theme.js';
import { S } from './strings.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_MS = 70;

export type RowState = 'pending' | 'working' | 'done' | 'failed';

interface Row {
  name: string;
  state: RowState;
  stage: string;
  detail: string;
  startedAt?: number;
  elapsedMs?: number;
}

/**
 * Live per-forge install board — one row per forge, braille spinner on the
 * working row, elapsed time on finished rows and a gradient progress footer
 * with ETA, re-rendered in place. Interactive only: when stdout is not a
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
  private readonly title: string;
  private readonly startedAt = Date.now();

  constructor(title: string, names: readonly string[]) {
    this.tty = Boolean(process.stdout.isTTY);
    this.title = title;
    this.width = Math.max(14, ...names.map((n) => n.length));
    this.rows = names.map((name) => ({ name, state: 'pending', stage: '', detail: '' }));
    if (this.tty) {
      this.renderHeader();
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % FRAMES.length;
        if (this.rows.some((r) => r.state === 'working')) this.render();
      }, TICK_MS);
      this.timer.unref?.();
      this.render();
    }
  }

  private doneCount(): number {
    return this.rows.filter((r) => r.state === 'done' || r.state === 'failed').length;
  }

  private renderHeader(): void {
    console.log(`  ${theme.accent('◆')} ${theme.brand(this.title)}`);
  }

  private footerLine(): string {
    const total = this.rows.length;
    const done = this.doneCount();
    const bar = progressBar(done / Math.max(1, total), 14);
    const colored = bar
      .split('')
      .map((ch, i) => (ch === '█' ? gradient(ch, i / Math.max(1, bar.length - 1)) : theme.dim(ch)))
      .join('');
    const elapsed = formatDuration(Date.now() - this.startedAt);
    const eta = estimateEtaMs(done, total, Date.now() - this.startedAt);
    const etaPart = eta !== null ? theme.dim(` · ~${formatDuration(eta)} ${S.boardEta}`) : '';
    return `  ${colored} ${theme.accent(`${done}/${total}`)} ${theme.dim(`· ${elapsed}`)}${etaPart}`;
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
      const stage =
        row.state === 'working'
          ? theme.accent(row.stage)
          : row.state === 'pending'
            ? theme.dim('…')
            : theme.dim(row.stage);
      const elapsed =
        row.elapsedMs !== undefined ? ` ${theme.dim(`(${formatDuration(row.elapsedMs)})`)}` : '';
      const detail = row.detail ? ` ${theme.dim(row.detail)}` : '';
      process.stdout.write(
        `\x1b[2K  ${icon} ${row.name.padEnd(this.width)} ${stage}${detail}${elapsed}\n`,
      );
    }
    process.stdout.write(`\x1b[2K${this.footerLine()}\n`);
    this.rendered = this.rows.length + 1;
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
    if (state === 'working' && row.startedAt === undefined) row.startedAt = Date.now();
    if ((state === 'done' || state === 'failed') && row.startedAt !== undefined) {
      row.elapsedMs = Date.now() - row.startedAt;
      row.startedAt = undefined;
    }
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
