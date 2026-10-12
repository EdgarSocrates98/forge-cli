#!/usr/bin/env node
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  spinner,
  taskLog,
} from '@clack/prompts';
import figlet from 'figlet';
import {
  failedRepoNames,
  loadCustomRepos,
  loadState,
  mergeCatalog,
  openRunLog,
  recordResult,
  withLog,
  writeJsonReport,
} from './artifacts.js';
import {
  CliError,
  type CliOptions,
  isNonInteractive,
  parseCliArgs,
  resolveSelection,
  usage,
} from './cli-args.js';
import { FORGE_REPOS } from './constants/repos.js';
import { runDoctor } from './doctor.js';
import { planLines } from './plan.js';
import { runPreflight } from './preflight.js';
import { askConfirm, askRepos, askWorkspace } from './prompts.js';
import { mergeResults, renderReport, resultLine } from './report.js';
import { processRepo, type RepoReporter, type RunOptions } from './runner.js';
import type { ForgeRepo, RepoResult } from './types.js';
import { S } from './ui/strings.js';
import { icons, kindIcon, theme } from './ui/theme.js';
import { resolveTargetDir } from './utils/system.js';

const BANNER_LINE_DELAY_MS = 30;

async function printBanner(): Promise<void> {
  const art = figlet.textSync(S.bannerWord, { font: 'Standard' });
  for (const line of art.split('\n')) {
    console.log(theme.brand(line));
    await new Promise((resolve) => setTimeout(resolve, BANNER_LINE_DELAY_MS));
  }
}

async function checkEnvironment(): Promise<void> {
  log.step(`${icons.gear} ${S.preflightTitle}`);
  const checks = await runPreflight();
  for (const check of checks) {
    if (check.ok) {
      log.success(`${icons.ok} ${check.name} ${theme.dim(`(${check.detail})`)}`);
    } else if (check.severity === 'warn') {
      log.warn(`${icons.warn} ${check.name} ${theme.dim(`(${check.detail})`)}`);
    } else {
      log.error(`${icons.err} ${check.name} ${theme.dim(`(${check.detail})`)}`);
    }
  }
  if (checks.some((check) => !check.ok && check.severity === 'fatal')) {
    log.error(S.preflightFailed);
    process.exit(1);
  }
}

function catalogFor(targetDir: string): ForgeRepo[] {
  const custom = loadCustomRepos(targetDir);
  if (custom && 'repos' in custom) {
    const hasNew = custom.repos.some((r) => !FORGE_REPOS.some((c) => c.name === r.name));
    if (hasNew) log.info(`${S.customReposLoaded} ${theme.dim(`(${custom.repos.length})`)}`);
    return mergeCatalog(FORGE_REPOS, custom.repos);
  }
  if (custom && 'error' in custom) log.warn(S.customReposInvalid);
  return [...FORGE_REPOS];
}

async function processBatch(
  repos: ForgeRepo[],
  targetDir: string,
  opts: RunOptions,
  logWrite: (line: string) => void,
  offset = 0,
  total = repos.length,
): Promise<RepoResult[]> {
  const results: RepoResult[] = [];
  for (const [index, repo] of repos.entries()) {
    const label = `${theme.dim(`[${offset + index + 1}/${total}]`)} ${kindIcon[repo.kind]} ${theme.accent(repo.name)}`;
    let s = spinner({ indicator: 'timer' });
    s.start(label);
    let live: ReturnType<typeof taskLog> | undefined;

    const uiReporter: RepoReporter = {
      phase: (phase) => s.message(`${label} — ${phase}`),
      commandStart: (title) => {
        s.stop(`${label} — ${title}`);
        live = taskLog({ title: theme.accent(`${repo.name} › ${title}`), limit: 8 });
      },
      commandLine: (line) => live?.message(theme.dim(line)),
      commandEnd: (ok, title) => {
        if (ok) {
          live?.success(`${repo.name} › ${title} ${theme.ok(icons.ok)}`);
        } else {
          live?.error(`${repo.name} › ${title} ${theme.err(icons.err)}`);
        }
        live = undefined;
        s = spinner({ indicator: 'timer' });
        s.start(label);
      },
    };

    const result = await processRepo(repo, targetDir, withLog(uiReporter, logWrite), opts);
    logWrite(`[result] ${repo.name} ${result.status}: ${result.detail}`);
    recordResult(targetDir, result);
    results.push(result);
    if (result.status === 'error') {
      s.error(resultLine(result));
    } else {
      s.stop(resultLine(result));
    }
  }
  return results;
}

async function runDoctorCommand(cli: CliOptions): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const results = await runDoctor(catalogFor(targetDir), targetDir);
  const body = results
    .map((r) => {
      const badge =
        r.status === 'ok'
          ? `${icons.ok} ${theme.ok(S.labelOk)}`
          : r.status === 'fail'
            ? `${icons.err} ${theme.err(S.labelErr)}`
            : `${icons.warn} ${theme.warn('skip')}`;
      const prereqPart = r.prereqFails?.length
        ? ` ${theme.err(`· ${S.doctorPrereqsFail}: ${r.prereqFails.join(', ')}`)}`
        : '';
      return `${badge} ${kindIcon[r.repo.kind]} ${r.repo.name} — ${theme.dim(r.detail)}${prereqPart}`;
    })
    .join('\n');
  note(body, S.doctorTitle);
  process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
}

async function main(): Promise<void> {
  await printBanner();
  intro(theme.accent(S.intro));

  let cli;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    log.error(error instanceof CliError ? error.message : String(error));
    console.log(usage());
    process.exit(2);
  }
  if (cli.help) {
    console.log(usage());
    process.exit(0);
  }
  if (cli.positionals[0] === 'doctor') {
    await runDoctorCommand(cli);
    return;
  }

  await checkEnvironment();

  const interactive = !isNonInteractive(cli);
  const targetDir = interactive
    ? cli.dir
      ? resolveTargetDir(cli.dir)
      : await askWorkspace()
    : resolveTargetDir(cli.dir);
  const catalog = catalogFor(targetDir);

  let repos: ForgeRepo[];
  if (interactive) {
    repos = await askRepos(catalog);
    if (!cli.yes) await askConfirm(targetDir, repos.length, catalog.length);
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
    const selection = resolveSelection(cli, catalog);
    if ('error' in selection) {
      log.error(selection.error);
      process.exit(2);
    }
    repos = selection.repos;
    log.info(`${S.selectedRepos}: ${repos.map((r) => r.name).join(', ')}`);
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
    skipVerify: cli.skipVerify,
    timeoutMs: cli.timeoutSecs * 1000,
  };
  const runLog = openRunLog(targetDir);
  runLog.write(`# forge-cli ${new Date().toISOString()} dir=${targetDir}`);
  let results = await processBatch(repos, targetDir, opts, runLog.write, 0, repos.length);

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

  if (cli.jsonReport) {
    const file = writeJsonReport(targetDir, results, cli.reportPath);
    log.info(`${S.reportSaved}: ${theme.dim(file)}`);
  }
  log.info(`${S.logSaved}: ${theme.dim(runLog.file)}`);

  const hasErrors = results.some((r) => r.status === 'error');
  outro(`${icons.rocket} ${hasErrors ? S.outroWithErrors : S.outroOk}`);
}

process.on('SIGINT', () => {
  console.log('');
  cancel(S.interrupted);
  process.exit(130);
});

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
