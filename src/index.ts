#!/usr/bin/env node
import { cancel, intro, log, note, outro } from '@clack/prompts';
import { loadState } from './artifacts.js';
import {
  CliError,
  isNonInteractive,
  parseCliArgs,
  usage,
  usageFor,
  type CliOptions,
} from './cli-args.js';
import { resolveCommand } from './commands.js';
import { collectStatus } from './status.js';
import { askRepos, askWorkspace } from './prompts.js';
import { S } from './ui/strings.js';
import { setColorEnabled, theme } from './ui/theme.js';
import { CLI_NAME, CLI_VERSION } from './version.js';
import { cliHome, hasGitRepo, resolveTargetDir } from './utils/system.js';
import { componentsLines } from './native-install.js';
import { ADVANCED_MENU_ITEMS, applyMenu, askMenu, menuItemsFor, shouldShowMenu } from './menu.js';
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
  runRegistryLock,
  runRegistryPin,
  runRegistryReinstall,
  runRegistryRollback,
  runRegistryUninstall,
  runRegistryUpdate,
} from './cmd/registry.js';
import { registryEntry, registryNames, REGISTRY_PACKAGES } from './registry/catalog.js';
import { loadForgeState } from './registry/install.js';
import { looksLikePathArg } from './source/detect.js';
import {
  runLocalInstallCommand,
  runLocalLifecycleCommand,
  runLocalUpdateCommand,
} from './cmd/local.js';
import { isCancel, multiselect } from '@clack/prompts';
import { exitCancelled } from './prompts.js';
import {
  pinMethodFor,
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
  // --no-color/NO_COLOR valem para todo ANSI (banner, theme, clack).
  if (cli.noColor || 'NO_COLOR' in process.env) setColorEnabled(false);
  // `forge-cli --version` sozinho: versão do CLI; `--version <x>` segue pin.
  if (cli.versionFlag) {
    process.stdout.write(`${CLI_NAME} ${CLI_VERSION}\n`);
    process.exit(0);
  }
  const quiet = cli.jsonReport && JSON_QUERY_COMMANDS.has(cli.positionals[0] ?? '');
  if (!quiet) {
    await printBanner();
    intro(theme.accent(S.intro));
  }
  if (cli.help) {
    console.log(usageFor(cli.positionals));
    process.exit(0);
  }
  if (shouldShowMenu(cli, Boolean(process.stdin.isTTY && process.stdout.isTTY))) {
    const next = await applyMenu(cli, {
      ask: () => askMenu({}, menuItemsFor(cli)),
      askAdvanced: () => askMenu({}, ADVANCED_MENU_ITEMS, S.menuAdvanced),
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
  let resolved = resolveCommand(cli);
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
  // ---------------------------------------------------------------------
  // Fonte local (ciclo 12.1): `install|update <dir>` passa pelo detector
  // forge/LocalForgeSourceDetection/v1 — NUNCA pelo catálogo registry e
  // nunca por clone git. Diretório existente OU cara de caminho decide a
  // rota; misturar dir com nome de catálogo é recusa explícita.
  // ---------------------------------------------------------------------
  if (resolved.command === 'install' || resolved.command === 'update') {
    const pathlike = resolved.names.filter((n) => looksLikePathArg(n));
    if (pathlike.length && pathlike.length !== resolved.names.length) {
      log.error(
        `FORGE-SOURCE-INVALID: mistura de diretório e nome de Forja — passe o diretório-fonte sozinho: ${pathlike.join(', ')}`,
      );
      process.exit(2);
    }
    if (pathlike.length) {
      if (cli.method === 'registry') {
        log.error(
          `FORGE-SOURCE-INVALID: --method registry espera nomes do catálogo, não diretórios — remova --method ou use nomes`,
        );
        process.exit(2);
      }
      if (resolved.command === 'install') {
        await runLocalInstallCommand(cli, resolved.names);
      } else {
        await runLocalUpdateCommand(cli, resolved.names);
      }
      return;
    }
  }
  // Lifecycle by-name de fonte local: receipts method:'local' seguem a
  // rota local quando --method não é dito (mesmo contrato do pinMethodFor
  // — a instalação real decide o método, não a suposição do usuário).
  if (cli.method === undefined) {
    const forges = loadForgeState(cliHome()).forges;
    const local = resolved.names.filter(
      (n) => Object.hasOwn(forges, n) && forges[n].method === 'local',
    );
    if (local.length) {
      if (resolved.command === 'update') {
        // `update <nome>` de fonte sem git: a semântica git (pull/remote)
        // não existe — a recusa nomeada aponta a rota correta.
        for (const n of local) {
          const r = forges[n];
          log.error(
            `FORGE-SOURCE-GITLESS: ${n}: fonte sem git — \`update\` exige o diretório-fonte mais novo`,
          );
          log.info(
            `→ forge-cli update ${r.method === 'local' ? r.source_dir : n} (ou um diretório-fonte mais novo)`,
          );
        }
        const rest = resolved.names.filter((n) => !local.includes(n));
        if (!rest.length) process.exit(2);
        resolved = { ...resolved, names: rest };
      } else if (resolved.command === 'uninstall' || resolved.command === 'reinstall') {
        await runLocalLifecycleCommand(
          cli,
          resolved.command === 'uninstall' ? 'uninstall' : 'repair',
          local,
        );
        const rest = resolved.names.filter((n) => !local.includes(n));
        if (!rest.length) return;
        resolved = { ...resolved, names: rest };
      }
    }
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
    // O wizard é só interativo — flags de segurança não são engolidas.
    if (cli.plan || cli.check) {
      log.error(S.errPlanUnsupported);
      process.exit(2);
    }
    if (isNonInteractive(cli) || cli.yes) {
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
    // `forge registry <verbo>`: lock gera o fecho offline; install é
    // atalho de `install --method registry`; o resto lista catálogo/estado.
    const [sub, ...subNames] = resolved.names;
    if (sub === 'lock') {
      await runRegistryLock(cli, subNames);
      return;
    }
    if (sub === 'install') {
      if (!subNames.length) {
        log.error(S.errRegistryNeedsNames);
        process.exit(2);
      }
      await runRegistryInstall(cli, subNames);
      return;
    }
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
    console.log(usageFor(cli.positionals));
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
    await runInstallCommand(cli);
    return;
  }
  if (resolved.command === 'self-update') {
    await runSelfUpdateCommand(cli);
    return;
  }
  if (resolved.command === 'self-uninstall') {
    await runUninstallCommand(cli);
    return;
  }
  if (resolved.command === 'uninstall' && cli.method === 'registry') {
    await runRegistryUninstall(cli, resolved.names);
    return;
  }
  if (resolved.command === 'uninstall' && !resolved.names.length && !isNonInteractive(cli)) {
    log.warn(S.warnLegacyUninstall);
    await runUninstallCommand(cli);
    return;
  }
  if (resolved.command === 'uninstall') {
    await runForgeUninstall(cli, resolved.names);
    return;
  }
  if (resolved.command === 'pin') {
    // Sem --method, o pin segue a instalação REAL: Forja só no registry
    // nunca recebe estado git implícito (bug E2E 11.2.1); nos dois
    // métodos, --method resolve a ambiguidade.
    const route = cli.method === undefined ? pinMethodFor(resolved.names, cli) : 'defer';
    if (route === 'ambiguous') {
      log.error(`${resolved.names[0]}: ${S.errPinMethodAmbiguous}`);
      process.exit(2);
    }
    if (route === 'registry') {
      log.info(`${resolved.names[0]}: ${S.pinRegistryAuto}`);
      await runRegistryPin(cli, resolved.names, true);
      return;
    }
    await runPinCommand(cli, resolved.names);
    return;
  }
  if (resolved.command === 'unpin') {
    const route = cli.method === undefined ? pinMethodFor(resolved.names, cli) : 'defer';
    if (route === 'ambiguous') {
      log.error(`${resolved.names[0]}: ${S.errPinMethodAmbiguous}`);
      process.exit(2);
    }
    if (route === 'registry') {
      log.info(`${resolved.names[0]}: ${S.unpinRegistryAuto}`);
      await runRegistryPin(cli, resolved.names, false);
      return;
    }
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
  // §7.3: `install` é registry-first (PyPI+venv). Checkout git só entra por
  // opt-in explícito (`--method git` ou o comando `clone`); `install` sem
  // nomes em TTY cai no wizard, que já abre no método registry.
  const installWantsRegistry =
    resolved.command === 'install' &&
    cli.method !== 'git' &&
    (cli.method === 'registry' ||
      resolved.names.length > 0 ||
      cli.all === true ||
      (cli.only?.length ?? 0) > 0 ||
      isNonInteractive(cli));
  if (installWantsRegistry) {
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

  if (cli.python !== undefined) {
    // --python é honrado pelos fluxos registry e fonte local; o fluxo
    // git/clone não sonda interpretador — flag ignorada nunca é muda.
    log.warn('--python não se aplica ao fluxo git/clone — ignorado');
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
