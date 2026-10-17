import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { log, note } from '@clack/prompts';
import { type CliOptions } from '../cli-args.js';
import { adapterFor, detectAll } from '../hosts/index.js';
import { registryEntry } from '../registry/catalog.js';
import { loadForgeState } from '../registry/install.js';
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
import { cliHome, commandOutput, resolveTargetDir } from '../utils/system.js';

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

/**
 * forge_id/mcp_command a partir do forge.json da Forja no workspace; sem
 * clone (método registry), o receipt + o template `mcp` do catálogo
 * resolvem o argv apontando para a venv — `hosts register` funciona
 * igual nos dois métodos.
 */
function forgeDescriptor(
  targetDir: string,
  name: string,
  home = cliHome(),
): { forge_id: string; mcp_command?: string[] } {
  const dir = resolveInside(targetDir, name);
  const manifest = dir ? readForgeManifest(dir) : null;
  if (manifest?.mcpCommand?.length) {
    return { forge_id: manifest.forgeId ?? name, mcp_command: manifest.mcpCommand };
  }
  const receipt = loadForgeState(home).forges[name];
  const entry = registryEntry(name);
  if (receipt?.bin && entry?.mcp?.length) {
    const binDir = path.dirname(receipt.bin);
    const mcp_command = entry.mcp.map((tok) => {
      if (tok === '{bin}') return receipt.bin;
      if (tok.startsWith('{binDir}/')) {
        const script = tok.slice('{binDir}/'.length);
        return path.join(binDir, process.platform === 'win32' ? `${script}.exe` : script);
      }
      return tok;
    });
    return { forge_id: name, mcp_command };
  }
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
  const forge = forgeDescriptor(targetDir, forgeName, home);

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

/**
 * `forge-cli mcp [forge…]` — resolve o argv MCP de cada Forja (forge.json do
 * clone, ou receipt registry + template `mcp` do catálogo) e reporta se o
 * argv[0] existe no disco. `--verify` executa `<argv[0]> --version` quando o
 * binário é absoluto dentro da venv (handshake mínimo honesto).
 */
export async function runMcpCommand(
  cli: CliOptions,
  args: string[],
  home = cliHome(),
): Promise<number> {
  const json = cli.jsonReport;
  const verify = cli.verify;
  const names = args.filter((a) => !a.startsWith('-'));
  const targetDir = resolveTargetDir(cli.dir);
  const candidates =
    names.length > 0
      ? names
      : [
          ...new Set([
            ...Object.keys(loadForgeState(home).forges),
            ...(existsSync(targetDir)
              ? readdirSync(targetDir, { withFileTypes: true })
                  .filter((d) => d.isDirectory() && isSafeRepoName(d.name))
                  .map((d) => d.name)
              : []),
          ]),
        ].sort();
  if (candidates.length === 0) {
    if (json) process.stdout.write(`${JSON.stringify({ mcp: [] })}\n`);
    else log.warn('nenhuma Forja instalada/encontrada para MCP');
    return 1;
  }
  const results = [];
  for (const name of candidates) {
    if (!isSafeRepoName(name)) {
      results.push({ forge: name, ok: false, detail: 'nome inseguro' });
      continue;
    }
    const forge = forgeDescriptor(targetDir, name, home);
    const argv = forge.mcp_command;
    if (!argv?.length) {
      results.push({ forge: name, ok: false, detail: 'sem mcp_command' });
      continue;
    }
    const binPresent = path.isAbsolute(argv[0]) ? existsSync(argv[0]) : true; // relativo → resolvido pelo host via PATH
    const item: Record<string, unknown> = {
      forge: name,
      forge_id: forge.forge_id,
      mcp_command: argv,
      binPresent,
      ok: binPresent,
    };
    if (!binPresent) item.detail = 'binário MCP ausente na venv';
    if (verify && binPresent && path.isAbsolute(argv[0])) {
      const out = await commandOutput(argv[0], ['--version']);
      item.handshake = { ok: out !== null, out: (out ?? '').trim().slice(0, 80) };
      if (out === null) item.ok = false;
    }
    results.push(item);
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ mcp: results }, null, 2)}\n`);
  } else {
    for (const r of results) {
      const rec = r as { forge: string; ok: boolean; mcp_command?: string[]; detail?: string };
      if (rec.ok) log.info(`${icons.ok} ${rec.forge}: ${rec.mcp_command?.join(' ')}`);
      else log.warn(`${rec.forge}: ${rec.detail ?? 'indisponível'}`);
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return okCount === results.length ? 0 : okCount > 0 ? 0 : 1;
}
