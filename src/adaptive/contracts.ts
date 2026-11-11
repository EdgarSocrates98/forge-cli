/** Contracts introduced by the adaptive platform layer.
 *
 * These are deliberately small, JSON-first contracts. They describe what was
 * observed and what can be done; they never grant permission to execute a
 * third-party command.
 */

export const WORKSPACE_INVENTORY_SCHEMA = 'forge/WorkspaceInventory/v1' as const;
export const ENVIRONMENT_CAPABILITIES_SCHEMA = 'forge/EnvironmentCapabilities/v1' as const;
export const PORTABLE_DISTRIBUTION_PACK_SCHEMA = 'forge/PortableDistributionPack/v1' as const;

export type IdentityLevel = 'declared' | 'derived' | 'candidate' | 'unknown' | 'conflict';
export type ExperienceState =
  | 'DISCOVERED'
  | 'RECOGNIZED'
  | 'READY'
  | 'ACTIVATED'
  | 'INSTALLED'
  | 'VERIFIED'
  | 'DEGRADED'
  | 'BLOCKED'
  | 'DRIFTED';

export type WorkspaceProjectKind =
  'python' | 'node' | 'mixed' | 'config' | 'docs' | 'skills' | 'agents' | 'portal' | 'unknown';

export interface WorkspaceProject {
  id: string;
  path: string;
  absolute_path: string;
  identity: {
    name: string | null;
    level: IdentityLevel;
    declared: string | null;
    derived: string | null;
    candidate: string | null;
    conflict: string | null;
  };
  kind: WorkspaceProjectKind;
  capabilities: string[];
  markers: string[];
  git: { present: boolean; branch: string | null; dirty: boolean | null };
  version: string | null;
  state: ExperienceState;
  evidence: string[];
}

export interface WorkspaceInventory {
  schema: typeof WORKSPACE_INVENTORY_SCHEMA;
  generated_at: string;
  root: string;
  git: { present: boolean; branch: string | null; head: string | null };
  limits: { max_depth: number; max_entries: number; max_projects: number };
  projects: WorkspaceProject[];
  capabilities: string[];
  warnings: string[];
  truncated: boolean;
}

export type CapabilityState = 'AVAILABLE' | 'UNAVAILABLE' | 'BLOCKED' | 'INCOMPATIBLE' | 'UNKNOWN';

export interface EnvironmentCapability {
  name: string;
  state: CapabilityState;
  version: string | null;
  executable: string | null;
  reason: string | null;
}

export interface EnvironmentCapabilities {
  schema: typeof ENVIRONMENT_CAPABILITIES_SCHEMA;
  generated_at: string;
  platform: string;
  arch: string;
  profile: 'auto' | 'personal' | 'corporate' | 'portable' | 'offline-strict' | 'ci';
  shell: { selected: string | null; candidates: string[] };
  capabilities: EnvironmentCapability[];
  operations: Record<string, { state: CapabilityState; route: string | null; reasons: string[] }>;
  restrictions: string[];
}

export interface WorkspaceOperationPlan {
  schema: 'forge/WorkspaceOperationPlan/v1';
  operation: 'use' | 'activate' | 'install' | 'verify';
  target: string;
  created_at: string;
  reversible: boolean;
  actions: { id: string; kind: string; description: string; mutates: boolean }[];
  preconditions: string[];
  restrictions: string[];
}

export interface WorkspaceOperationReceipt {
  schema: 'forge/WorkspaceOperationReceipt/v1';
  operation: WorkspaceOperationPlan['operation'];
  target: string;
  plan_sha256: string;
  status: 'planned' | 'applied' | 'blocked' | 'failed';
  created_at: string;
  completed_at: string | null;
  actions: { id: string; status: 'skipped' | 'applied' | 'blocked' | 'failed'; detail: string }[];
}
