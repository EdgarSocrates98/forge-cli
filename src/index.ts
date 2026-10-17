#!/usr/bin/env node
import { cancel, intro, log, note, outro } from '@clack/prompts';
import { loadState } from './artifacts.js';
import { CliError, isNonInteractive, parseCliArgs, usage, type CliOptions } from './cli-args.js';
import { resolveCommand } from './commands.js';
import { collectStatus } from './status.js';
import { askRepos, askWorkspace } from './prompts.js';
import { S } from './ui/strings.js';
import { theme } from './ui/theme.js';
import { cliHome, hasGitRepo, resolveTargetDir } from './utils/system.js';
import { componentsLines } from './native-install.js';
import { applyMenu, askMenu, menuItemsFor, shouldShowMenu } from './menu.js';
import { resolveInside } from './safety.js';
import { printBanner, emitJson, catalogFor, reposByNames } from './cmd/shared.js';
import { setTaskLogLimit } from './cmd/batch.js';
import {
  runListCommand,
  runStatusCommand,
  runUpdateCheckCommand,
  runVersionsCommand,
} from './cmd/query.js';
import { runDoctor2Command, runHealCommand } from './cmd/doctor2.js';
import {
  runRegistryInstall,
  runRegistryList,
  runRegistryPin,
  runRegistryReinstall,
  runRegistryRollback,
  runRegistryUninstall,
  runRegistryUpdate,
} from './cmd/registry.js';
import { registryEntry, registryNames, REGISTRY_PACKAGES } from './registry/catalog.js';
import { loadForgeState } from './registry/install.js';
import { isCancel, multiselect } from '@clack/prompts';
import { exitCancelled } from './prompts.js';
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
import { runHostsCommand, runMcpCommand } from './cmd/hosts.js';
import {
  runDiscoverCommand,
  runLockCommand,
  runProfileCommand,
  runRecommendCommand,
  runRecoverCommand,
} from './cmd/intel.js';
import {
  runAiCommand,
  runAskCommand,
  runBundleCommand,
  runContextCommand,
  runLearningCommand,
  runPredictCommand,
} from './cmd/intel2.js';
import { runWizard } from './wizard.js';

const JSON_QUERY_COMMANDS = new Set([
  'status',
  'list',
  'versions',
  'components',
  'update',
  'doctor',
  'heal',
  'discover',
  'recommend',
  'env',
  'hosts',
  'mcp',
  'lock',
  'profile',
  'recover',
  'ask',
  'predict',
  'context',
  'install',
  'uninstall',
  'registry',
  'ai',
  'bundle',
  'learning',
]);

async function main(): Promise<void> {
  let cli: CliOptions;
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
      ask: () => askMenu({}, menuItemsFor(cli)),
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
      pickRegistryCatalog: async () => {
        const picked = await multiselect({
          message: 'Forjas para instalar do PyPI (registry-first)',
          options: REGISTRY_PACKAGES.map((e) => ({
            value: e.name,
            label: e.name,
            hint: `${e.dist} · python >=${e.minPython}`,
          })),
          required: true,
        });
        if (isCancel(picked)) exitCancelled();
        return picked as string[];
      },
      pickRegistryInstalled: async () => {
        const installed = Object.keys(loadForgeState(cliHome()).forges);
        if (!installed.length) {
          log.warn('Nenhuma Forja instalada via registry ainda — instale primeiro.');
          return [];
        }
        const picked = await multiselect({
          message: 'Forjas instaladas (registry)',
          options: installed.map((n) => ({ value: n, label: n })),
          required: true,
        });
        if (isCancel(picked)) exitCancelled();
        return picked as string[];
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
  const REGISTRY_COMMANDS = new Set([
    'install',
    'uninstall',
    'update',
    'reinstall',
    'rollback',
    'pin',
    'unpin',
  ]);
  if (cli.method === 'registry' && !REGISTRY_COMMANDS.has(resolved.command)) {
    log.error(S.errMethodUnsupported);
    process.exit(2);
  }
  // Lifecycle registry intercepta antes dos handlers git — update/reinstall/
  // rollback/pin/unpin com --method registry operam sobre receipts, não clones.
  if (cli.method === 'registry' && resolved.command === 'update') {
    await runRegistryUpdate(cli, resolved.names);
    return;
  }
  if (cli.method === 'registry' && resolved.command === 'reinstall') {
    await runRegistryReinstall(cli, resolved.names);
    return;
  }
  if (cli.method === 'registry' && resolved.command === 'rollback') {
    await runRegistryRollback(cli, resolved.names);
    return;
  }
  if (cli.method === 'registry' && resolved.command === 'pin') {
    await runRegistryPin(cli, resolved.names, true);
    return;
  }
  if (cli.method === 'registry' && resolved.command === 'unpin') {
    await runRegistryPin(cli, resolved.names, false);
    return;
  }
  // `--method` só significa algo nos fluxos de instalação/lifecycle —
  // em comandos de consulta/hosts/self é avisado, nunca engolido.
  const METHOD_COMMANDS = new Set([
    'run',
    'install',
    'clone',
    'uninstall',
    'update',
    'reinstall',
    'pin',
    'unpin',
    'rollback',
    'wizard',
  ]);
  if (cli.method === 'git' && !METHOD_COMMANDS.has(resolved.command)) {
    log.warn(`--method git não tem efeito em "${resolved.command}" — ignorado`);
  }
  if (resolved.command === 'doctor') {
    process.exitCode = await runDoctor2Command(cli);
    return;
  }
  if (resolved.command === 'heal') {
    process.exitCode = await runHealCommand(cli);
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
  if (resolved.command === 'mcp') {
    process.exitCode = await runMcpCommand(cli, resolved.names);
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
  if (resolved.command === 'ask') {
    process.exitCode = await runAskCommand(cli);
    return;
  }
  if (resolved.command === 'predict') {
    process.exitCode = await runPredictCommand(cli);
    return;
  }
  if (resolved.command === 'context') {
    process.exitCode = await runContextCommand(cli);
    return;
  }
  if (resolved.command === 'ai') {
    process.exitCode = await runAiCommand(cli);
    return;
  }
  if (resolved.command === 'bundle') {
    process.exitCode = await runBundleCommand(cli);
    return;
  }
  if (resolved.command === 'registry') {
    runRegistryList(cli, { names: resolved.names });
    return;
  }
  if (resolved.command === 'learning') {
    process.exitCode = await runLearningCommand(cli);
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
  if (resolved.command === 'uninstall' && cli.method === 'registry') {
    await runRegistryUninstall(cli, resolved.names);
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
  if (resolved.command === 'install' && cli.method === 'registry') {
    const names = resolved.names.length
      ? resolved.names
      : cli.all
        ? registryNames()
        : (cli.only ?? []);
    if (!names.length) {
      log.error(S.errRegistryNeedsNames);
      process.exit(2);
    }
    // `--ref` exige UMA Forja — após normalização de alias:
    // `install api-forge apiforge-af --ref` é uma só Forja, não duas.
    if (cli.ref && new Set(names.map((n) => registryEntry(n)?.name ?? n)).size !== 1) {
      log.error(S.errRefNeedsOne);
      process.exit(2);
    }
    await runRegistryInstall(cli, names);
    return;
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
