import type { CliState } from './artifacts.js';
import { resolveInside } from './safety.js';
import type { ForgeRepo, LifecyclePhase } from './types.js';
import { commandOutput, currentHead, hasGitRepo, isGitDirty } from './utils/system.js';

export type InstallPhase = LifecyclePhase;

export interface RepoStatusInfo {
  name: string;
  phase: InstallPhase;
  head?: string;
  describe?: string;
  dirty: boolean;
  /**
   * `.git` diretório/arquivo no checkout — sempre emitido: fontes locais
   * gitless (install <dir>) aparecem como instalação saudável com
   * is_git=false, nunca como "não-instalada" por ausência de `.git`.
   */
  is_git?: boolean;
  /** Campos do receipt local — preenchidos por mergeRegistryPhase. */
  install_method?: string;
  source_trust?: string;
  manifest_valid?: boolean;
  integrity?: string;
  source_dir?: string;
}

export function phaseOf(cloned: boolean, entry?: CliState['repos'][string]): InstallPhase {
  if (!cloned) return 'not-installed';
  if (!entry) return 'cloned';
  if (entry.phase) return entry.phase;
  if (entry.status === 'error') return 'failed';
  return 'installed';
}

export async function collectStatus(
  repos: readonly ForgeRepo[],
  targetDir: string,
  state: CliState | null,
): Promise<RepoStatusInfo[]> {
  const out: RepoStatusInfo[] = [];
  for (const repo of repos) {
    const dir = resolveInside(targetDir, repo.name);
    const entry = state?.repos[repo.name];
    if (!dir || !hasGitRepo(dir)) {
      out.push({ name: repo.name, phase: phaseOf(false, entry), dirty: false, is_git: false });
      continue;
    }
    const head = await currentHead(dir);
    const describe = await commandOutput('git', ['-C', dir, 'describe', '--tags', '--always']);
    let phase = phaseOf(true, entry);
    const recorded = entry?.head;
    if (recorded && head && recorded !== head && phase !== 'cloned') phase = 'drifted';
    out.push({
      name: repo.name,
      phase,
      head: head?.slice(0, 7),
      describe: describe && describe !== 'ok' ? describe : undefined,
      dirty: await isGitDirty(dir),
      is_git: true,
    });
  }
  return out;
}
