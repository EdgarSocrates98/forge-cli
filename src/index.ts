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
import standardFont from 'figlet/importable-fonts/Standard.js';
import {
  clearPin,
  failedRepoNames,
  setPin,
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
import { loadConfig } from './config.js';
import { reposNeedingFix, runDoctor } from './doctor.js';
import { install, pathStatus, uninstall } from './install.js';
import { resolveCommand } from './commands.js';
import { executionSummary, planLines, summaryLines } from './plan.js';
import { collectStatus } from './status.js';
import { runPreflight } from './preflight.js';
import { askConfirm, askRepos, askTrustCustom, askWorkspace } from './prompts.js';
import { listLine, mergeResults, renderReport, resultLine } from './report.js';
import { processPool, processRepo, type RepoReporter, type RunOptions } from './runner.js';
import type { ForgeRepo, RepoResult } from './types.js';
import { S } from './ui/strings.js';
import { icons, kindIcon, theme } from './ui/theme.js';
import {
  currentHead,
  errorDetail,
  hasGitRepo,
  resolveTargetDir,
  runStreamed,
} from './utils/system.js';
import { localTags, remoteTags, updateCheck } from './git-revs.js';
import { executeUninstall, planUninstall, rollbackRepo } from './lifecycle.js';
import { buildNativeOp, componentsLines } from './native-install.js';
import { detectInstallMethod, planSelfUpdate } from './self.js';
import { actionNeedsRepos, actionToPositionals, askMenu, shouldShowMenu } from './menu.js';
import { resolveInside } from './safety.js';

const BANNER_LINE_DELAY_MS = 30;

async function printBanner(): Promise<void> {
  figlet.parseFont('Standard', standardFont);
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

function emitJson(data: unknown, exitCode = 0): never {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  process.exit(exitCode);
}

function catalogFor(targetDir: string): ForgeRepo[] {
  const custom = loadCustomRepos(targetDir);
  if (custom && 'repos' in custom) {
    if (custom.rejected.length) {
      log.warn(`${S.customReposRejected}: ${custom.rejected.join(', ')}`);
    }
    const hasNew = custom.repos.some((r) => !FORGE_REPOS.some((c) => c.name === r.name));
    if (hasNew) log.info(`${S.customReposLoaded} ${theme.dim(`(${custom.repos.length})`)}`);
    return mergeCatalog(FORGE_REPOS, custom.repos);
  }
  if (custom && 'error' in custom) log.warn(S.customReposInvalid);
  return [...FORGE_REPOS];
}

let TASKLOG_LIMIT = 8;

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
        live = taskLog({ title: theme.accent(`${repo.name} › ${title}`), limit: TASKLOG_LIMIT });
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

async function runDoctorCommand(cli: CliOptions, names: string[] = []): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const picked = reposByNames(catalogFor(targetDir), names);
  if ('error' in picked) {
    log.error(picked.error);
    process.exit(2);
  }
  const results = await runDoctor(picked, targetDir);
  if ((await pathStatus()) === 'missing') log.warn(S.doctorPathMissing);
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
  if (cli.jsonReport) {
    emitJson(
      results.map((r) => ({
        name: r.repo.name,
        status: r.status,
        detail: r.detail,
        prereqFails: r.prereqFails ?? [],
      })),
      results.some((r) => r.status === 'fail') ? 1 : 0,
    );
  }
  note(body, S.doctorTitle);

  if (!cli.fix) {
    process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
    return;
  }

  const fixing = reposNeedingFix(results);
  const skipped = results.filter((r) => r.status === 'skipped');
  if (!fixing.length && !skipped.length) {
    log.success(S.doctorAllOk);
    process.exit(0);
    return;
  }
  if (skipped.length) {
    log.warn(`${S.doctorNeedsInstall}: ${skipped.map((r) => r.repo.name).join(', ')}`);
  }
  let fixResults: RepoResult[] = [];
  if (fixing.length) {
    log.step(`${S.doctorFixing} ${fixing.map((r) => r.name).join(', ')}`);
    const runLog = openRunLog(targetDir);
    fixResults = await processBatch(fixing, targetDir, {}, runLog.write);
    log.info(`${S.logSaved} ${theme.dim(runLog.file)}`);
    renderReport(fixResults);
  }
  const healed = fixing.length === fixResults.filter((r) => r.status === 'ok').length;
  process.exit(healed && !skipped.length ? 0 : 1);
}

async function runListCommand(cli: CliOptions): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const state = loadState(targetDir);
  const body = catalogFor(targetDir)
    .map((repo) => listLine(repo, state?.repos[repo.name]))
    .join('\n');
  if (cli.jsonReport) {
    emitJson(
      catalogFor(targetDir).map((repo) => ({
        name: repo.name,
        url: repo.url,
        description: repo.description,
        last: state?.repos[repo.name] ?? null,
      })),
    );
  }
  note(body, S.listTitle);
  process.exit(0);
}

