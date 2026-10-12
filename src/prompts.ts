import { cancel, confirm, isCancel, multiselect, note, text } from '@clack/prompts';
import { FORGE_REPOS } from './constants/repos.js';
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

export async function askRepos(
  catalog: readonly ForgeRepo[] = FORGE_REPOS,
): Promise<ForgeRepo[]> {
  const selected = await multiselect({
    message: S.askRepos,
    options: catalog.map((repo) => ({
      value: repo.name,
      label: repo.name,
      hint: repo.description,
    })),
    initialValues: catalog.map((repo) => repo.name),
    required: true,
  });
  if (isCancel(selected)) exitCancelled();
  return catalog.filter((repo) => selected.includes(repo.name));
}

export async function askConfirm(
  targetDir: string,
  count: number,
  total: number,
): Promise<void> {
  note(
    `${icons.folder} Destino: ${theme.accent(targetDir)}\n${icons.box} Repositórios: ${theme.accent(String(count))} de ${total}`,
    S.summaryTitle,
  );
  const proceed = await confirm({ message: S.confirmRun });
  if (isCancel(proceed) || !proceed) exitCancelled();
}
