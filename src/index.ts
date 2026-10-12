#!/usr/bin/env node
import { cancel, intro, log, outro, spinner, taskLog } from '@clack/prompts';
import figlet from 'figlet';
import { runPreflight } from './preflight.js';
import { askConfirm, askRepos, askWorkspace } from './prompts.js';
import { renderReport, resultLine } from './report.js';
import { processRepo, type RepoReporter } from './runner.js';
import type { RepoResult } from './types.js';
import { S } from './ui/strings.js';
import { icons, theme } from './ui/theme.js';

const BANNER_LINE_DELAY_MS = 30;

async function printBanner(): Promise<void> {
  const art = figlet.textSync(S.bannerWord, { font: 'Standard' });
  for (const line of art.split('\n')) {
    console.log(theme.brand(line));
    await new Promise((resolve) => setTimeout(resolve, BANNER_LINE_DELAY_MS));
  }
}

async function checkEnvironment(): Promise<void> {
  log.step(`${icons.gear} ${S.preflightTitle}`);
  const checks = await runPreflight();
  for (const check of checks) {
    if (check.ok) {
      log.success(`${icons.ok} ${check.name} ${theme.dim(`(${check.detail})`)}`);
    } else {
      log.error(`${icons.err} ${check.name} ${theme.dim(`(${check.detail})`)}`);
    }
  }
  if (checks.some((check) => !check.ok)) {
    log.error(S.preflightFailed);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await printBanner();
  intro(theme.accent(S.intro));

  await checkEnvironment();

  const targetDir = await askWorkspace();
  const repos = await askRepos();
  await askConfirm(targetDir, repos.length);

  const results: RepoResult[] = [];
  for (const repo of repos) {
    const label = theme.accent(repo.name);
    let s = spinner({ indicator: 'timer' });
    s.start(label);
    let live: ReturnType<typeof taskLog> | undefined;

    const restartSpinner = () => {
      s = spinner({ indicator: 'timer' });
      s.start(label);
    };

    const reporter: RepoReporter = {
      phase: (phase) => s.message(`${label} — ${phase}`),
      commandStart: (title) => {
        s.stop(`${label} — ${title}`);
        live = taskLog({ title: theme.accent(`${repo.name} › ${title}`), limit: 8 });
      },
      commandLine: (line) => live?.message(theme.dim(line)),
      commandEnd: (ok, title) => {
        if (ok) {
          live?.success(`${repo.name} › ${title} ${theme.ok(icons.ok)}`);
        } else {
          live?.error(`${repo.name} › ${title} ${theme.err(icons.err)}`);
        }
        live = undefined;
        restartSpinner();
      },
    };

    const result = await processRepo(repo, targetDir, reporter);
    results.push(result);
    if (result.status === 'error') {
      s.error(resultLine(result));
    } else {
      s.stop(resultLine(result));
    }
  }

  renderReport(results);

  const hasErrors = results.some((r) => r.status === 'error');
  outro(`${icons.rocket} ${hasErrors ? S.outroWithErrors : S.outroOk}`);
}

process.on('SIGINT', () => {
  console.log('');
  cancel(S.interrupted);
  process.exit(130);
});

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