async function runStatusCommand(cli: CliOptions, names: string[]): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const catalog = catalogFor(targetDir);
  const wanted = names.length ? catalog.filter((r) => names.includes(r.name)) : catalog;
  const infos = await collectStatus(wanted, targetDir, loadState(targetDir));
  const label: Record<string, string> = {
    'not-installed': S.statusNotInstalled,
    cloned: S.statusCloned,
    prepared: S.statusPrepared,
    installed: S.statusInstalled,
    validated: S.statusValidated,
    partial: S.statusPartial,
    failed: S.statusFailed,
    drifted: S.statusDrifted,
  };
  const body = infos
    .map((i) => {
      const ver = i.describe ?? i.head;
      const extra = [ver, i.dirty ? S.warnDirtyTree : undefined].filter(Boolean).join(' · ');
      return `${i.name} — ${label[i.phase]}${extra ? theme.dim(` (${extra})`) : ''}`;
    })
    .join('\n');
  if (cli.jsonReport) emitJson(infos);
  note(body, S.statusTitle);
  process.exit(0);
}

function reposByNames(catalog: ForgeRepo[], names: string[]): ForgeRepo[] | { error: string } {
  if (!names.length) return catalog;
  const missing = names.filter((n) => !catalog.some((r) => r.name === n));
  if (missing.length) return { error: `${S.errUnknownRepos}: ${missing.join(', ')}` };
  return catalog.filter((r) => names.includes(r.name));
}

async function runUpdateCheckCommand(cli: CliOptions, names: string[]): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const picked = reposByNames(catalogFor(targetDir), names);
  if ('error' in picked) {
    log.error(picked.error);
    process.exit(2);
  }
  const lines: string[] = [];
  const rows: { name: string; state: string; behind: number; ahead: number; failure?: string }[] =
    [];
  let pending = 0;
  for (const repo of picked) {
    const dir = resolveInside(targetDir, repo.name);
    if (!dir || !hasGitRepo(dir)) {
      lines.push(`${repo.name} — ${S.statusNotInstalled}`);
      rows.push({ name: repo.name, state: 'not-installed', behind: 0, ahead: 0 });
      continue;
    }
    const check = await updateCheck(dir);
    if (check.failure) {
      lines.push(`${repo.name} — ${theme.warn(`${S.updateCheckFailed} (${check.failure})`)}`);
      rows.push({ name: repo.name, state: 'unknown', behind: 0, ahead: 0, failure: check.failure });
    } else if (check.behind > 0) {
      pending++;
      lines.push(`${repo.name} — ${theme.accent(`${check.behind} ${S.updateCommitsBehind}`)}`);
      rows.push({ name: repo.name, state: 'behind', behind: check.behind, ahead: check.ahead });
    } else {
      lines.push(`${repo.name} — ${theme.ok(S.updateUpToDate)}`);
      rows.push({ name: repo.name, state: 'up-to-date', behind: 0, ahead: check.ahead });
    }
  }
  if (cli.jsonReport) emitJson(rows, pending > 0 ? 1 : 0);
  note(lines.join('\n'), S.updateCheckTitle);
  process.exit(pending > 0 ? 1 : 0);
}

