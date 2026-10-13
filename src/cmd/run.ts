import type { ResolvedCommand } from '../commands.js';
import { cancel, confirm, isCancel, log, note, outro } from '@clack/prompts';
import {
  failedRepoNames,
  loadState,
  openRunLog,
  recordResult,
  withLog,
  writeJsonReport,
} from '../artifacts.js';
import { type CliOptions, isNonInteractive, resolveSelection } from '../cli-args.js';
import { loadConfig } from '../config.js';
import { executionSummary, planLines, summaryLines } from '../plan.js';
import { collectStatus } from '../status.js';
import { askConfirm, askRepos, askTrustCustom, askWorkspace } from '../prompts.js';
import { mergeResults, renderReport, resultLine } from '../report.js';
import { processPool, type RunOptions } from '../runner.js';
import type { ForgeRepo, RepoResult } from '../types.js';
import { S } from '../ui/strings.js';
import { icons, theme } from '../ui/theme.js';
import { currentHead, hasGitRepo, resolveTargetDir } from '../utils/system.js';
import { executeUninstall, planUninstall } from '../lifecycle.js';
import { resolveInside } from '../safety.js';
import { checkEnvironment, catalogFor, REFUSAL_TEXT } from './shared.js';
import { processBatch } from './batch.js';

export async function reviewExecution(
  repos: ForgeRepo[],
  targetDir: string,
  cli: CliOptions,
): Promise<{ trusted: Set<string>; denied: Set<string> }> {
  const trusted = new Set<string>();
  const denied = new Set<string>();
  const summaries = await Promise.all(
    repos.map((repo) =>
      executionSummary(repo, targetDir, {
        profile: cli.profile,
        scope: cli.scope,
        components: cli.components,
        host: cli.host,
        gatewayProfile: cli.gatewayProfile,
        approve: cli.yes,
      }),
    ),
  );
  note(
    summaries
      .map(
        (s) =>
          `${theme.accent(s.name)}\n${summaryLines(s)
            .map((l) => `  ${theme.dim(l)}`)
            .join('\n')}`,
      )
      .join('\n\n'),
    S.approvalTitle,
  );
  for (const repo of repos) {
    if (repo.origin !== 'custom' || cli.trustCustom || cli.skipScripts) continue;
    if (await askTrustCustom(repo.name)) trusted.add(repo.name);
    else denied.add(repo.name);
  }
  return { trusted, denied };
}

