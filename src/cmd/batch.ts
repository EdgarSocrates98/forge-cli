import { spinner, taskLog } from '@clack/prompts';
import { recordResult, withLog } from '../artifacts.js';
import { resultLine } from '../report.js';
import { processRepo, type RepoReporter, type RunOptions } from '../runner.js';
import type { ForgeRepo, RepoResult } from '../types.js';
import { estimateEtaMs, formatDuration, progressBar } from '../ui/progress.js';
import { gradient, icons, kindIcon, theme } from '../ui/theme.js';
import { S } from '../ui/strings.js';

let TASKLOG_LIMIT = 8;

export function setTaskLogLimit(limit: number): void {
  TASKLOG_LIMIT = limit;
}

export async function processBatch(
  repos: ForgeRepo[],
  targetDir: string,
  opts: RunOptions,
  logWrite: (line: string) => void,
  offset = 0,
  total = repos.length,
): Promise<RepoResult[]> {
  const results: RepoResult[] = [];
  const tty = Boolean(process.stdout.isTTY);
  const startedAt = Date.now();
  for (const [index, repo] of repos.entries()) {
    const label = `${theme.dim(`[${offset + index + 1}/${total}]`)} ${kindIcon[repo.kind]} ${theme.accent(repo.name)}`;
    let s = spinner({ indicator: 'timer' });
    s.start(label);
    let live: ReturnType<typeof taskLog> | undefined;

    const uiReporter: RepoReporter = {
      phase: (phase) => s.message(`${label} — ${phase}`),
      commandStart: (title) => {
        s.stop(`${label} — ${title}`);
        live = taskLog({ title: theme.accent(`${repo.name} › ${title}`), limit: TASKLOG_LIMIT });
      },
      commandLine: (line) => live?.message(theme.dim(line)),
      commandEnd: (ok, title) => {
        if (ok) {
          live?.success(`${repo.name} › ${title} ${theme.ok(icons.ok)}`);
        } else {
          live?.error(`${repo.name} › ${title} ${theme.err(icons.err)}`);
        }
        live = undefined;
        s = spinner({ indicator: 'timer' });
        s.start(label);
      },
    };

    const result = await processRepo(repo, targetDir, withLog(uiReporter, logWrite), opts);
    logWrite(`[result] ${repo.name} ${result.status}: ${result.detail}`);
    recordResult(targetDir, result);
    results.push(result);
    if (result.status === 'error') {
      s.error(resultLine(result));
    } else {
      s.stop(resultLine(result));
    }
    if (tty && total > 1) {
      const done = index + 1;
      const bar = progressBar(done / total, 14)
        .split('')
        .map((ch, i) => (ch === '█' ? gradient(ch, i / 14) : theme.dim(ch)))
        .join('');
      const elapsed = Date.now() - startedAt;
      const eta = estimateEtaMs(done, total, elapsed);
      const etaPart = eta !== null ? theme.dim(` · ~${formatDuration(eta)} ${S.boardEta}`) : '';
      process.stdout.write(
        `  ${bar} ${theme.accent(`${done}/${total}`)} ${theme.dim(S.overallProgress)} ${theme.dim(`· ${formatDuration(elapsed)}`)}${etaPart}\n`,
      );
    }
  }
  return results;
}
