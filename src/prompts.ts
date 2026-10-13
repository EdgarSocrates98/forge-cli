import { autocompleteMultiselect, cancel, confirm, isCancel, note, text } from '@clack/prompts';
import { FORGE_REPOS } from './constants/repos.js';
import type { RepoStatusInfo } from './status.js';
import type { ForgeRepo } from './types.js';
import { S } from './ui/strings.js';
import { icons, theme } from './ui/theme.js';
import { ensureDir, resolveTargetDir } from './utils/system.js';

export function exitCancelled(): never {
  cancel(S.cancelled);
  process.exit(0);
}

export async function askWorkspace(): Promise<string> {
  const answer = await text({
    message: S.askDir,
    placeholder: S.askDirDefault,
    defaultValue: S.askDirDefault,
  });
  if (isCancel(answer)) exitCancelled();

  const targetDir = resolveTargetDir(answer);
  await ensureDir(targetDir);
  return targetDir;
}

export function repoHint(repo: ForgeRepo, info?: RepoStatusInfo): string {
  if (!info) return repo.description;
  const label: Record<RepoStatusInfo['phase'], string> = {
    'not-installed': S.statusNotInstalled,
    cloned: S.statusCloned,
    prepared: S.statusPrepared,
    installed: S.statusInstalled,
    validated: S.statusValidated,
    partial: S.statusPartial,
    failed: S.statusFailed,
    drifted: S.statusDrifted,
  };
  const version = info.describe ?? info.head;
  const parts = [label[info.phase], version, info.dirty ? S.warnDirtyTree : undefined];
  return `${repo.description} · ${parts.filter(Boolean).join(' · ')}`;
}

export async function askRepos(
  catalog: readonly ForgeRepo[] = FORGE_REPOS,
  opts: {
    initialAll?: boolean;
    status?: ReadonlyMap<string, RepoStatusInfo>;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  } = {},
): Promise<ForgeRepo[]> {
  const selected = await autocompleteMultiselect({
    ...(opts.input ? { input: opts.input as NodeJS.ReadStream } : {}),
    ...(opts.output ? { output: opts.output as NodeJS.WriteStream } : {}),
    message: `${S.askRepos} ${theme.dim(S.askReposHelp)}`,
    placeholder: S.askReposPlaceholder,
    withGuide: false,
    options: catalog.map((repo) => ({
      value: repo.name,
      label: repo.name,
      hint: repoHint(repo, opts.status?.get(repo.name)),
    })),
    initialValues: opts.initialAll === false ? [] : catalog.map((repo) => repo.name),
    required: true,
  });
  if (isCancel(selected)) exitCancelled();
  return catalog.filter((repo) => selected.includes(repo.name));
}

export async function askConfirm(targetDir: string, count: number, total: number): Promise<void> {
  note(
    `${icons.folder} Destino: ${theme.accent(targetDir)}\n${icons.box} Repositórios: ${theme.accent(String(count))} de ${total}`,
    S.summaryTitle,
  );
  const proceed = await confirm({ message: S.confirmRun });
  if (isCancel(proceed) || !proceed) exitCancelled();
}

export async function askTrustCustom(name: string): Promise<boolean> {
  const answer = await confirm({
    message: `${S.askTrustCustom} ${name}?`,
    initialValue: false,
  });
  if (isCancel(answer)) exitCancelled();
  return answer;
}
