import path from 'node:path';
import { FORGE_REPOS } from '../constants/repos.js';
import { readForgeManifest } from '../manifest.js';
import type { WorkspaceInventory } from './contracts.js';

export const FEDERATED_MATRIX_SCHEMA = 'forge/FederatedCapabilityMatrix/v1' as const;

export interface FederatedCapabilityMatrix {
  schema: typeof FEDERATED_MATRIX_SCHEMA;
  generated_at: string;
  source: 'catalog+local-observation';
  contract_ids: string[];
  entries: {
    forge: string;
    source: string;
    package: string | null;
    kind: string;
    components: string[];
    requirements: string[];
    activation: string[];
    hosts: string[];
    platforms: string[];
    offline: 'supported' | 'unknown';
    gitless: 'supported' | 'unknown';
    local_state: string;
    evidence: string[];
  }[];
}

export function buildFederatedMatrix(
  root: string,
  inventory: WorkspaceInventory,
): FederatedCapabilityMatrix {
  const localByName = new Map(
    inventory.projects.map((project) => [project.identity.name ?? project.id, project]),
  );
  return {
    schema: FEDERATED_MATRIX_SCHEMA,
    generated_at: new Date().toISOString(),
    source: 'catalog+local-observation',
    contract_ids: [
      'forge/ForgeDescriptor/v1',
      'forge/ForgeCapability/v1',
      'forge/ForgeInstallContract/v1',
    ],
    entries: FORGE_REPOS.map((repo) => {
      const local = localByName.get(repo.name);
      const manifest = local ? readForgeManifest(path.join(root, local.path)) : null;
      return {
        forge: repo.name,
        source: repo.url,
        package: repo.packageName ?? null,
        kind: repo.kind,
        components: [...(repo.nativeInstall?.flags ?? [])].sort(),
        requirements: [
          repo.kind === 'python'
            ? 'Python runtime when native bootstrap is selected'
            : 'Node.js runtime when native bootstrap is selected',
        ],
        activation: [
          repo.nativeInstall ? 'native-install-contract' : 'repository-bootstrap',
          ...(manifest?.cli ? ['declared-cli'] : []),
        ],
        hosts: [
          ...(repo.nativeInstall?.flags.includes('host')
            ? ['claude', 'codex', 'copilot', 'devin']
            : []),
        ],
        platforms: ['linux', 'macos', 'windows'],
        offline: 'unknown',
        gitless: 'supported',
        local_state: local?.state ?? 'NOT_OBSERVED',
        evidence: [
          repo.packageName ? 'catalog.packageName' : 'catalog.name',
          ...(local ? ['workspace inventory'] : []),
        ],
      };
    }),
  };
}
