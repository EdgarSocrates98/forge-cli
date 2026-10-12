#!/usr/bin/env node
import { cancel, intro, log, outro, spinner } from '@clack/prompts';
import figlet from 'figlet';
import { runPreflight } from './preflight.js';
import { askConfirm, askRepos, askWorkspace } from './prompts.js';
import { renderReport, resultLine } from './report.js';
import { processRepo } from './runner.js';
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
    const s = spinner({ indicator: 'timer' });
    s.start(theme.accent(repo.name));
    const result = await processRepo(repo, targetDir, (phase) =>
      s.message(`${theme.accent(repo.name)} — ${phase}`),
    );
    results.push(result);
    s.stop(resultLine(result), result.status === 'error' ? 1 : 0);
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
