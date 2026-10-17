import { cancel, confirm, isCancel, log, multiselect, note, select, spinner } from '@clack/prompts';
import { loadState } from './artifacts.js';
import type { CliOptions } from './cli-args.js';
import { catalogFor } from './cmd/shared.js';
import { collectStatus } from './status.js';
import { discoverEnvironment } from './discovery.js';
import { recommendForjas, type RecommendResult } from './recommend.js';
import {
  buildPlan,
  filterSteps,
  predictedChanges,
  SELECTABLE_STEPS,
  type OperationPlan,
  type PlanAction,
  type PlanForge,
  type SelectableStep,
} from './planner.js';
import { runInstallFlow } from './cmd/run.js';
import type { ForgeRepo } from './types.js';
import { S } from './ui/strings.js';
import { theme } from './ui/theme.js';
import { hasGitRepo, resolveTargetDir } from './utils/system.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

// §2.3 TUI wizard: detect → recommend → customize → review → install →
// validate → summarize. Deterministic, cancellable at every step with no
// side effects until step 5; non-interactive mode is preserved by routing
// around the wizard entirely (isNonInteractive check in index.ts).

const STEP_LABELS = [
  S.wizardStepDetect,
  S.wizardStepRecommend,
  S.wizardStepCustomize,
  S.wizardStepReview,
  S.wizardStepInstall,
  S.wizardStepValidate,
  S.wizardStepSummary,
];

function stepTitle(n: number): string {
  return `${S.wizardStepPrefix} ${n}/7 — ${STEP_LABELS[n - 1]}`;
}

