import { log, note } from '@clack/prompts';
import type { CliOptions } from '../cli-args.js';
import { resolveCapabilities } from '../adaptive/capabilities.js';
import {
  buildWorkspacePlan,
  receiptForPlan,
  saveWorkspaceActivation,
  saveWorkspaceSelection,
} from '../adaptive/operations.js';
import {
  createPortablePack,
  importPortablePack,
  inspectPortablePack,
  verifyPortablePack,
} from '../adaptive/pack.js';
import { scanWorkspace } from '../adaptive/workspace.js';
import { buildFederatedMatrix } from '../adaptive/federation.js';
import type { WorkspaceInventory } from '../adaptive/contracts.js';
import { buildNativeInstall } from '../native-install.js';
import { catalogFor, reposByNames } from './shared.js';
import type { ForgeRepo } from '../types.js';
import { icons, theme } from '../ui/theme.js';
import { errorDetail, resolvePython, resolveTargetDir, runStreamed } from '../utils/system.js';

function workspaceRoot(cli: CliOptions): string {
  return cli.dir ? resolveTargetDir(cli.dir) : process.cwd();
}
function emit(cli: CliOptions, value: unknown, text: string, title: string): void {
  if (cli.jsonReport) console.log(JSON.stringify(value, null, 2));
  else note(text, title);
}
function inventoryText(inventory: WorkspaceInventory): string {
  const rows = inventory.projects.map((project) => {
    const marker =
      project.state === 'VERIFIED' || project.state === 'INSTALLED'
        ? '●'
        : project.state === 'DEGRADED'
          ? '!'
          : '○';
    const ctx = project.context ? `${project.context.state}/${project.context.health ?? '—'}` : '—';
    return `${marker} ${project.id.padEnd(24)} ${project.state.padEnd(10)} ${project.kind.padEnd(8)} ${project.identity.level.padEnd(10)} ${ctx}`;
  });
  return [
    `root  ${inventory.root}`,
    `git   ${inventory.git.present ? `${inventory.git.branch ?? 'detached'} ${inventory.git.head ?? ''}` : 'gitless'}`,
    '',
    'PROJECT                  STATE      KIND     IDENTITY   CONTEXT(state/health)',
    ...rows,
    '',
    `capabilities: ${inventory.capabilities.join(', ') || '—'}`,
    ...(inventory.warnings.length ? [`warnings: ${inventory.warnings.join('; ')}`] : []),
  ].join('\n');
}