async function runVersionsCommand(cli: CliOptions, names: string[]): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const picked = reposByNames(catalogFor(targetDir), names);
  if ('error' in picked) {
    log.error(picked.error);
    process.exit(2);
  }
  const lines: string[] = [];
  const rows: { name: string; source: string; revision?: string; tags: string[] | null }[] = [];
  for (const repo of picked) {
    const dir = resolveInside(targetDir, repo.name);
    if (dir && hasGitRepo(dir)) {
      const head = (await currentHead(dir))?.slice(0, 7) ?? '?';
      const tags = await localTags(dir);
      rows.push({ name: repo.name, source: 'local', revision: head, tags });
      lines.push(
        `${theme.accent(repo.name)} — ${S.versionsRevision} ${head} · ${S.versionsTags}: ${tags.length ? tags.join(', ') : S.planNone}`,
      );
    } else {
      const tags = await remoteTags(repo.url);
      rows.push({ name: repo.name, source: tags === null ? 'unavailable' : 'remote', tags });
      lines.push(
        `${theme.accent(repo.name)} — ${S.statusNotInstalled} · ${S.versionsTags}: ${tags === null ? S.versionsUnavailable : tags.length ? tags.join(', ') : S.planNone}`,
      );
    }
  }
  if (cli.jsonReport) emitJson(rows);
  note(lines.join('\n'), S.versionsTitle);
  process.exit(0);
}

function pickOne(cli: CliOptions, names: string[]): ForgeRepo | null {
  if (names.length !== 1) {
    log.error(S.errNeedsOneName);
    process.exit(2);
  }
  const picked = reposByNames(catalogFor(resolveTargetDir(cli.dir)), names);
  if ('error' in picked) {
    log.error(picked.error);
    process.exit(2);
  }
  return picked[0] ?? null;
}

async function runPinCommand(cli: CliOptions, names: string[]): Promise<void> {
  const repo = pickOne(cli, names);
  if (!repo || !cli.ref) {
    log.error(S.errPinNeedsVersion);
    process.exit(2);
  }
  setPin(resolveTargetDir(cli.dir), repo.name, cli.ref);
  log.success(`${icons.ok} ${repo.name}: ${S.pinDone} ${cli.ref}`);
  process.exit(0);
}

async function runUnpinCommand(cli: CliOptions, names: string[]): Promise<void> {
  const repo = pickOne(cli, names);
  if (!repo) process.exit(2);
  const removed = clearPin(resolveTargetDir(cli.dir), repo.name);
  log.success(`${icons.ok} ${repo.name}: ${removed ? S.unpinDone : S.unpinNone}`);
  process.exit(0);
}

async function runRollbackCommand(cli: CliOptions, names: string[]): Promise<void> {
  const repo = pickOne(cli, names);
  if (!repo) process.exit(2);
  const res = await rollbackRepo(resolveTargetDir(cli.dir), repo);
  if (res.ok) {
    log.success(`${icons.ok} ${repo.name}: ${S.rollbackDone} ${res.to.slice(0, 7)}`);
    log.info(S.rollbackNote);
    process.exit(0);
  }
  const why =
    res.reason === 'no-previous'
      ? S.rollbackNoPrevious
      : res.reason === 'not-cloned'
        ? S.rollbackNotCloned
        : res.reason === 'dirty'
          ? S.rollbackDirty
          : (res.detail ?? res.reason);
  log.error(`${repo.name}: ${why}`);
  process.exit(1);
}

const REFUSAL_TEXT = {
  'invalid-name': S.uninstallReasonInvalid,
  symlink: S.uninstallReasonSymlink,
  'non-git': S.uninstallReasonNonGit,
  'remote-mismatch': S.uninstallReasonRemote,
  dirty: S.uninstallReasonDirty,
} as const;

