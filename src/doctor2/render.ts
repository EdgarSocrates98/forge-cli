/**
 * Doctor 2.0 — PT-BR terminal renderer for forge/DoctorReport/v1.
 *
 * `strings` holds every literal introduced by Doctor 2.0 so the parent can
 * merge them into ui/strings.js; only pre-existing S keys are reused
 * (labelOk/labelWarn/labelErr). A null score renders as NÃO VERIFICADO —
 * partial observation is never dressed up as 100%.
 */

import { S } from '../ui/strings.js';
import { theme } from '../ui/theme.js';
import type { CheckResult, DoctorCheck, DoctorDomain, DoctorReport } from './model.js';

export const strings = {
  doctor2Title: 'Diagnóstico Forge — saúde do ambiente',
  doctor2GeneratedAt: 'gerado em',
  doctor2Truncated: 'varredura limitada — resultados parciais',
  doctor2ScoreLabel: 'Saúde',
  doctor2ScoreUnverified: 'NÃO VERIFICADO',
  doctor2ScoreModel: 'modelo',
  doctor2Observed: 'checks com evidência',
  doctor2Evidence: 'evidência',
  doctor2Fix: 'correção',
  doctor2Reversible: 'reversível',
  doctor2NotReversible: 'não reversível',
  doctor2SkipLabel: '[—]',
  doctor2UnverifiedLabel: '[?]',
  doctor2Domains: {
    system: 'sistema',
    installation: 'instalação',
    environment: 'ambiente (.env)',
    hosts: 'hosts de IA',
    operations: 'operações',
  } as Record<DoctorDomain, string>,
};

const DOMAIN_ORDER: readonly DoctorDomain[] = [
  'system',
  'installation',
  'environment',
  'hosts',
  'operations',
];

function resultLabel(result: CheckResult): string {
  switch (result) {
    case 'pass':
      return S.labelOk;
    case 'warn':
      return S.labelWarn;
    case 'fail':
      return S.labelErr;
    case 'skip':
      return strings.doctor2SkipLabel;
    case 'unverified':
      return strings.doctor2UnverifiedLabel;
  }
}

function tag(check: DoctorCheck): string {
  const label = resultLabel(check.result);
  switch (check.result) {
    case 'pass':
      return theme.ok(label);
    case 'warn':
      return theme.warn(label);
    case 'fail':
      return theme.err(label);
    default:
      return theme.dim(label);
  }
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(strings.doctor2Title);
  lines.push(
    theme.dim(
      `${strings.doctor2GeneratedAt} ${report.generatedAt}` +
        (report.truncated ? ` · ${strings.doctor2Truncated}` : ''),
    ),
  );
  const { score } = report;
  const sufficiency = `${score.sufficiency.observed}/${score.sufficiency.required} ${strings.doctor2Observed}`;
  const scoreText =
    score.value === null
      ? `${strings.doctor2ScoreUnverified} (${sufficiency})`
      : `${score.value}/100 (${strings.doctor2ScoreModel} ${score.model} · ${sufficiency})`;
  lines.push(
    `${strings.doctor2ScoreLabel}: ` +
      (score.value === null ? theme.warn(scoreText) : theme.ok(scoreText)),
  );

  for (const domain of DOMAIN_ORDER) {
    const checks = report.checks.filter((c) => c.domain === domain);
    if (!checks.length) continue;
    lines.push('');
    lines.push(theme.accent(`[${strings.doctor2Domains[domain]}]`));
    for (const check of checks) {
      lines.push(`${tag(check)} ${check.id} — ${check.diagnosis}`);
      for (const evidence of check.evidence) {
        lines.push(theme.dim(`      ${strings.doctor2Evidence}: ${evidence}`));
      }
      if (check.correctiveAction) {
        const rev =
          check.reversible === true
            ? ` (${strings.doctor2Reversible})`
            : check.reversible === false
              ? ` (${strings.doctor2NotReversible})`
              : '';
        lines.push(`      ${strings.doctor2Fix}: ${check.correctiveAction}${rev}`);
      }
    }
  }
  return lines.join('\n');
}
