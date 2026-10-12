import { note } from '@clack/prompts';
import type { CliState } from './artifacts.js';
import type { ForgeRepo, RepoResult, RepoStatus } from './types.js';
import { S } from './ui/strings.js';
import { icons, kindIcon, theme } from './ui/theme.js';

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
  const notesPart = result.notes?.length ? ` · ${theme.dim(result.notes.join(' · '))}` : '';
  const stepsPart =
    result.status === 'ok' && result.repo.nextSteps?.length
      ? `\n   ↳ ${theme.dim(`${S.nextStepsTitle}: ${result.repo.nextSteps.join(' · ')}`)}`
      : '';
  return `${statusBadge(result.status)} ${result.repo.name} — ${result.detail}${envPart}${notesPart} ${theme.dim(formatElapsed(result.elapsedMs))}${stepsPart}`;
}

export function totalElapsed(results: RepoResult[]): number {
  return results.reduce((acc, r) => acc + r.elapsedMs, 0);
}

export function slowestRepo(results: RepoResult[]): RepoResult | undefined {
  return results.reduce<RepoResult | undefined>(
    (max, r) => (max === undefined || r.elapsedMs > max.elapsedMs ? r : max),
    undefined,
  );
}

export function mergeResults(prev: RepoResult[], next: RepoResult[]): RepoResult[] {
  const byName = new Map(next.map((r) => [r.repo.name, r]));
  const merged = prev.map((r) => byName.get(r.repo.name) ?? r);
  for (const r of next) {
    if (!prev.some((p) => p.repo.name === r.repo.name)) merged.push(r);
  }
  return merged;
}

export function listLine(repo: ForgeRepo, entry?: CliState['repos'][string]): string {
  const prefix = `${kindIcon[repo.kind]} ${repo.name}`;
  if (!entry) return `${prefix} — ${theme.dim(S.listNever)}`;
  const when = entry.at.slice(0, 16).replace('T', ' ');
  return `${prefix} — ${statusBadge(entry.status)} ${theme.dim(`(${when})`)}`;
}

export function renderReport(results: RepoResult[]): void {
  const ok = results.filter((r) => r.status === 'ok').length;
  const warnings = results.filter((r) => r.status === 'warning').length;
  const errors = results.filter((r) => r.status === 'error').length;

  const body = results.map(resultLine).join('\n');
  const totals = `${theme.ok(`${icons.ok} ${ok}`)} · ${theme.warn(`${icons.warn} ${warnings}`)} · ${theme.err(`${icons.err} ${errors}`)}`;
  const slowest = slowestRepo(results);
  const meta = slowest
    ? `${theme.dim(`${S.totalTime} ${formatElapsed(totalElapsed(results))} · ${S.slowestRepo} ${slowest.repo.name} ${formatElapsed(slowest.elapsedMs)}`)}`
    : '';
  note(`${body}\n\n${totals}${meta ? `\n${meta}` : ''}`, S.reportTitle);
}
