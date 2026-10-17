export type RepoKind = 'python' | 'node';

export type NativeFlag = 'scope' | 'profile' | 'components' | 'host' | 'gateway-profile';

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
    flags: readonly NativeFlag[];
    /** Operações nativas de ciclo de vida (argv completo); aceitam --dry-run, sem --yes. */
    ops?: { update?: readonly string[]; uninstall?: readonly string[] };
  };
}

export type RepoStatus = 'ok' | 'warning' | 'error';

export type EnvAction = 'exists' | 'copied' | 'stub';

export type LifecyclePhase =
  | 'not-installed'
  | 'cloned'
  | 'prepared'
  | 'installed'
  | 'validated'
  | 'partial'
  | 'failed'
  | 'drifted';

export interface RepoResult {
  repo: ForgeRepo;
  status: RepoStatus;
  detail: string;
  envNote?: string;
  notes?: string[];
  elapsedMs: number;
  head?: string;
  phase?: LifecyclePhase;
}

export interface SetupScript {
  file: string;
  command: string;
  args: string[];
}

export type SyncKind =
  'cloned' | 'pulled' | 'pull-failed' | 'non-git' | 'remote-mismatch' | 'fixed-ref';

export type SyncFailure = 'diverged' | 'network' | 'auth' | 'unknown' | 'no-upstream';

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
