export interface ForgeRepo {
  name: string;
  url: string;
  description: string;
  verify?: readonly string[];
  nextSteps?: readonly string[];
  envKeys?: readonly string[];
}

export type RepoStatus = 'ok' | 'warning' | 'error';

export type EnvAction = 'exists' | 'copied' | 'stub';

export interface RepoResult {
  repo: ForgeRepo;
  status: RepoStatus;
  detail: string;
  envNote?: string;
  notes?: string[];
  elapsedMs: number;
}

export interface SetupScript {
  file: string;
  command: string;
  args: string[];
}

export type SyncKind = 'cloned' | 'pulled' | 'pull-failed' | 'non-git';

export interface SyncResult {
  kind: SyncKind;
  dirty: boolean;
}

export type CheckSeverity = 'fatal' | 'warn';

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  severity: CheckSeverity;
}
