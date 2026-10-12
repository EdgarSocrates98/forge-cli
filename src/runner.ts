import path from 'node:path';
import { copyConfigExamples } from './configs.js';
import { ensureEnvFile, envNoteFor } from './env.js';
import type { ForgeRepo, RepoResult, RepoStatus } from './types.js';
import { S } from './ui/strings.js';
import {
  errorDetail,
  findSetupScript,
  npmInstallArgs,
  runStreamed,
  syncRepo,
} from './utils/system.js';

export interface RepoReporter {
  phase?: (phase: string) => void;
  commandStart?: (title: string) => void;
  commandLine?: (line: string) => void;
  commandEnd?: (ok: boolean, title: string) => void;
}

export async function processRepo(
  repo: ForgeRepo,
  targetDir: string,
  reporter: RepoReporter = {},
): Promise<RepoResult> {
  const start = Date.now();
  const elapsedMs = () => Date.now() - start;
  const repoDir = path.join(targetDir, repo.name);
  const notes: string[] = [];
  const finish = (status: RepoStatus, detail: string, envNote?: string): RepoResult => ({
    repo,
    status,
    detail,
    envNote,
    notes: notes.length ? notes : undefined,
    elapsedMs: elapsedMs(),
  });

  reporter.phase?.(S.phaseClone);
  let sync;
  try {
    sync = await syncRepo(repo, targetDir);
  } catch (error) {
    return finish('error', `${S.cloneFailed}: ${errorDetail(error)}`);
  }
  if (sync.kind === 'non-git') return finish('warning', S.nonGitDir);
  if (sync.dirty) notes.push(S.warnDirtyTree);
  const pullFailed = sync.kind === 'pull-failed';
  if (pullFailed) notes.push(S.warnPullFailed);

  let envNote: string | undefined;
  try {
    reporter.phase?.(S.phaseEnv);
    envNote = envNoteFor(await ensureEnvFile(repoDir));
  } catch (error) {
    return finish('error', `${S.envFailed}: ${errorDetail(error)}`, envNote);
  }

  reporter.phase?.(S.phaseConfigs);
  try {
    for (const target of await copyConfigExamples(repoDir)) {
      notes.push(`${S.configCopied}: ${target}`);
    }
  } catch (error) {
    return finish('error', `${S.configFailed}: ${errorDetail(error)}`, envNote);
  }

  const ran: string[] = [];
  const script = findSetupScript(repoDir);
  if (script) {
    reporter.phase?.(`${S.phaseInstall} ${script.file}`);
    reporter.commandStart?.(script.file);
    try {
      await runStreamed([script.command, ...script.args], repoDir, reporter.commandLine);
      reporter.commandEnd?.(true, script.file);
      ran.push(script.file);
    } catch (error) {
      reporter.commandEnd?.(false, script.file);
      return finish('error', `${S.installFailed} ${script.file}: ${errorDetail(error)}`, envNote);
    }
  }

  const npmArgs = npmInstallArgs(repoDir);
  if (npmArgs) {
    const title = `npm ${npmArgs[0]}`;
    reporter.phase?.(title);
    reporter.commandStart?.(title);
    try {
      await runStreamed(['npm', ...npmArgs], repoDir, reporter.commandLine);
      reporter.commandEnd?.(true, title);
      ran.push(title);
    } catch (error) {
      reporter.commandEnd?.(false, title);
      return finish('error', `${S.npmFailed}: ${errorDetail(error)}`, envNote);
    }
  }

  if (!ran.length) return finish('warning', S.noSetupSteps, envNote);

  let status: RepoStatus = pullFailed ? 'warning' : 'ok';
  if (repo.verify?.length) {
    reporter.phase?.(S.phaseVerify);
    try {
      await runStreamed(repo.verify, repoDir);
      notes.push(`${S.verifyOk}: ${repo.verify.join(' ')}`);
    } catch {
      status = 'warning';
      notes.push(`${S.verifyFailed}: ${repo.verify.join(' ')}`);
    }
  }

  return finish(status, `${S.installedVia} ${ran.join(' + ')}`, envNote);
}
