// Progress primitives — Unicode block bars, humanized durations, ETA.
// Pure functions: no ANSI inside except what callers add via theme/gradient,
// so JSON/quiet paths stay byte-clean by simply not calling renderers.

// eslint-disable-next-line no-control-regex -- ANSI CSI precisa do ESC literal
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Largura visível de uma string com escapes ANSI. */
export function visibleWidth(text: string): number {
  return text.replace(ANSI_RE, '').length;
}

/**
 * Barra determinística `[██████░░░░]` — `ratio` ∈ [0,1].
 * `width` conta só os blocos (sem os colchetes).
 */
export function progressBar(ratio: number, width = 20): string {
  const clamped = Math.min(1, Math.max(0, ratio));
  const filled = Math.round(clamped * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

/** Duração humanizada: `3.4s`, `1m 12s`, `2h 05m`. */
export function formatDuration(ms: number): string {
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.round(secs % 60);
  if (mins < 60) return `${mins}m ${String(rem).padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${String(mins % 60).padStart(2, '0')}m`;
}

/**
 * ETA linear: elapsed/done × remaining. Devolve `null` quando a estimativa
 * não é honesta (0 concluídos ou total inválido).
 */
export function estimateEtaMs(done: number, total: number, elapsedMs: number): number | null {
  if (done <= 0 || total <= done) return null;
  return (elapsedMs / done) * (total - done);
}
