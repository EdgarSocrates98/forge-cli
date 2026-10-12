import path from 'node:path';
import { execa } from 'execa';
import { ensureEnvFile, envNoteFor } from './env.js';
import type { ForgeRepo, RepoResult } from './types.js';
import { S } from './ui/strings.js';
import { cloneOrPull, errorDetail, findInstallScript } from './utils/system.js';

export type PhaseReporter = (phase: string) => void;

export async function processRepo(
  repo: ForgeRepo,
  targetDir: string,
  onPhase?: PhaseReporter,
): Promise<RepoResult> {
  const start = Date.now();
  const elapsedMs = () => Date.now() - start;
  const repoDir = path.join(targetDir, repo.name);

  try {
    onPhase?.(S.phaseClone);
    await cloneOrPull(repo, targetDir);
  } catch (error) {
    return {
      repo,
      status: 'error',
      detail: `${S.cloneFailed}: ${errorDetail(error)}`,
      elapsedMs: elapsedMs(),
    };
  }

  let envNote: string | undefined;
  try {
    onPhase?.(S.phaseEnv);
    envNote = envNoteFor(await ensureEnvFile(repoDir));
  } catch (error) {
    return {
      repo,
      status: 'error',
      detail: `${S.envFailed}: ${errorDetail(error)}`,
      envNote,
      elapsedMs: elapsedMs(),
    };
  }

  const script = findInstallScript(repoDir);
  if (!script) {
    return {
      repo,
      status: 'warning',
      detail: S.noInstallScript,
      envNote,
      elapsedMs: elapsedMs(),
    };
  }

  try {
    onPhase?.(`${S.phaseInstall} ${script.file}`);
    await execa(script.command, script.args, { cwd: repoDir });
    return {
      repo,
      status: 'ok',
      detail: `${S.installedVia} ${script.file}`,
      envNote,
      elapsedMs: elapsedMs(),
    };
  } catch (error) {
    return {
      repo,
      status: 'error',
      detail: `${S.installFailed} ${script.file}: ${errorDetail(error)}`,
      envNote,
      elapsedMs: elapsedMs(),
    };
  }
}
