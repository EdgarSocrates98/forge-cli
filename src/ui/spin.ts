import { spinner } from '@clack/prompts';
import { formatDuration } from './progress.js';

export interface SpinOptions {
  /** Sem TTY ou modo quiet: executa sem spinner (zero saída extra). */
  quiet?: boolean;
  /** Mensagem final no sucesso — default: label original + duração. */
  done?: (elapsedMs: number) => string;
}

/**
 * `withSpinner(label, fn)` — spinner clack com elapsed no stop.
 * Em pipe/--json/não-TTY é um pass-through silencioso (contrato JSON intacto).
 */
export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>,
  opts: SpinOptions = {},
): Promise<T> {
  const quiet = opts.quiet === true || !process.stdout.isTTY;
  if (quiet) return fn();
  const started = Date.now();
  const s = spinner({ indicator: 'timer' });
  s.start(label);
  try {
    const result = await fn();
    s.stop(
      opts.done
        ? opts.done(Date.now() - started)
        : `${label} — ${formatDuration(Date.now() - started)}`,
    );
    return result;
  } catch (error) {
    s.error(label);
    throw error;
  }
}
