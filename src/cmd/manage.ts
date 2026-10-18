import { confirm, isCancel, log, note } from '@clack/prompts';
import { clearPin, loadState, setPin } from '../artifacts.js';
import { type CliOptions } from '../cli-args.js';
import { install, planSelfInstall, planSelfUninstall, uninstall } from '../install.js';
import { registryEntry } from '../registry/catalog.js';
import { loadForgeState } from '../registry/install.js';
import { resolveInside } from '../safety.js';
import { S } from '../ui/strings.js';
import { icons, theme } from '../ui/theme.js';
import {
  cliHome,
  errorDetail,
  hasGitRepo,
  resolvePython,
  resolveTargetDir,
  runStreamed,
} from '../utils/system.js';
import { executeUninstall, planRollback, planUninstall, rollbackRepo } from '../lifecycle.js';
import { buildNativeOp } from '../native-install.js';
import { detectInstallMethod, planSelfUpdate } from '../self.js';
import { catalogFor, emitJson, reposByNames, pickOne, REFUSAL_TEXT } from './shared.js';

export type PinMethodRoute = 'git' | 'registry' | 'ambiguous' | 'defer';

/**
 * Método real da instalação para `pin`/`unpin` SEM `--method`: o receipt
 * registry e o clone git são a evidência — nunca o catálogo. Registry-only
 * → rota registry (pin git silencioso sobre instalação registry foi o bug
 * do E2E 11.2.1); git-only → git; ambos → 'ambiguous' (recusa nomeada
 * pede --method explícito); 0 ou >1 nomes → 'defer' (pickOne decide).
 */
export function pinMethodFor(
  names: string[],
  cli: Pick<CliOptions, 'dir'>,
  home = cliHome(),
): PinMethodRoute {
  if (names.length !== 1) return 'defer';
  const name = registryEntry(names[0])?.name ?? names[0];
  const registry = Object.hasOwn(loadForgeState(home).forges, name);
  const dir = resolveInside(resolveTargetDir(cli.dir), name);
  const cloned = dir !== null && hasGitRepo(dir);
  if (registry && cloned) return 'ambiguous';
  return registry ? 'registry' : 'git';
}

export async function runPinCommand(cli: CliOptions, names: string[]): Promise<void> {
  const repo = pickOne(cli, names);
  if (!repo || !cli.ref) {
    log.error(S.errPinNeedsVersion);
    process.exit(2);
  }
  const targetDir = resolveTargetDir(cli.dir);
  // --plan/--check: mostra o pin que seria gravado — ZERO mutação
  // (era o bug real: setPin rodava mesmo com --plan).
  if (cli.plan || cli.check) {
    const current = loadState(targetDir)?.pins?.[repo.name];
    const doc = { plan: true, forge: repo.name, pin: cli.ref, current: current ?? null };
    if (cli.jsonReport) emitJson(doc);
    note(
      `${repo.name} → ${cli.ref}${current ? ` (atual: ${current})` : ` (${S.unpinNone})`}`,
      S.uninstallPlanTitle,
    );
    log.info(S.planDryRunNote);
    process.exit(0);
    return;
  }
  setPin(targetDir, repo.name, cli.ref);
  log.success(`${icons.ok} ${repo.name}: ${S.pinDone} ${cli.ref}`);
  process.exit(0);
}

export async function runUnpinCommand(cli: CliOptions, names: string[]): Promise<void> {
  const repo = pickOne(cli, names);
  if (!repo) process.exit(2);
  // `--version` não existe no unpin — flag ignorada seria mentira.
  if (cli.ref !== undefined) {
    log.error(S.errUnpinNoRef);
    process.exit(2);
  }
  const targetDir = resolveTargetDir(cli.dir);
  if (cli.plan || cli.check) {
    const current = loadState(targetDir)?.pins?.[repo.name];
    const doc = { plan: true, forge: repo.name, unpin: true, current: current ?? null };
    if (cli.jsonReport) emitJson(doc);
    note(
      `${repo.name} → unpin${current ? ` (atual: ${current})` : ` (${S.unpinNone})`}`,
      S.uninstallPlanTitle,
    );
    log.info(S.planDryRunNote);
    process.exit(0);
    return;
  }
  const removed = clearPin(targetDir, repo.name);
  log.success(`${icons.ok} ${repo.name}: ${removed ? S.unpinDone : S.unpinNone}`);
  process.exit(0);
}