export async function runInstallFlow(
  cli: CliOptions,
  resolved: ResolvedCommand,
  cloneOnly: boolean,
): Promise<void> {
  await checkEnvironment();

  const interactive = !isNonInteractive(cli);
  const targetDir = interactive
    ? cli.dir
      ? resolveTargetDir(cli.dir)
      : await askWorkspace()
    : resolveTargetDir(cli.dir);
  const catalog = catalogFor(targetDir);

  const cfgResult = loadConfig(targetDir);
  if (cfgResult && 'error' in cfgResult) log.warn(S.configInvalid);
  const cfg = cfgResult && 'config' in cfgResult ? cfgResult.config : {};
  const effectiveCli: CliOptions = {
    ...cli,
    only: cli.only ?? cfg.only,
    timeoutSecs: cli.timeoutSet ? cli.timeoutSecs : (cfg.timeout ?? cli.timeoutSecs),
    jsonReport: cli.jsonSet ? cli.jsonReport : cli.jsonReport || cfg.json === true,
    jobs: cli.jobsSet ? cli.jobs : (cfg.jobs ?? cli.jobs),
    shallow: cli.shallow || cfg.shallow === true,
  };
  const nonInteractive = !interactive || (effectiveCli.only?.length ?? 0) > 0;

  let repos: ForgeRepo[];
  let review: { trusted: Set<string>; denied: Set<string> } | undefined;
  if (!nonInteractive) {
    const infos = await collectStatus(catalog, targetDir, loadState(targetDir));
    repos = await askRepos(catalog, { status: new Map(infos.map((i) => [i.name, i])) });
    if (!cli.yes) {
      review = await reviewExecution(repos, targetDir, cli);
      await askConfirm(targetDir, repos.length, catalog.length);
    }
  } else if (cli.retryFailed) {
    const state = loadState(targetDir);
    if (!state) {
      log.error(S.errNoState);
      process.exit(2);
    }
    const failed = new Set(failedRepoNames(state));
    repos = catalog.filter((r) => failed.has(r.name));
    if (!repos.length) {
      log.info(S.noFailedRepos);
      process.exit(0);
    }
    log.info(`${S.selectedRepos}: ${repos.map((r) => r.name).join(', ')}`);
  } else {
    const selection = resolveSelection(effectiveCli, catalog);
    if ('error' in selection) {
      log.error(selection.error);
      process.exit(2);
    }
    repos = selection.repos;
    log.info(`${S.selectedRepos}: ${repos.map((r) => r.name).join(', ')}`);
    if (interactive && !cli.yes) {
      review = await reviewExecution(repos, targetDir, cli);
      await askConfirm(targetDir, repos.length, catalog.length);
    }
  }

  const refs: Record<string, string> = {};
  const pinState = loadState(targetDir);
  for (const repo of repos) {
    const pin = pinState?.pins?.[repo.name];
    if (pin) refs[repo.name] = pin;
  }
  if (resolved.command === 'reinstall') {
    for (const repo of repos) {
      const dir = resolveInside(targetDir, repo.name);
      if (!dir || !hasGitRepo(dir) || refs[repo.name]) continue;
      const head = await currentHead(dir);
      if (head) refs[repo.name] = head;
    }
    if (cli.clean) {
      if (!cli.yes && !cli.plan) {
        log.error(S.uninstallNeedsYes);
        process.exit(2);
      }
      for (const repo of repos) {
        const plan = await planUninstall(targetDir, repo);
        if (plan.kind === 'refused') {
          log.error(`${repo.name}: ${S.uninstallRefused} — ${REFUSAL_TEXT[plan.reason]}`);
          process.exit(1);
        }
        if (plan.kind === 'ready' && !cli.plan) {
          const backup = executeUninstall(targetDir, repo, plan);
          if (backup) log.info(`${S.uninstallBackupAt}: ${theme.dim(backup)}`);
        }
      }
    }
  }

  if (cli.ref && repos.length !== 1) {
    log.error(S.errRefNeedsOne);
    process.exit(2);
  }

  if (cli.plan) {
    const body = repos
      .map(
        (repo) =>
          `${theme.accent(repo.name)}\n${planLines(repo, targetDir)
            .map((line) => `  ${theme.dim(line)}`)
            .join('\n')}`,
      )
      .join('\n\n');
    note(body, S.planTitle);
    return;
  }

  const opts: RunOptions = {
    skipScripts: cli.skipScripts,
    ref: cli.ref,
    refs,
    cloneOnly,
    offline: cli.offline,
    native: {
      profile: cli.profile,
      scope: cli.scope,
      components: cli.components,
      host: cli.host,
      gatewayProfile: cli.gatewayProfile,
      approve: cli.yes,
    },
    nativeUpdate: resolved.command === 'update' && cli.native,
    skipVerify: cli.skipVerify,
    timeoutMs: effectiveCli.timeoutSecs * 1000,
    shallow: effectiveCli.shallow,
    trustCustom: cli.trustCustom,
    trustedRepos: review?.trusted,
    deniedScripts: review?.denied,
    runAfterSyncFailure: cli.runAfterSyncFailure,
    onlyChanged: effectiveCli.onlyChanged,
    state: effectiveCli.onlyChanged ? loadState(targetDir)?.repos : undefined,
  };
  const jobs = interactive ? 1 : effectiveCli.jobs;
  if (interactive && effectiveCli.jobs > 1) log.warn(S.jobsIgnored);
  const runLog = openRunLog(targetDir);
  runLog.write(
    `# forge-cli ${new Date().toISOString()} dir=${targetDir} jobs=${jobs} onlyChanged=${effectiveCli.onlyChanged}`,
  );
  let results: RepoResult[];
  if (jobs > 1) {
    results = await processPool(
      repos,
      targetDir,
      opts,
      jobs,
      (repo, index) =>
        withLog(
          {
            phase: (p) =>
              log.info(`${theme.dim(`[${index + 1}/${repos.length}]`)} ${repo.name} — ${p}`),
          },
          (line) => runLog.write(`[${repo.name}] ${line}`),
        ),
      (result) => {
        runLog.write(`[result] ${result.repo.name} ${result.status}: ${result.detail}`);
        log.info(resultLine(result));
      },
    );
    for (const result of results) recordResult(targetDir, result);
  } else {
    results = await processBatch(repos, targetDir, opts, runLog.write, 0, repos.length);
  }

  renderReport(results);

  if (interactive && results.some((r) => r.status === 'error')) {
    const retry = await confirm({ message: S.askRetry, initialValue: true });
    if (isCancel(retry)) {
      cancel(S.cancelled);
      process.exit(0);
    }
    if (retry) {
      const failed = results.filter((r) => r.status === 'error').map((r) => r.repo);
      const retried = await processBatch(failed, targetDir, opts, runLog.write, 0, failed.length);
      results = mergeResults(results, retried);
      renderReport(results);
    }
  }

  if (effectiveCli.jsonReport) {
    const file = writeJsonReport(targetDir, results, cli.reportPath);
    log.info(`${S.reportSaved}: ${theme.dim(file)}`);
  }
  log.info(`${S.logSaved}: ${theme.dim(runLog.file)}`);

  const hasErrors = results.some((r) => r.status === 'error');
  outro(`${icons.rocket} ${hasErrors ? S.outroWithErrors : S.outroOk}`);
  if (hasErrors) process.exitCode = 1;
}