function bail(): never {
  cancel(S.wizardCancelSafe);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 4 helpers — plan rendering (also used by `forge-cli plan` surfaces).
// ---------------------------------------------------------------------------

export function renderOperationPlan(plan: OperationPlan): string {
  const lines: string[] = [
    `${S.planHashLabel}: ${theme.accent(plan.hash.slice(0, 16))}…`,
    `${S.planExpiresAt}: ${plan.expires_at}`,
  ];
  if (plan.selected_steps?.length) {
    lines.push(`${S.planStepsLabel}: ${plan.selected_steps.join(', ')}`);
  }
  for (const forge of plan.forges) {
    const changes = predictedChanges(forge);
    lines.push('', theme.accent(forge.forge_id));
    for (const action of forge.actions) {
      const rev = action.reversible ? '' : ` ${theme.dim('[' + S.rollbackScopeNote + ']')}`;
      lines.push(`  · ${action.label}${rev}`);
    }
    if (changes.files.length) {
      lines.push(`  ${theme.dim('arquivos:')} ${changes.files.slice(0, 8).join(', ')}`);
    }
  }
  return lines.join('\n');
}

export function planActionsFor(
  repo: ForgeRepo,
  targetDir: string,
  steps: readonly SelectableStep[],
): PlanAction[] {
  const repoDir = path.join(targetDir, repo.name);
  const cloned = existsSync(repoDir) && hasGitRepo(repoDir);
  const actions: PlanAction[] = [
    {
      kind: 'clone',
      label: cloned ? `git pull --ff-only (${repo.name})` : `git clone ${repo.name}`,
      argv: cloned
        ? ['git', '-C', repoDir, 'pull', '--ff-only']
        : ['git', 'clone', repo.url, repoDir],
      reversible: true,
    },
  ];
  if (steps.includes('binary')) {
    actions.push({
      kind: 'binary',
      label: 'setup/bootstrap detectado pós-clone',
      reversible: true,
      non_reversible_effects: ['dependências instaladas no ambiente'],
    });
  }
  // .env sempre entra no plano — não é passo selecionável (§2.4: nunca sobrescreve)
  actions.push({
    kind: 'env',
    label: 'provisionar .env (nunca sobrescreve)',
    paths: [path.join(repo.name, '.env')],
    reversible: false,
  });
  if (steps.includes('skills')) {
    actions.push({ kind: 'skills', label: 'skills via instalador nativo', reversible: false });
  }
  if (steps.includes('agents')) {
    actions.push({ kind: 'agents', label: 'agents via instalador nativo', reversible: false });
  }
  if (steps.includes('mcp')) {
    actions.push({ kind: 'mcp', label: 'registro MCP (se suportado)', reversible: false });
  }
  if (steps.includes('host-integration')) {
    actions.push({
      kind: 'host-integration',
      label: 'integração com host de IA',
      reversible: false,
      non_reversible_effects: ['configs do host fora do workspace'],
    });
  }
  actions.push({
    kind: 'verify',
    label: repo.verify?.length
      ? `verificar: ${repo.verify.join(' ')}`
      : 'sem verificação declarada',
    reversible: true,
  });
  return actions;
}

// ---------------------------------------------------------------------------

export async function runWizard(cli: CliOptions): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const catalog = catalogFor(targetDir);

  // Step 1 — detect
  const s1 = spinner();
  s1.start(stepTitle(1));
  const report = await discoverEnvironment(targetDir);
  s1.stop(
    `${stepTitle(1)} — ${report.tools.filter((t) => t.found).length}/${report.tools.length} tools, ${report.signals.length} sinais`,
  );
  if (report.truncated) log.warn(S.discoverTruncated);
  if (report.signals.length) note(report.signals.join(', '), S.discoverSignals);

  // Step 2 — recommend
  const rec: RecommendResult = recommendForjas(report, catalog);
  if (rec.recommendations.length) {
    note(
      rec.recommendations
        .map(
          (r) =>
            `${theme.accent(r.forge_id)} (${S.recommendConfidence} ${Math.round(r.confidence * 100)}%)\n` +
            r.why.map((w) => `  ${theme.dim('·')} ${w}`).join('\n'),
        )
        .join('\n\n'),
      `${stepTitle(2)} — ${S.recommendTitle}`,
    );
  } else {
    log.info(S.recommendNone);
  }
  if (rec.questions.length || rec.confidence < 0.5) {
    log.warn(`${S.recommendLowConfidence} (${Math.round(rec.confidence * 100)}%)`);
    for (const q of rec.questions) log.info(`  ${theme.dim('?')} ${q}`);
  }

  // Step 3 — customize (forjas + passos selecionáveis + perfil/escopo)
  const suggested = rec.recommendations.filter((r) => r.confidence >= 0.5).map((r) => r.forge_id);
  const picked = await multiselect({
    message: S.askRepos,
    options: catalog.map((repo) => ({
      value: repo.name,
      label: repo.name,
      hint: rec.recommendations.find((r) => r.forge_id === repo.name)
        ? `${S.recommendTitle.toLowerCase()} · ${repo.description}`
        : repo.description,
    })),
    initialValues: suggested.length ? suggested : undefined,
    required: true,
  });
  if (isCancel(picked)) bail();
  const repos = catalog.filter((r) => (picked as string[]).includes(r.name));

  const stepPick = await multiselect({
    message: `${stepTitle(3)} — ${S.wizardPlanSteps}`,
    options: SELECTABLE_STEPS.map((s) => ({
      value: s as string,
      label: s,
      hint: s === 'clone' ? 'git clone/pull' : 'instalador nativo / integração',
    })),
    initialValues: [...SELECTABLE_STEPS] as string[],
    required: false,
  });
  if (isCancel(stepPick)) bail();
  const steps = stepPick as string[] as SelectableStep[];

  const nativeWanted = steps.some((s) => s !== 'clone');
  let profile: string | undefined;
  let scope: string | undefined;
  if (nativeWanted && repos.some((r) => r.nativeInstall)) {
    const p = await select({
      message: 'profile',
      options: ['recommended', 'minimal', 'full'].map((v) => ({ value: v, label: v })),
      initialValue: 'recommended',
    });
    if (isCancel(p)) bail();
    profile = p as string;
    const sc = await select({
      message: 'scope',
      options: ['workspace', 'project', 'user'].map((v) => ({ value: v, label: v })),
      initialValue: 'workspace',
    });
    if (isCancel(sc)) bail();
    scope = sc as string;
  }

  // Step 4 — review hashed plan
  const planForges: PlanForge[] = repos.map((repo) => ({
    forge_id: repo.name,
    repo: repo.name,
    target_dir: path.join(targetDir, repo.name),
    actions: filterSteps(planActionsFor(repo, targetDir, steps), steps),
  }));
  const plan = buildPlan({
    source: 'wizard',
    forges: planForges,
    selected_steps: steps,
    native: nativeWanted ? { profile, scope, approve: false } : undefined,
  });
  note(renderOperationPlan(plan), stepTitle(4));
  const go = await confirm({ message: S.confirmRun });
  if (isCancel(go) || !go) bail();

  // Steps 5-7 — delegate to the proven install flow (state, logs, reports,
  // retries, verify all preserved); the wizard's job was contextual selection.
  const effectiveCli: CliOptions = {
    ...cli,
    only: repos.map((r) => r.name),
    yes: true,
    profile,
    scope,
    components: steps.filter((s) => ['skills', 'agents', 'mcp'].includes(s)).join(',') || undefined,
    plan: false,
  };
  await runInstallFlow(
    effectiveCli,
    { command: 'install', names: repos.map((r) => r.name) },
    false,
  );

  // Step 6/7 evidence: post-install phases as the honest validation surface
  const infos = await collectStatus(repos, targetDir, loadState(targetDir));
  note(
    infos
      .map(
        (i) => `${i.name}: ${i.phase}${i.head ? ` @ ${i.head}` : ''}${i.dirty ? ' (dirty)' : ''}`,
      )
      .join('\n'),
    `${stepTitle(6)} / ${stepTitle(7)}`,
  );
}
