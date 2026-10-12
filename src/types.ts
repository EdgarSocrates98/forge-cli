export interface ForgeRepo {
  name: string;
  url: string;
  description: string;
}

export type RepoStatus = 'ok' | 'warning' | 'error';

export interface RepoResult {
  repo: ForgeRepo;
  status: RepoStatus;
  detail: string;
}

export interface InstallScript {
  file: string;
  command: string;
  args: string[];
}
