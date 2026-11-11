import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  WorkspaceOperationPlan,
  WorkspaceOperationReceipt,
  WorkspaceProject,
} from './contracts.js';
import { inventoryDigest } from './workspace.js';
import type { WorkspaceInventory } from './contracts.js';
import { writeFileAtomic } from '../safety.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function buildWorkspacePlan(
  inventory: WorkspaceInventory,
  operation: WorkspaceOperationPlan['operation'],
  target: string,
): WorkspaceOperationPlan {
  const project = inventory.projects.find((item) => item.id === target || item.path === target);
  const actions = project
    ? [
        {
          id: `inspect-${project.id}`,
          kind: 'inspect',
          description: `confirmar ${project.path || project.id} sem executar comandos não confiáveis`,
          mutates: false,
        },
      ]
    : [
        {
          id: 'select-workspace',
          kind: 'select',
          description: `selecionar workspace ${inventory.root}`,
          mutates: true,
        },
      ];
  return {
    schema: 'forge/WorkspaceOperationPlan/v1',
    operation,
    target,
    created_at: new Date().toISOString(),
    reversible: true,
    actions,
    preconditions: [
      'workspace existe',
      'path não é symlink/junction',
      'nenhum comando dinâmico de manifesto será executado',
    ],
    restrictions: inventory.warnings,
  };
}

export function receiptForPlan(
  plan: WorkspaceOperationPlan,
  status: WorkspaceOperationReceipt['status'],
): WorkspaceOperationReceipt {
  return {
    schema: 'forge/WorkspaceOperationReceipt/v1',
    operation: plan.operation,
    target: plan.target,
    plan_sha256: sha256(JSON.stringify(plan)),
    status,
    created_at: plan.created_at,
    completed_at: status === 'planned' ? null : new Date().toISOString(),
    actions: plan.actions.map((action) => ({
      id: action.id,
      status: status === 'applied' ? 'applied' : status === 'blocked' ? 'blocked' : 'skipped',
      detail: action.description,
    })),
  };
}

export function saveWorkspaceSelection(root: string, project: WorkspaceProject): string {
  const dir = path.join(root, '.forge-cli');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'workspace.json');
  const payload = {
    schema: 'forge/WorkspaceSelection/v1',
    root,
    project: project.path,
    digest: inventoryDigest({
      schema: 'forge/WorkspaceInventory/v1',
      generated_at: '',
      root,
      git: { present: false, branch: null, head: null },
      limits: { max_depth: 0, max_entries: 0, max_projects: 0 },
      projects: [project],
      capabilities: [],
      warnings: [],
      truncated: false,
    }),
  };
  writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

export function saveWorkspaceActivation(project: WorkspaceProject): string {
  const dir = path.join(project.absolute_path, '.forge-cli');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'activated.json');
  writeFileAtomic(
    file,
    `${JSON.stringify(
      {
        schema: 'forge/WorkspaceActivation/v1',
        project: project.id,
        activated_at: new Date().toISOString(),
        mode: 'static',
        scripts_executed: false,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

export function readWorkspaceSelection(root: string): { project: string } | null {
  const file = path.join(root, '.forge-cli', 'workspace.json');
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { project?: unknown };
    return typeof value.project === 'string' ? { project: value.project } : null;
  } catch {
    return null;
  }
}
