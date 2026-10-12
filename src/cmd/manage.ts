import { confirm, isCancel, log, note } from '@clack/prompts';
import { clearPin, setPin } from '../artifacts.js';
import { type CliOptions } from '../cli-args.js';
import { install, uninstall } from '../install.js';
import { S } from '../ui/strings.js';
import { icons, theme } from '../ui/theme.js';
import { errorDetail, resolveTargetDir, runStreamed } from '../utils/system.js';
import { executeUninstall, planUninstall, rollbackRepo } from '../lifecycle.js';
import { buildNativeOp } from '../native-install.js';
import { detectInstallMethod, planSelfUpdate } from '../self.js';
import { catalogFor, reposByNames, pickOne, REFUSAL_TEXT } from './shared.js';

export async function runPinCommand(cli: CliOptions, names: string[]): Promise<void> {
  const repo = pickOne(cli, names);
  if (!repo || !cli.ref) {
    log.error(S.errPinNeedsVersion);
    process.exit(2);
  }
  setPin(resolveTargetDir(cli.dir), repo.name, cli.ref);
  log.success(`${icons.ok} ${repo.name}: ${S.pinDone} ${cli.ref}`);
  process.exit(0);
}

export async function runUnpinCommand(cli: CliOptions, names: string[]): Promise<void> {
  const repo = pickOne(cli, names);
  if (!repo) process.exit(2);
  const removed = clearPin(resolveTargetDir(cli.dir), repo.name);
  log.success(`${icons.ok} ${repo.name}: ${removed ? S.unpinDone : S.unpinNone}`);
  process.exit(0);
}

export async function runRollbackCommand(cli: CliOptions, names: string[]): Promise<void> {
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

export async function runForgeUninstall(cli: CliOptions, names: string[]): Promise<void> {
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

export async function runSelfUpdateCommand(cli: CliOptions): Promise<void> {
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

export async function runInstallCommand(): Promise<void> {
  const report = await install();
  log.success(`${icons.ok} ${S.installDone} ${theme.dim(report.dir)}`);
  if (report.pathAlready) {
    log.info(S.installPathAlready);
  } else {
    log.info(S.installNewTerminal);
  }
  process.exit(0);
}

export async function runUninstallCommand(): Promise<void> {
  const report = await uninstall();
  log.success(`${icons.ok} ${S.uninstallDone}`);
  if (report.profilesTouched.length) {
    log.info(`${S.uninstallProfiles}: ${report.profilesTouched.join(', ')}`);
  }
  process.exit(0);
}
