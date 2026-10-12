import path from 'node:path';
import { copyConfigExamples } from './configs.js';
import { ensureEnvFile, envNoteFor } from './env.js';
import { checkRepoPrereqs } from './prereqs.js';
import type { ForgeRepo, RepoResult, RepoStatus } from './types.js';
import { S } from './ui/strings.js';
import {
  currentHead,
  errorDetail,
  findSetupScript,
  npmInstallArgs,
  runStreamed,
  syncRepo,
} from './utils/system.js';
import type { CliState } from './artifacts.js';

export interface RepoReporter {
  phase?: (phase: string) => void;
  commandStart?: (title: string) => void;
  commandLine?: (line: string) => void;
  commandEnd?: (ok: boolean, title: string) => void;
}

export interface RunOptions {
  skipScripts?: boolean;
  skipVerify?: boolean;
  timeoutMs?: number;
  shallow?: boolean;
  onlyChanged?: boolean;
  state?: CliState['repos'];
}

export async function processRepo(
  repo: ForgeRepo,
  targetDir: string,
  reporter: RepoReporter = {},
  opts: RunOptions = {},
): Promise<RepoResult> {
  const start = Date.now();
  const elapsedMs = () => Date.now() - start;
  const repoDir = path.join(targetDir, repo.name);
  const notes: string[] = [];
  let head: string | null = null;
  const finish = (status: RepoStatus, detail: string, envNote?: string): RepoResult => ({
    repo,
    status,
    detail,
    envNote,
    notes: notes.length ? notes : undefined,
    elapsedMs: elapsedMs(),
    ...(head ? { head } : {}),
  });

  reporter.phase?.(S.phaseClone);
  let sync;
  try {
    sync = await syncRepo(repo, targetDir, { shallow: opts.shallow });
  } catch (error) {
    return finish('error', `${S.cloneFailed}: ${errorDetail(error)}`);
  }
  if (sync.kind === 'non-git') return finish('warning', S.nonGitDir);
  head = await currentHead(repoDir);
  const prior = opts.onlyChanged ? opts.state?.[repo.name] : undefined;
  if (prior?.status === 'ok' && prior.head && prior.head === head) {
    notes.push(S.unchanged);
    return finish('ok', S.unchanged);
  }
  if (sync.dirty) notes.push(S.warnDirtyTree);
  const pullFailed = sync.kind === 'pull-failed';
  if (pullFailed) notes.push(S.warnPullFailed);

  let envNote: string | undefined;
  try {
    reporter.phase?.(S.phaseEnv);
    envNote = envNoteFor(await ensureEnvFile(repoDir, repo.envKeys));
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

  reporter.phase?.(S.phasePrereqs);
  const prereqs = await checkRepoPrereqs(repoDir);
  const unmet = prereqs.filter((check) => !check.ok);
  if (unmet.length) {
    for (const check of unmet) notes.push(`${check.name} (${check.detail})`);
    return finish('error', `${S.prereqsFailed}: ${unmet.map((c) => c.name).join(', ')}`, envNote);
  }

  const ran: string[] = [];
  const script = opts.skipScripts ? null : findSetupScript(repoDir);
  if (script) {
    reporter.phase?.(`${S.phaseInstall} ${script.file}`);
    reporter.commandStart?.(script.file);
    try {
      await runStreamed(
        [script.command, ...script.args],
        repoDir,
        reporter.commandLine,
        opts.timeoutMs,
      );
      reporter.commandEnd?.(true, script.file);
      ran.push(script.file);
    } catch (error) {
      reporter.commandEnd?.(false, script.file);
      return finish('error', `${S.installFailed} ${script.file}: ${errorDetail(error)}`, envNote);
    }
  }

  const npmArgs = opts.skipScripts ? null : npmInstallArgs(repoDir);
  if (npmArgs) {
    const title = `npm ${npmArgs[0]}`;
    reporter.phase?.(title);
    reporter.commandStart?.(title);
    try {
      await runStreamed(['npm', ...npmArgs], repoDir, reporter.commandLine, opts.timeoutMs);
      reporter.commandEnd?.(true, title);
      ran.push(title);
    } catch (error) {
      reporter.commandEnd?.(false, title);
      return finish('error', `${S.npmFailed}: ${errorDetail(error)}`, envNote);
    }
  }

  if (!ran.length) return finish('warning', S.noSetupSteps, envNote);

  let status: RepoStatus = pullFailed ? 'warning' : 'ok';
  if (repo.verify?.length && !opts.skipVerify) {
    reporter.phase?.(S.phaseVerify);
    try {
      await runStreamed(repo.verify, repoDir, undefined, opts.timeoutMs);
      notes.push(`${S.verifyOk}: ${repo.verify.join(' ')}`);
    } catch {
      status = 'warning';
      notes.push(`${S.verifyFailed}: ${repo.verify.join(' ')}`);
    }
  }

  return finish(status, `${S.installedVia} ${ran.join(' + ')}`, envNote);
}

export async function processPool(
  repos: readonly ForgeRepo[],
  targetDir: string,
  opts: RunOptions,
  jobs: number,
  reporterFor: (repo: ForgeRepo, index: number) => RepoReporter,
  onResult?: (result: RepoResult) => void,
): Promise<RepoResult[]> {
  const results = new Array<RepoResult>(repos.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < repos.length) {
      const index = next++;
      const repo = repos[index];
      const result = await processRepo(repo, targetDir, reporterFor(repo, index), opts);
      results[index] = result;
      onResult?.(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, repos.length) }, worker));
  return results;
}
