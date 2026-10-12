export type RepoKind = 'python' | 'node';

export interface ForgeRepo {
  name: string;
  url: string;
  description: string;
  kind: RepoKind;
  verify?: readonly string[];
  nextSteps?: readonly string[];
  envKeys?: readonly string[];
  origin?: 'builtin' | 'custom';
  /** Instalador nativo documentado pela Forja (após o bootstrap), com as flags realmente suportadas. */
  nativeInstall?: {
    command: readonly string[];
    flags: readonly ('scope' | 'profile' | 'components')[];
  };
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
  head?: string;
}

export interface SetupScript {
  file: string;
  command: string;
  args: string[];
}

export type SyncKind =
  'cloned' | 'pulled' | 'pull-failed' | 'non-git' | 'remote-mismatch' | 'fixed-ref';

export type SyncFailure = 'diverged' | 'network' | 'auth' | 'unknown';

export interface SyncResult {
  kind: SyncKind;
  dirty: boolean;
  failure?: SyncFailure;
}

export type CheckSeverity = 'fatal' | 'warn';

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  severity: CheckSeverity;
}

export interface PrereqCheck {
  name: string;
  ok: boolean;
  detail: string;
}
