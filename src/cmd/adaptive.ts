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
import { resolveTargetDir } from '../utils/system.js';

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
    return `${marker} ${project.id.padEnd(24)} ${project.state.padEnd(10)} ${project.kind.padEnd(8)} ${project.identity.level}`;
  });
  return [
    `root  ${inventory.root}`,
    `git   ${inventory.git.present ? `${inventory.git.branch ?? 'detached'} ${inventory.git.head ?? ''}` : 'gitless'}`,
    '',
    'PROJECT                  STATE      KIND     IDENTITY',
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
    `WORKSPACE-COMMAND-UNKNOWN: ${verb} (use scan|list|use|activate|status|doctor|federation)`,
  );
  return 2;
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
