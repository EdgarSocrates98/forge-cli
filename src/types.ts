export interface ForgeRepo {
  name: string;
  url: string;
  description: string;
}

export type RepoStatus = 'ok' | 'warning' | 'error';

export type EnvAction = 'exists' | 'copied' | 'stub';

export interface RepoResult {
  repo: ForgeRepo;
  status: RepoStatus;
  detail: string;
  envNote?: string;
  elapsedMs: number;
}

export interface InstallScript {
  file: string;
  command: string;
  args: string[];
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}
