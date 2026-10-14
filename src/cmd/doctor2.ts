import { cancel, confirm, isCancel, log, note } from '@clack/prompts';
import { type CliOptions, isNonInteractive } from '../cli-args.js';
import { runDoctor2, renderDoctorReport } from '../doctor2/index.js';
import type { DoctorCheck } from '../doctor2/model.js';
import { healReceiptPath, planRepairs, runHealFlow } from '../heal/index.js';
import type { RepairPlan } from '../heal/index.js';
import { resolveTargetDir } from '../utils/system.js';
import { emitJson } from './shared.js';
import { S } from '../ui/strings.js';
import { theme } from '../ui/theme.js';

/** Checks worth feeding to the repair planner — failures and warnings. */
function repairable(checks: readonly DoctorCheck[]): DoctorCheck[] {
  return checks.filter((c) => c.result === 'fail' || c.result === 'warn');
}

function describePlan(plan: RepairPlan): string {
  return plan.items
    .map((item) => {
      const head = `${item.check.id} — ${item.check.diagnosis}`;
      const risk = `  ${S.healRiskLabel}: ${item.riskClass}${item.check.reversible === false ? ` (${S.doctor2NotReversible})` : ''}`;
      const steps = item.steps.length
        ? item.steps
            .map(
              (s) =>
                `    • ${s.description}${s.touches.length ? ` — ${s.touches.join(', ')}` : ''}`,
            )
            .join('\n')
        : item.riskClass === 'UNSUPPORTED'
          ? `    • ${S.healUnsupportedNote}`
          : '';
      return `${head}\n${risk}${steps ? `\n${steps}` : ''}`;
    })
    .join('\n\n');
}

function printReceipt(receipt: Awaited<ReturnType<typeof runHealFlow>>, file: string): void {
  const rows = receipt.entries
    .map((e) => {
      const badge =
        e.status === 'verified'
          ? theme.ok('✔')
          : e.status === 'failed'
            ? theme.err('✖')
            : e.status === 'refused'
              ? theme.err('■')
              : theme.warn('–');
      return `${badge} ${e.checkId} — ${e.status} · ${theme.dim(e.evidence)}`;
    })
    .join('\n');
  note(rows || S.healNoFindings, S.healReceiptSaved);
  log.info(`${S.healReceiptSaved}: ${theme.dim(file)}`);
}

/**
 * `forge heal` — §5.2 flow: diagnose → classify → plan → assess risk →
 * confirm → apply → verify → receipt. Never silent: --yes applies only
 * SAFE_AUTOMATIC repairs; REVIEW_REQUIRED needs the interactive confirm.
 */
export async function runHealCommand(cli: CliOptions): Promise<number> {
  const root = resolveTargetDir(cli.dir);
  const report = await runDoctor2(root);
  const findings = repairable(report.checks);
  if (!findings.length) {
    if (cli.jsonReport) emitJson({ findings: 0, receipt: null });
    log.success(S.healNoFindings);
    return 0;
  }

  const nonInteractive = isNonInteractive(cli);
  const confirmed: 'user' | 'flag' | 'never' = cli.yes ? 'flag' : nonInteractive ? 'never' : 'user';
  const dryRun = cli.plan || confirmed === 'never';

  const { plan } = await planRepairs(findings, { root, dryRun });
  note(describePlan(plan), S.healTitle);
  if (cli.jsonReport && dryRun) emitJson(plan);

  if (dryRun) {
    log.warn(S.healDryRun);
    return 0;
  }

  const receipt = await runHealFlow(findings, {
    root,
    dryRun: false,
    confirmed,
    allowReviewRequired: false, // --yes never auto-applies reviewable repairs
    confirmCallback:
      confirmed === 'user'
        ? async () => {
            const go = await confirm({ message: S.healAskReview });
            if (isCancel(go)) {
              cancel(S.menuExit);
              return false;
            }
            return go === true;
          }
        : undefined,
  });

  const file = healReceiptPath(root, receipt.generatedAt);
  if (cli.jsonReport) emitJson(receipt, receipt.verifiedAll ? 0 : 1);
  printReceipt(receipt, file);
  if (receipt.verifiedAll) log.success(S.healAllVerified);
  else log.warn(S.healPending);
  return receipt.verifiedAll ? 0 : 1;
}

/** `forge doctor` — Doctor 2.0 report; `--fix` chains into the heal flow. */
export async function runDoctor2Command(cli: CliOptions): Promise<number> {
  const root = resolveTargetDir(cli.dir);
  const report = await runDoctor2(root);
  if (cli.jsonReport) {
    emitJson(report, report.checks.some((c) => c.result === 'fail') ? 1 : 0);
  }
  note(renderDoctorReport(report), S.doctorTitle);

  if (!cli.fix) {
    return report.checks.some((c) => c.result === 'fail') ? 1 : 0;
  }
  return runHealCommand({ ...cli, plan: cli.plan });
}
