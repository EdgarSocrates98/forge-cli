import { log, note } from '@clack/prompts';
import { type CliOptions } from '../cli-args.js';
import { adapterFor, detectAll } from '../hosts/index.js';
import {
  hostHome,
  latestBackupDir,
  type HostDetection,
  type HostPlan,
  type HostState,
} from '../hosts/types.js';
import { readForgeManifest } from '../manifest.js';
import { isSafeRepoName, resolveInside } from '../safety.js';
import { S } from '../ui/strings.js';
import { icons, theme } from '../ui/theme.js';
import { resolveTargetDir } from '../utils/system.js';

// ---------------------------------------------------------------------------
// `forge-cli hosts <verbo>` — §2.5. Retorna exit code (0 ok / 1 falha / 2 uso)
// em vez de sair — testável e composável pelo dispatcher.
// Verbos: list (default), plan, register, validate, rollback.
// plan nunca escreve; register exige --yes; backup antes de qualquer escrita.
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<HostState, string> = {
  absent: S.hostAbsent,
  installed: S.hostInstalled,
  configured: S.hostConfigured,
  authenticated: S.hostAuthenticated,
  integrated: S.hostIntegrated,
  validated: S.hostValidated,
};

const AUTH_LABEL: Record<HostDetection['auth'], string> = {
  verified: S.hostAuthenticated,
  absent: S.hostAbsent,
  unknown: S.hostAuthUnknown,
};

function hostLine(d: HostDetection): string {
  if (!d.found) return `${d.host} — ${theme.dim(S.hostAbsent)}`;
  const ver = d.version ?? S.hostVersionUnknown;
  return `${d.host} — ${STATE_LABEL[d.state]} ${theme.dim(`· ${ver} · ${AUTH_LABEL[d.auth]}`)}`;
}

function planLines(plan: HostPlan): string {
  const lines = plan.actions.map(
    (a) =>
      `- ${a.kind}${a.target ? ` ${a.target}` : ''}${a.argv?.length ? ` ${theme.dim(a.argv.join(' '))}` : ''} — ${a.reason}`,
  );
  if (plan.copyable_command) lines.push(`${S.hostCopyCommand} ${plan.copyable_command}`);
  return lines.join('\n');
}

/** forge_id/mcp_command a partir do forge.json da Forja no workspace (se houver). */
function forgeDescriptor(
  targetDir: string,
  name: string,
): { forge_id: string; mcp_command?: string[] } {
  const dir = resolveInside(targetDir, name);
  const manifest = dir ? readForgeManifest(dir) : null;
  return { forge_id: manifest?.forgeId ?? name, mcp_command: manifest?.mcpCommand };
}

export async function runHostsCommand(
  cli: CliOptions,
  args: string[],
  home?: string,
): Promise<number> {
  const [verbRaw, hostId, forgeName] = args;
  const verb = verbRaw ?? 'list';
  const json = cli.jsonReport;
  const emit = (data: unknown) => console.log(JSON.stringify(data, null, 2));

  if (verb === 'list') {
    const detections = await detectAll(hostHome(home));
    if (json) {
      emit({ hosts: detections });
      return 0;
    }
    note(detections.map(hostLine).join('\n'), S.hostsTitle);
    return 0;
  }

  const adapter = hostId ? adapterFor(hostId) : undefined;
  if (!adapter || !forgeName || !isSafeRepoName(forgeName)) {
    log.error(`${S.errUnknownCommand}: ${args.join(' ')}`);
    return 2;
  }
  const targetDir = resolveTargetDir(cli.dir);
  const forge = forgeDescriptor(targetDir, forgeName);

  if (verb === 'plan' || verb === 'register') {
    const plan = await adapter.planIntegration(forge, targetDir, hostHome(home));
    if (!plan) {
      if (json) {
        emit({ host: adapter.id, forge_id: forge.forge_id, plan: null, detail: S.hostUnsupported });
      } else {
        log.warn(`${adapter.displayName}: ${S.hostUnsupported}`);
      }
      return 1;
    }
    if (verb === 'plan' || !cli.yes) {
      if (json) {
        emit(verb === 'plan' ? plan : { plan, applied: false, detail: S.hostNeedsYes });
        return 0;
      }
      note(planLines(plan), S.hostPlanTitle);
      log.info(S.hostNeedsYes);
      return 0;
    }
    const result = await adapter.applyIntegration(plan, { home: hostHome(home) });
    if (json) {
      emit(result);
      return result.ok ? 0 : 1;
    }
    for (const target of result.applied) {
      log.success(`${icons.ok} ${S.hostRegistered}: ${theme.dim(target)}`);
    }
    for (const skipped of result.skipped) log.info(theme.dim(skipped));
    if (result.backup) log.info(`${S.envBackupAt}: ${theme.dim(result.backup)}`);
    if (!result.ok) {
      log.error(result.detail ?? S.hostUnsupported);
      return 1;
    }
    return 0;
  }

  if (verb === 'validate') {
    const validation = await adapter.validateIntegration(forge.forge_id, hostHome(home));
    if (json) {
      emit(validation);
      return validation.ok ? 0 : 1;
    }
    note(
      validation.checks
        .map((c) => `${c.id}: ${c.result}${c.detail ? theme.dim(` (${c.detail})`) : ''}`)
        .join('\n'),
      `${S.hostValidated} — ${adapter.displayName}`,
    );
    return validation.ok ? 0 : 1;
  }

  if (verb === 'rollback') {
    const backup = latestBackupDir(hostHome(home), adapter.id);
    if (!backup) {
      if (json) emit({ host: adapter.id, restored: false, detail: 'no-backup' });
      else log.error(`${adapter.displayName}: no-backup`);
      return 1;
    }
    const stub: HostPlan = {
      host: adapter.id,
      forge_id: forge.forge_id,
      actions: [],
      reversible: true,
    };
    await adapter.rollback(stub, backup, hostHome(home));
    if (json) {
      emit({ host: adapter.id, restored: true, backup });
      return 0;
    }
    log.success(`${icons.ok} ${adapter.displayName}: ${S.hostRollbackDone}`);
    log.info(`${S.envBackupAt}: ${theme.dim(backup)}`);
    return 0;
  }

  log.error(`${S.errUnknownCommand}: ${args.join(' ')}`);
  return 2;
}