export async function runRollbackCommand(cli: CliOptions, names: string[]): Promise<void> {
  const repo = pickOne(cli, names);
  if (!repo) process.exit(2);
  // `rollback` volta ao HEAD anterior registrado — `--ref` não tem efeito.
  if (cli.ref !== undefined) {
    log.error(S.errRollbackNoRef);
    process.exit(2);
  }
  const targetDir = resolveTargetDir(cli.dir);
  const whyText = (reason: 'no-previous' | 'not-cloned' | 'dirty' | 'failed', detail?: string) =>
    reason === 'no-previous'
      ? S.rollbackNoPrevious
      : reason === 'not-cloned'
        ? S.rollbackNotCloned
        : reason === 'dirty'
          ? S.rollbackDirty
          : (detail ?? reason);
  // --plan/--check: mesmas validações read-only, sem `git checkout`.
  if (cli.plan || cli.check) {
    const plan = await planRollback(targetDir, repo);
    const doc = plan.ok
      ? {
          plan: true,
          forge: repo.name,
          rollback: { from: plan.from ?? null, to: plan.to },
        }
      : { plan: true, forge: repo.name, error: whyText(plan.reason) };
    if (cli.jsonReport) emitJson(doc);
    if (plan.ok) {
      note(
        `${repo.name}: ${plan.from ? plan.from.slice(0, 7) : '?'} → ${plan.to.slice(0, 7)}`,
        S.uninstallPlanTitle,
      );
      log.info(S.planDryRunNote);
      process.exit(0);
    }
    log.error(`${repo.name}: ${whyText(plan.reason)}`);
    process.exit(1);
    return;
  }
  const res = await rollbackRepo(targetDir, repo);
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
  // `uninstall` não tem alvo de revisão — `--ref` seria ignorado: recusa.
  if (cli.ref !== undefined) {
    log.error(S.errUninstallNoRef);
    process.exit(2);
  }
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
  // --plan/--check: o plano já foi exibido — sai antes de --yes/prompt
  // e sem tocar em dir, backups, state ou ledger.
  if (cli.plan || cli.check) {
    log.info(S.planDryRunNote);
    process.exit(refused ? 1 : 0);
    return;
  }
  if (!ready.length) {
    process.exit(refused ? 1 : 0);
    return;
  }
  if (!cli.yes) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      log.info(S.uninstallNeedsYes);
      process.exit(0);
      // `return` defensivo: exit real termina aqui, mas um exit interceptado
      // (testes, hooks) não pode continuar até confirm()/remoção.
      return;
    }
    const proceed = await confirm({ message: S.askConfirmUninstall, initialValue: false });
    if (isCancel(proceed) || !proceed) {
      log.info(S.uninstallNeedsYes);
      process.exit(0);
      return;
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
      const argv = [...op.argv];
      if (argv[0] === '{python}') {
        const py = await resolvePython();
        if (!py) {
          log.error(`${repo.name}: ${S.nativeNoPython}`);
          refusedNative = true;
          continue;
        }
        argv.splice(0, 1, ...py);
      }
      try {
        await runStreamed(argv, plan.dir, undefined, cli.timeoutSecs * 1000);
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
  // --plan/--check: o comando do update já foi exibido — nunca executa.
  if (cli.plan || cli.check) {
    log.info(S.planDryRunNote);
    process.exit(0);
    return;
  }
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

export async function runInstallCommand(cli: CliOptions): Promise<void> {
  // --plan/--check: lista os mesmos arquivos que install() tocaria —
  // dir, shim e profiles — sem criar/gravar nada.
  if (cli.plan || cli.check) {
    const plan = planSelfInstall();
    if (cli.jsonReport) emitJson({ plan: true, ...plan });
    note(
      [
        `dir: ${plan.dir}`,
        ...plan.shims.map((s) => `shim: ${s}`),
        ...plan.profilesTouched.map((p) => `profile: ${p}`),
      ].join('\n'),
      S.selfPlanTitle,
    );
    log.info(S.planDryRunNote);
    process.exit(0);
    return;
  }
  const report = await install();
  log.success(`${icons.ok} ${S.installDone} ${theme.dim(report.dir)}`);
  if (report.pathAlready) {
    log.info(S.installPathAlready);
  } else {
    log.info(S.installNewTerminal);
  }
  process.exit(0);
}

export async function runUninstallCommand(cli: CliOptions): Promise<void> {
  if (cli.plan || cli.check) {
    const plan = planSelfUninstall();
    if (cli.jsonReport) emitJson({ plan: true, ...plan });
    note(
      [
        `dir: ${plan.dir}${plan.dirPresent ? '' : ` (${S.uninstallAbsent})`}`,
        ...plan.profilesTouched.map((p) => `profile: ${p}`),
      ].join('\n'),
      S.selfPlanTitle,
    );
    log.info(S.planDryRunNote);
    process.exit(0);
    return;
  }
  const report = await uninstall();
  log.success(`${icons.ok} ${S.uninstallDone}`);
  if (report.profilesTouched.length) {
    log.info(`${S.uninstallProfiles}: ${report.profilesTouched.join(', ')}`);
  }
  process.exit(0);
}