async function runForgeUninstall(cli: CliOptions, names: string[]): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const catalog = catalogFor(targetDir);
  const wanted = [...names, ...(cli.only ?? [])];
  const picked = cli.all ? catalog : reposByNames(catalog, wanted);
  if ('error' in picked) {
    log.error(picked.error);
    process.exit(2);
  }
  const plans = [];
  const lines: string[] = [];
  for (const repo of picked) {
    const plan = await planUninstall(targetDir, repo);
    plans.push({ repo, plan });
    if (plan.kind === 'absent') {
      lines.push(`${repo.name} — ${theme.dim(S.uninstallAbsent)}`);
    } else if (plan.kind === 'refused') {
      lines.push(
        `${repo.name} — ${theme.err(`${S.uninstallRefused}: ${REFUSAL_TEXT[plan.reason]}`)}`,
      );
    } else {
      const bk = plan.backups.length ? ` · ${S.uninstallBackups}: ${plan.backups.join(', ')}` : '';
      lines.push(`${repo.name} — ${theme.warn(S.uninstallReady)}${theme.dim(bk)}`);
      if (cli.native) {
        const op = buildNativeOp(repo, 'uninstall', true);
        lines.push(
          `  ${theme.dim(`${S.nativeUninstallPlan}: ${op ? op.argv.join(' ') : S.nativeUnsupported}`)}`,
        );
      }
    }
  }
  note(lines.join('\n'), S.uninstallPlanTitle);
  const ready = plans.filter((p) => p.plan.kind === 'ready');
  const refused = plans.some((p) => p.plan.kind === 'refused');
  if (!ready.length) process.exit(refused ? 1 : 0);
  if (!cli.yes) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      log.info(S.uninstallNeedsYes);
      process.exit(0);
    }
    const proceed = await confirm({ message: S.askConfirmUninstall, initialValue: false });
    if (isCancel(proceed) || !proceed) {
      log.info(S.uninstallNeedsYes);
      process.exit(0);
    }
  }
  let refusedNative = false;
  for (const { repo, plan } of ready) {
    if (plan.kind !== 'ready') continue;
    if (cli.native) {
      const op = buildNativeOp(repo, 'uninstall', true);
      if (!op) {
        log.error(`${repo.name}: ${S.nativeUnsupported}`);
        refusedNative = true;
        continue;
      }
      try {
        await runStreamed(op.argv, plan.dir, undefined, cli.timeoutSecs * 1000);
      } catch (error) {
        log.error(`${repo.name}: ${S.nativeUninstallFailed}: ${errorDetail(error)}`);
        refusedNative = true;
        continue;
      }
    }
    const backup = executeUninstall(targetDir, repo, plan);
    log.success(`${icons.ok} ${repo.name}: ${S.uninstallRemoved}`);
    if (backup) log.info(`${S.uninstallBackupAt}: ${theme.dim(backup)}`);
  }
  process.exit(refused || refusedNative ? 1 : 0);
}

async function runSelfUpdateCommand(cli: CliOptions): Promise<void> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const method = detectInstallMethod(process.argv[1] ?? '', home);
  const plan = planSelfUpdate(method);
  const lines = [`${S.selfUpdateMethod}: ${method}`];
  if (plan.command)
    lines.push(`${S.selfUpdateRun}: ${plan.command.bin} ${plan.command.args.join(' ')}`);
  if (plan.manual) lines.push(plan.manual);
  note(lines.join('\n'), S.selfUpdateTitle);
  if (!plan.command) process.exit(0);
  if (!cli.yes) {
    log.info(S.selfUpdateNeedsYes);
    process.exit(0);
  }
  try {
    await runStreamed([plan.command.bin, ...plan.command.args], process.cwd(), (l) =>
      log.message(theme.dim(l)),
    );
    log.success(`${icons.ok} ${S.selfUpdateDone}`);
    process.exit(0);
  } catch (error) {
    log.error(`${S.selfUpdateFailed}: ${errorDetail(error)}`);
    process.exit(1);
  }
}