export async function runWorkspaceCommand(cli: CliOptions, args: string[]): Promise<number> {
  const root = workspaceRoot(cli);
  const verb = args[0] ?? 'status';
  const inventory = await scanWorkspace(root);
  if (verb === 'federation') {
    const matrix = buildFederatedMatrix(root, inventory);
    emit(
      cli,
      matrix,
      `${matrix.entries.length} Forjas no catálogo\ncontratos: ${matrix.contract_ids.join(', ')}`,
      'Federated capability matrix',
    );
    return 0;
  }
  if (verb === 'scan' || verb === 'list' || verb === 'status') {
    const value =
      verb === 'status'
        ? {
            inventory,
            environment: await resolveCapabilities({
              workspace: root,
              offline: cli.offline,
              profile: cli.profile as never,
            }),
          }
        : inventory;
    emit(
      cli,
      value,
      inventoryText(inventory),
      verb === 'scan'
        ? 'Workspace scan'
        : verb === 'list'
          ? 'Workspace projects'
          : 'Workspace status',
    );
    return 0;
  }
  if (verb === 'doctor') {
    const environment = await resolveCapabilities({
      workspace: root,
      offline: cli.offline,
      profile: cli.profile as never,
    });
    const conflicts = inventory.projects.filter((project) => project.identity.level === 'conflict');
    const blocked = Object.entries(environment.operations).filter(
      ([, operation]) => operation.state === 'BLOCKED',
    );
    const result = {
      inventory,
      environment,
      checks: {
        identity_conflicts: conflicts.length,
        blocked_operations: blocked.map(([name]) => name),
      },
      status: conflicts.length || blocked.length ? 'degraded' : 'ready',
    };
    emit(
      cli,
      result,
      `${inventoryText(inventory)}\n\noperations blocked: ${blocked.map(([name]) => name).join(', ') || 'none'}`,
      'Workspace doctor',
    );
    return conflicts.length ? 1 : 0;
  }
  if (verb === 'install') {
    return runWorkspaceInstall(cli, args.slice(1), root, inventory);
  }
  if (verb === 'use') {
    const target = args[1];
    const project = inventory.projects.find((item) => item.id === target || item.path === target);
    if (!project) {
      log.error(`WORKSPACE-PROJECT-NOT-FOUND: ${target ?? '(missing)'}`);
      return 2;
    }
    const plan = buildWorkspacePlan(inventory, 'use', project.id);
    if (cli.plan || !cli.yes) {
      emit(
        cli,
        { plan, receipt: receiptForPlan(plan, 'planned') },
        plan.actions.map((action) => `· ${action.description}`).join('\n') +
          '\n\nNada foi escrito — use --yes para selecionar.',
        'Workspace plan',
      );
      return 0;
    }
    const file = saveWorkspaceSelection(root, project);
    emit(
      cli,
      { plan, receipt: receiptForPlan(plan, 'applied'), file },
      `Workspace selecionado: ${project.path}\nreceipt: ${file}`,
      'Workspace activated',
    );
    return 0;
  }
  if (verb === 'activate') {
    const target = args[1];
    const project = inventory.projects.find((item) => item.id === target || item.path === target);
    if (!project) {
      log.error(`WORKSPACE-PROJECT-NOT-FOUND: ${target ?? '(missing)'}`);
      return 2;
    }
    const plan = buildWorkspacePlan(inventory, 'activate', project.id);
    if (cli.plan || !cli.yes) {
      emit(
        cli,
        { plan, receipt: receiptForPlan(plan, 'planned') },
        plan.actions.map((action) => `· ${action.description}`).join('\n') +
          '\n\nNenhum script foi executado — use --yes para registrar a ativação.',
        'Workspace activation plan',
      );
      return 0;
    }
    const file = saveWorkspaceActivation(project);
    emit(
      cli,
      { plan, receipt: receiptForPlan(plan, 'applied'), file, scripts_executed: false },
      `Workspace ativado sem executar scripts: ${project.path}\nreceipt: ${file}`,
      'Workspace activated',
    );
    return 0;
  }
  log.error(
    `WORKSPACE-COMMAND-UNKNOWN: ${verb} (use scan|list|use|activate|install|status|doctor|federation)`,
  );
  return 2;
}

/**
 * `workspace install <forja>` — fase 'install' do contrato
 * forge/WorkspaceOperationPlan/v1 (GAP-07). Dirige o MESMO fluxo do
 * instalador nativo da Forja (installkit) forçando `scope=workspace`:
 * os host-assets caem na raiz do workspace, não no projeto nem no user.
 * Sem `--yes` (ou com `--plan`/`--dry-run`) só o plano é emitido — o
 * executor de terceiros nunca roda sem aprovação explícita.
 */
async function runWorkspaceInstall(
  cli: CliOptions,
  targets: string[],
  root: string,
  inventory: WorkspaceInventory,
): Promise<number> {
  if (!targets.length) {
    log.error(
      'WORKSPACE-INSTALL-NEEDS-FORGE: informe a Forja — workspace install <forja> [...|all]',
    );
    return 2;
  }
  // Multi-forge workspace install (Onda 07): `all` expands to every catalog
  // forge whose native installer is documented; named targets stay ordered.
  let names = targets;
  const catalog = catalogFor(root);
  if (targets.includes('all')) {
    if (targets.length > 1) {
      log.error('WORKSPACE-INSTALL-ALL-MIXED: `all` não combina com alvos nomeados');
      return 2;
    }
    names = catalog.map((repo) => repo.name);
  }
  const picked = reposByNames(catalog, names);
  if ('error' in picked) {
    log.error(`WORKSPACE-FORGE-UNKNOWN: ${picked.error}`);
    return 2;
  }
  let worst = 0;
  const summary: { forge: string; code: number }[] = [];
  for (const repo of picked) {
    const code = await workspaceInstallOne(cli, repo, root, inventory);
    summary.push({ forge: repo.name, code });
    if (code > worst) worst = code;
  }
  if (picked.length > 1) {
    emit(
      cli,
      { results: summary, ok: summary.filter((s) => s.code === 0).map((s) => s.forge) },
      summary.map((s) => `${s.code === 0 ? icons.ok : icons.err} ${s.forge}`).join('\n'),
      'Workspace install — resumo',
    );
  }
  return worst;
}

