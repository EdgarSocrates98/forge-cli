import { log, note } from '@clack/prompts';
import type { CliOptions } from '../cli-args.js';
import { catalogFor, emitJson } from './shared.js';
import { answerDiscovery, answerRecommendation, answerRepair } from '../intel/engine.js';
import { buildForgeContext } from '../intel/context.js';
import { predictCompatibility } from '../intel/predict.js';
import type { IntelAnswer } from '../intel/contracts.js';
import { runAiBridge } from '../ai/bridge.js';
import type { AiBridgeConfig, AiRequest } from '../ai/types.js';
import { exportBundle, importBundle, SecretKeysRefusedError } from '../portability/bundle.js';
import {
  disableLearning,
  enableLearning,
  learningReport,
  learningStatus,
} from '../intel/learning.js';
import { loadConfig } from '../config.js';
import { resolveTargetDir } from '../utils/system.js';
import { S } from '../ui/strings.js';
import { theme } from '../ui/theme.js';

function renderAnswers(answers: readonly IntelAnswer[]): string {
  return answers
    .map((a) => {
      const ev = a.evidence.length
        ? a.evidence.map((e) => `    ◦ ${e.source}: ${e.fact}`).join('\n')
        : `    ◦ ${S.intelNoEvidence}`;
      const lim = a.limitations.length
        ? `\n    ${theme.dim(S.intelLimits)} ${a.limitations.join('; ')}`
        : '';
      return `${a.question}\n  ${a.answer} ${theme.dim(`[${a.confidence}]`)}\n${ev}${lim}`;
    })
    .join('\n\n');
}

/** forge-cli ask <discovery|recommendation|repair> — §6.1 deterministic intelligence. */
export async function runAskCommand(cli: CliOptions): Promise<number> {
  const targetDir = resolveTargetDir(cli.dir);
  const domain = cli.positionals[1];
  const repos = catalogFor(targetDir);
  const answers =
    domain === 'discovery'
      ? await answerDiscovery(targetDir, repos)
      : domain === 'recommendation'
        ? await answerRecommendation(targetDir, repos)
        : domain === 'repair'
          ? await answerRepair(targetDir, repos)
          : null;
  if (!answers) {
    log.error(`${S.intelBadDomain}: ${domain ?? '—'}`);
    return 1;
  }
  if (cli.jsonReport) emitJson({ schema: 'forge/IntelAnswers/v1', domain, answers });
  note(renderAnswers(answers), `${S.askTitle} — ${domain}`);
  return 0;
}

/** forge-cli predict — §6.5 predictive compatibility. */
export async function runPredictCommand(cli: CliOptions): Promise<number> {
  const targetDir = resolveTargetDir(cli.dir);
  const predictions = await predictCompatibility(targetDir, catalogFor(targetDir));
  if (cli.jsonReport) emitJson({ schema: 'forge/PredictionReport/v1', predictions });
  note(
    predictions.length
      ? predictions
          .map(
            (p) =>
              `${p.id} — ${p.subject} ${theme.dim(`[${p.certainty}]`)}\n  ${p.explanation}\n  ${theme.dim(
                p.evidence.map((e) => `${e.source}: ${e.fact}`).join(' · '),
              )}`,
          )
          .join('\n\n')
      : S.predictNone,
    S.predictTitle,
  );
  return 0;
}

/** forge-cli context — §6.4 bounded structured context (the AI-mode input). */
export async function runContextCommand(cli: CliOptions): Promise<number> {
  const targetDir = resolveTargetDir(cli.dir);
  const ctx = await buildForgeContext(targetDir, catalogFor(targetDir), {});
  if (cli.jsonReport) emitJson(ctx);
  note(JSON.stringify(ctx, null, 2), S.contextTitle);
  return 0;
}

const AI_TASKS = new Set([
  'explain-error',
  'summarize-diagnosis',
  'recommend-alternatives',
  'suggest-tasks',
]);