async function reviewExecution(
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

async function runInstallCommand(): Promise<void> {
  const report = await install();
  log.success(`${icons.ok} ${S.installDone} ${theme.dim(report.dir)}`);
  if (report.pathAlready) {
    log.info(S.installPathAlready);
  } else {
    log.info(S.installNewTerminal);
  }
  process.exit(0);
}

async function runUninstallCommand(): Promise<void> {
  const report = await uninstall();
  log.success(`${icons.ok} ${S.uninstallDone}`);
  if (report.profilesTouched.length) {
    log.info(`${S.uninstallProfiles}: ${report.profilesTouched.join(', ')}`);
  }
  process.exit(0);
}

const JSON_QUERY_COMMANDS = new Set([
  'status',
  'list',
  'versions',
  'components',
  'update',
  'doctor',
]);

async function main(): Promise<void> {
  let cli;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    await printBanner();
    intro(theme.accent(S.intro));
    log.error(error instanceof CliError ? error.message : String(error));
    console.log(usage());
    process.exit(2);
  }
  const quiet = cli.jsonReport && JSON_QUERY_COMMANDS.has(cli.positionals[0] ?? '');
  if (!quiet) {
    await printBanner();
    intro(theme.accent(S.intro));
  }
  if (cli.help) {
    console.log(usage());
    process.exit(0);
  }
  if (shouldShowMenu(cli, Boolean(process.stdin.isTTY && process.stdout.isTTY))) {
    const action = await askMenu();
    if (action === 'exit') {
      outro(S.menuExit);
      process.exit(0);
    }
    if (action !== 'install') {
      const dir = cli.dir ? resolveTargetDir(cli.dir) : await askWorkspace();
      let names: string[] = [];
      if (actionNeedsRepos(action)) {
        const cat = catalogFor(dir);
        const infos = await collectStatus(cat, dir, loadState(dir));
        const chosen = await askRepos(cat, {
          initialAll: false,
          status: new Map(infos.map((i) => [i.name, i])),
        });
        names = chosen.map((r) => r.name);
      }
      cli = {
        ...cli,
        dir,
        positionals: actionToPositionals(action, names),
        fix: action === 'repair',
      };
    }
  }
  if (cli.verbose) TASKLOG_LIMIT = 200;
  const resolved = resolveCommand(cli);
  if (resolved.command === 'unknown') {
    log.error(`${S.errUnknownCommand}: ${resolved.unknown}`);
    console.log(usage());
    process.exit(2);
  }
  if (resolved.command === 'doctor') {
    await runDoctorCommand(cli, resolved.names);
    return;
  }
  if (resolved.command === 'list') {
    await runListCommand(cli);
    return;
  }
  if (resolved.command === 'status') {
    await runStatusCommand(cli, resolved.names);
    return;
  }
  if (resolved.command === 'help') {
    console.log(usage());
    process.exit(0);
  }
  if (resolved.command === 'components') {
    const picked = reposByNames(catalogFor(resolveTargetDir(cli.dir)), resolved.names);
    if ('error' in picked) {
      log.error(picked.error);
      process.exit(2);
    }
    if (cli.jsonReport) {
      emitJson(picked.map((r) => ({ name: r.name, nativeInstall: r.nativeInstall ?? null })));
    }
    note(componentsLines(picked).join('\n'), S.componentsTitle);
    process.exit(0);
  }
  if (
    cli.offline &&
    (resolved.command === 'versions' || (resolved.command === 'update' && cli.check))
  ) {
    log.error(S.errOfflineNoNetwork);
    process.exit(2);
  }
  if (resolved.command === 'versions') {
    await runVersionsCommand(cli, resolved.names);
    return;
  }
  if (resolved.command === 'update' && cli.check) {
    await runUpdateCheckCommand(cli, resolved.names);
    return;
  }
  if (resolved.command === 'update' && !resolved.names.length && !isNonInteractive(cli)) {
    const dir = resolveTargetDir(cli.dir);
    const present = catalogFor(dir)
      .filter((r) => {
        const d = resolveInside(dir, r.name);
        return d !== null && hasGitRepo(d);
      })
      .map((r) => r.name);
    if (!present.length) {
      log.info(S.updateNothing);
      process.exit(0);
    }
    cli = { ...cli, only: present };
  }
  if (resolved.command === 'self-install') {
    await runInstallCommand();
    return;
  }
  if (resolved.command === 'self-update') {
    await runSelfUpdateCommand(cli);
    return;
  }
  if (resolved.command === 'self-uninstall') {
    await runUninstallCommand();
    return;
  }
  if (resolved.command === 'uninstall' && !resolved.names.length && !isNonInteractive(cli)) {
    log.warn(S.warnLegacyUninstall);
    await runUninstallCommand();
    return;
  }
  if (resolved.command === 'uninstall') {
    await runForgeUninstall(cli, resolved.names);
    return;
  }
  if (resolved.command === 'pin') {
    await runPinCommand(cli, resolved.names);
    return;
  }
  if (resolved.command === 'unpin') {
    await runUnpinCommand(cli, resolved.names);
    return;
  }
  if (resolved.command === 'rollback') {
    await runRollbackCommand(cli, resolved.names);
    return;
  }
  if (resolved.command === 'reinstall' && !resolved.names.length && !isNonInteractive(cli)) {
    log.error(S.errReinstallNeedsNames);
    process.exit(2);
  }
  if (resolved.names.length) cli = { ...cli, only: [...(cli.only ?? []), ...resolved.names] };
  const cloneOnly = resolved.command === 'clone';
  if (cloneOnly && !isNonInteractive(cli)) {
    log.error(S.errCloneNeedsNames);
    process.exit(2);
  }

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

process.on('SIGINT', () => {
  console.log('');
  cancel(S.interrupted);
  process.exit(130);
});

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
