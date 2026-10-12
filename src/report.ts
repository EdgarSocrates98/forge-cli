import { note } from '@clack/prompts';
import type { RepoResult, RepoStatus } from './types.js';
import { S } from './ui/strings.js';
import { icons, theme } from './ui/theme.js';

export function statusBadge(status: RepoStatus): string {
  if (status === 'ok') return `${icons.ok} ${theme.ok(S.labelOk)}`;
  if (status === 'warning') return `${icons.warn} ${theme.warn(S.labelWarn)}`;
  return `${icons.err} ${theme.err(S.labelErr)}`;
}

export function formatElapsed(elapsedMs: number): string {
  return `em ${(elapsedMs / 1000).toFixed(1)}s`;
}

export function resultLine(result: RepoResult): string {
  const envPart = result.envNote ? ` · ${icons.env} ${result.envNote}` : '';
  return `${statusBadge(result.status)} ${result.repo.name} — ${result.detail}${envPart} ${theme.dim(formatElapsed(result.elapsedMs))}`;
}

export function renderReport(results: RepoResult[]): void {
  const ok = results.filter((r) => r.status === 'ok').length;
  const warnings = results.filter((r) => r.status === 'warning').length;
  const errors = results.filter((r) => r.status === 'error').length;

  const body = results.map(resultLine).join('\n');
  const totals = `${theme.ok(`${icons.ok} ${ok}`)} · ${theme.warn(`${icons.warn} ${warnings}`)} · ${theme.err(`${icons.err} ${errors}`)}`;
  note(`${body}\n\n${totals}`, S.reportTitle);
}
