#!/usr/bin/env node
import { cancel, intro, log, note, outro } from '@clack/prompts';
import { loadState } from './artifacts.js';
import { CliError, isNonInteractive, parseCliArgs, usage } from './cli-args.js';
import { resolveCommand } from './commands.js';
import { collectStatus } from './status.js';
import { askRepos, askWorkspace } from './prompts.js';
import { S } from './ui/strings.js';
import { theme } from './ui/theme.js';
import { hasGitRepo, resolveTargetDir } from './utils/system.js';
import { componentsLines } from './native-install.js';
import { applyMenu, askMenu, shouldShowMenu } from './menu.js';
import { resolveInside } from './safety.js';
import { printBanner, emitJson, catalogFor, reposByNames } from './cmd/shared.js';
import { setTaskLogLimit } from './cmd/batch.js';
import {
  runDoctorCommand,
  runListCommand,
  runStatusCommand,
  runUpdateCheckCommand,
  runVersionsCommand,
} from './cmd/query.js';
import {
  runPinCommand,
  runUnpinCommand,
  runRollbackCommand,
  runForgeUninstall,
  runSelfUpdateCommand,
  runInstallCommand,
  runUninstallCommand,
} from './cmd/manage.js';
import { runInstallFlow } from './cmd/run.js';
import { runEnvCommand } from './cmd/env.js';
import { runHostsCommand } from './cmd/hosts.js';
import {
  runDiscoverCommand,
  runLockCommand,
  runProfileCommand,
  runRecommendCommand,
  runRecoverCommand,
} from './cmd/intel.js';
import { runWizard } from './wizard.js';

const JSON_QUERY_COMMANDS = new Set([
  'status',
  'list',
  'versions',
  'components',
  'update',
  'doctor',
  'discover',
  'recommend',
  'env',
  'hosts',
  'lock',
  'profile',
  'recover',
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
    const next = await applyMenu(cli, {
      ask: () => askMenu(),
      workspace: askWorkspace,
      resolveDir: resolveTargetDir,
      pickRepos: async (dir) => {
        const cat = catalogFor(dir);
        const infos = await collectStatus(cat, dir, loadState(dir));
        const chosen = await askRepos(cat, {
          initialAll: false,
          status: new Map(infos.map((i) => [i.name, i])),
        });
        return chosen.map((r) => r.name);
      },
    });
    if (!next) {
      outro(S.menuExit);
      process.exit(0);
    }
    cli = next;
  }
  if (cli.verbose) setTaskLogLimit(200);
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
  if (resolved.command === 'discover') {
    process.exitCode = await runDiscoverCommand(cli);
    return;
  }
  if (resolved.command === 'recommend') {
    process.exitCode = await runRecommendCommand(cli);
    return;
  }
  if (resolved.command === 'env') {
    process.exitCode = await runEnvCommand(cli, resolved.names);
    return;
  }
  if (resolved.command === 'hosts') {
    process.exitCode = await runHostsCommand(cli, resolved.names);
    return;
  }
  if (resolved.command === 'wizard') {
    if (isNonInteractive(cli)) {
      log.error(S.errCloneNeedsNames);
      process.exit(2);
    }
    await runWizard(cli);
    return;
  }
  if (resolved.command === 'lock') {
    process.exitCode = await runLockCommand(cli, resolved.names);
    return;
  }
  if (resolved.command === 'profile') {
    process.exitCode = await runProfileCommand(cli, resolved.names);
    return;
  }
  if (resolved.command === 'recover') {
    process.exitCode = await runRecoverCommand(cli);
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

  await runInstallFlow(cli, resolved, cloneOnly);
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