/** forge-cli ai <task> — §6.3 optional AI mode (opt-in via forge-cli.config.json). */
export async function runAiCommand(cli: CliOptions): Promise<number> {
  const targetDir = resolveTargetDir(cli.dir);
  const task = cli.positionals[1];
  if (!task || !AI_TASKS.has(task)) {
    log.error(`${S.aiBadTask}: ${task ?? '—'} (${[...AI_TASKS].join(', ')})`);
    return 1;
  }
  const cfgResult = loadConfig(targetDir);
  const aiCfg = cfgResult && 'config' in cfgResult ? cfgResult.config.ai : undefined;
  const bridgeCfg: AiBridgeConfig = {
    enabled: aiCfg?.enabled === true,
    command: aiCfg?.command ?? [],
    maxContextBytes: aiCfg?.maxContextBytes ?? 8192,
    timeoutMs: aiCfg?.timeoutMs ?? 60000,
    cacheTtlMs: aiCfg?.cacheTtlMs ?? 0,
  };
  const context = await buildForgeContext(targetDir, catalogFor(targetDir), {
    maxBytes: bridgeCfg.maxContextBytes,
  });
  const req: AiRequest = { task: task as AiRequest['task'], context };
  const catalog = catalogFor(targetDir);
  const result = await runAiBridge(req, bridgeCfg, {
    catalog: {
      forjas: catalog.map((r) => r.name),
      hosts: [],
      verbs: [],
    },
  });
  if (cli.jsonReport) emitJson(result);
  if (!result.ok) {
    if (result.reason === 'disabled' || result.reason === 'no-bridge') {
      log.warn(`${S.aiDisabled} (${result.reason})`);
      return 0;
    }
    log.error(`${S.aiFailed}: ${result.reason}${result.detail ? ` — ${result.detail}` : ''}`);
    return 1;
  }
  const p = result.proposal;
  note(
    `${p.summary}\n\n${p.items
      .map((i) => `• ${i.title}${i.ref ? ` ${theme.dim(`(${i.ref})`)}` : ''}\n  ${i.detail}`)
      .join('\n')}${result.cached ? `\n\n${theme.dim(S.aiCached)}` : ''}`,
    S.aiTitle,
  );
  return 0;
}

/** forge-cli bundle <export|import|verify> [path] — §6.6 portability. */
export async function runBundleCommand(cli: CliOptions): Promise<number> {
  const targetDir = resolveTargetDir(cli.dir);
  const verb = cli.positionals[1];
  const dest = cli.positionals[2];
  if (verb === 'export') {
    if (!dest) {
      log.error(S.bundleNeedsPath);
      return 1;
    }
    try {
      const result = await exportBundle(targetDir, catalogFor(targetDir), dest, {
        includeEnvKeys: cli.positionals.slice(3),
      });
      if (cli.jsonReport) emitJson(result);
      log.success(`${S.bundleExported}: ${dest}`);
      return 0;
    } catch (err) {
      if (err instanceof SecretKeysRefusedError) {
        log.error(`${S.bundleSecretRefused}: ${err.keys.join(', ')}`);
        return 1;
      }
      throw err;
    }
  }
  if (verb === 'import' || verb === 'verify') {
    if (!dest) {
      log.error(S.bundleNeedsPath);
      return 1;
    }
    let result;
    try {
      result = importBundle(dest);
    } catch (err) {
      log.error(`${S.bundleInvalid}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (cli.jsonReport) emitJson(result);
    if (!result.verify.ok) {
      log.error(`${S.bundleTampered}: ${result.verify.mismatches.join(', ')}`);
      return 1;
    }
    if (verb === 'verify') {
      log.success(S.bundleIntact);
      return 0;
    }
    log.success(`${S.bundleImported} — ${result.pins.length} ${S.bundlePins}`);
    return 0;
  }
  log.error(`${S.bundleBadVerb}: ${verb ?? '—'}`);
  return 1;
}

/** forge-cli learning <status|enable|disable|report> — §6.7 local opt-in. */
export async function runLearningCommand(cli: CliOptions): Promise<number> {
  const targetDir = resolveTargetDir(cli.dir);
  const verb = cli.positionals[1];
  if (verb === 'enable') {
    enableLearning(targetDir);
    log.success(S.learningEnabled);
    return 0;
  }
  if (verb === 'disable') {
    disableLearning(targetDir);
    log.success(S.learningDisabled);
    return 0;
  }
  if (verb === 'report') {
    const report = learningReport(targetDir);
    if (cli.jsonReport) emitJson(report);
    note(
      report.observations === 0
        ? S.learningEmpty
        : Object.entries(report.byKind)
            .map(([k, n]) => `${k}: ${n}`)
            .join('\n'),
      S.learningTitle,
    );
    return 0;
  }
  const status = learningStatus(targetDir);
  if (cli.jsonReport) emitJson(status);
  log.info(
    `${S.learningTitle}: ${status.enabled ? S.learningOn : S.learningOff} — ${status.observations} obs (${status.path})`,
  );
  return 0;
}