async function workspaceInstallOne(
  cli: CliOptions,
  repo: ForgeRepo,
  root: string,
  inventory: WorkspaceInventory,
): Promise<number> {
  if (cli.scope && cli.scope !== 'workspace') {
    log.error(
      `WORKSPACE-SCOPE-CONFLICT: workspace install fixa scope=workspace (recebido --scope ${cli.scope})`,
    );
    return 2;
  }
  const built = buildNativeInstall(repo, {
    scope: 'workspace',
    profile: cli.profile,
    components: cli.components,
    host: cli.host,
    gatewayProfile: cli.gatewayProfile,
    approve: cli.yes,
  });
  if (!built) {
    log.error(
      `WORKSPACE-INSTALL-UNSUPPORTED: ${repo.name} — sem instalador nativo documentado no catálogo`,
    );
    return 2;
  }
  const argv = [...built.argv];
  if (argv[0] === '{python}') {
    const py = await resolvePython();
    if (!py) {
      log.error(`WORKSPACE-INSTALL-NO-PYTHON: interpretador não resolvido para ${repo.name}`);
      return 1;
    }
    argv.splice(0, 1, ...py);
  }
  const plan = buildWorkspacePlan(inventory, 'install', repo.name, {
    command: argv.join(' '),
  });
  for (const flag of built.ignored) {
    plan.restrictions = [...plan.restrictions, `flag não suportada pela Forja: --${flag}`];
  }
  if (cli.plan || !cli.yes) {
    emit(
      cli,
      { plan, receipt: receiptForPlan(plan, 'planned'), argv, ignored: built.ignored },
      `${plan.actions.map((action) => `· ${action.description}`).join('\n')}` +
        `\ncwd: ${root}` +
        (built.ignored.length
          ? `\nflags ignoradas: ${built.ignored.map((f) => `--${f}`).join(', ')}`
          : '') +
        '\n\nNada foi executado — use --yes para instalar em scope=workspace' +
        ' (sem ele o instalador nativo recebe --dry-run, como no argv acima).',
      'Workspace install plan',
    );
    return 0;
  }
  try {
    // cwd = raiz do workspace: o installkit resolve scope=workspace a
    // partir daí (state root `.forge/` ascendente mais próximo).
    await runStreamed(argv, root, (line) => log.info(theme.dim(line)), cli.timeoutSecs * 1000);
  } catch (error) {
    const detail = errorDetail(error);
    emit(
      cli,
      { plan, receipt: receiptForPlan(plan, 'failed'), argv, error: detail },
      `Falha no instalador nativo de ${repo.name}: ${detail}`,
      'Workspace install',
    );
    return 1;
  }
  emit(
    cli,
    { plan, receipt: receiptForPlan(plan, 'applied'), argv, ignored: built.ignored },
    `Host-assets de ${repo.name} instalados no workspace (scope=workspace).\nexecutado: ${argv.join(' ')}`,
    'Workspace install',
  );
  return 0;
}

export async function runPackCommand(cli: CliOptions, args: string[]): Promise<number> {
  const verb = args[0] ?? 'inspect';
  const archive = args[1];
  try {
    if (verb === 'create') {
      const result = createPortablePack(
        workspaceRoot(cli),
        archive ?? `forge-cli-${new Date().toISOString().slice(0, 10)}.zip`,
      );
      emit(
        cli,
        result,
        `Portable pack criado: ${result.archive}\n${result.bytes} bytes`,
        'Portable distribution',
      );
      return 0;
    }
    if (!archive) {
      log.error('FORGE-PACK-PATH-REQUIRED: informe o arquivo .zip');
      return 2;
    }
    if (verb === 'inspect') {
      const result = inspectPortablePack(archive);
      emit(
        cli,
        result,
        `${result.manifest.package}@${result.manifest.version}\n${result.files.join('\n')}`,
        'Portable pack',
      );
      return 0;
    }
    if (verb === 'verify') {
      const result = verifyPortablePack(archive);
      emit(
        cli,
        result,
        result.ok
          ? 'Integridade verificada — pack íntegro.'
          : `Pack inválido: ${result.errors.join(', ')}`,
        'Portable pack verification',
      );
      return result.ok ? 0 : 1;
    }
    if (verb === 'import') {
      if (cli.plan || !cli.yes) {
        log.info(
          `Plano: verificar e extrair ${archive} em ${workspaceRoot(cli)}; use --yes para aplicar.`,
        );
        return 0;
      }
      const result = importPortablePack(archive, workspaceRoot(cli));
      emit(
        cli,
        result,
        `Pack importado em ${result.destination}\n${result.files.join('\n')}`,
        'Portable pack import',
      );
      return 0;
    }
    log.error(`FORGE-PACK-COMMAND-UNKNOWN: ${verb} (use create|inspect|verify|import)`);
    return 2;
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
