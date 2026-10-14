import { log, note } from '@clack/prompts';
import type { CliOptions } from '../cli-args.js';
import { catalogFor } from './shared.js';
import { discoverEnvironment } from '../discovery.js';
import { recommendForjas } from '../recommend.js';
import {
  analyzeBumps,
  checkEnvLock,
  exportProfile,
  importProfile,
  interruptedRuns,
  writeEnvLock,
} from '../maintenance.js';
import { loadState } from '../artifacts.js';
import { S } from '../ui/strings.js';
import { theme } from '../ui/theme.js';
import { commandOutput, hasGitRepo, resolveTargetDir } from '../utils/system.js';
import { resolveInside } from '../safety.js';

function emit(cli: CliOptions, doc: object, render: () => string, title: string): void {
  if (cli.jsonReport) {
    console.log(JSON.stringify(doc, null, 2));
    return;
  }
  note(render(), title);
}

// forge-cli discover — bounded environment report (§2.1)
export async function runDiscoverCommand(cli: CliOptions): Promise<number> {
  const targetDir = resolveTargetDir(cli.dir);
  const report = await discoverEnvironment(targetDir);
  emit(
    cli,
    report,
    () =>
      [
        `${report.os.platform} ${report.os.arch}${report.os.shell ? ` · ${report.os.shell}` : ''}`,
        '',
        report.tools
          .map(
            (t) => `${t.found ? '✓' : '✗'} ${t.name}${t.version ? ` ${theme.dim(t.version)}` : ''}`,
          )
          .join('\n'),
        '',
        `${S.discoverSignals}: ${report.signals.join(', ') || '—'}`,
        `${S.discoverForges}: ${report.forges.map((f) => `${f.name}(${f.state})`).join(', ') || '—'}`,
        `${S.discoverHosts}: ${
          report.hosts
            .filter((h) => h.detected)
            .map((h) => h.name)
            .join(', ') || '—'
        }`,
        report.truncated ? `\n${S.discoverTruncated}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    S.discoverTitle,
  );
  return 0;
}

// forge-cli recommend — explainable recommendations (§2.2)
export async function runRecommendCommand(cli: CliOptions): Promise<number> {
  const targetDir = resolveTargetDir(cli.dir);
  const report = await discoverEnvironment(targetDir);
  const result = recommendForjas(report, catalogFor(targetDir));
  emit(
    cli,
    result,
    () => {
      if (!result.recommendations.length) return S.recommendNone;
      const parts = result.recommendations.map(
        (r) =>
          `${theme.accent(r.forge_id)} — ${S.recommendConfidence} ${Math.round(r.confidence * 100)}%` +
          (r.profile ? ` · profile ${r.profile}` : '') +
          (r.components?.length ? ` · ${r.components.join(',')}` : '') +
          (r.hosts?.length ? ` · hosts ${r.hosts.join(',')}` : '') +
          `\n${r.why.map((w) => `  ${theme.dim('·')} ${w}`).join('\n')}` +
          (r.prereqs?.length ? `\n  ${theme.dim('pré-reqs:')} ${r.prereqs.join(', ')}` : ''),
      );
      if (result.questions.length) {
        parts.push(
          `${S.recommendLowConfidence}\n${result.questions.map((q) => `  ? ${q}`).join('\n')}`,
        );
      }
      return parts.join('\n\n');
    },
    S.recommendTitle,
  );
  return 0;
}

// forge-cli lock [check] — env lockfile write/verify (§2.7)
export async function runLockCommand(cli: CliOptions, args: string[]): Promise<number> {
  const targetDir = resolveTargetDir(cli.dir);
  const catalog = catalogFor(targetDir);
  const verb = args[0] ?? 'write';
  if (verb === 'write') {
    const lock = writeEnvLock(targetDir, catalog);
    if (cli.jsonReport) console.log(JSON.stringify(lock, null, 2));
    else log.info(`${S.lockfileWritten} .forge-cli/env.lock.json`);
    return 0;
  }
  if (verb === 'check') {
    const checks = checkEnvLock(targetDir, catalog);
    if (cli.jsonReport) {
      console.log(JSON.stringify(checks, null, 2));
      return checks.some((c) => c.state === 'drifted') ? 1 : 0;
    }
    note(checks.map((c) => `${c.forge}: ${c.state}`).join('\n'), S.lockfileMismatch);
    return checks.some((c) => c.state === 'drifted') ? 1 : 0;
  }
  log.error(`${S.errUnknownCommand}: lock ${verb}`);
  return 2;
}

// forge-cli profile export|import <file> (§2.7)
export async function runProfileCommand(cli: CliOptions, args: string[]): Promise<number> {
  const targetDir = resolveTargetDir(cli.dir);
  const [verb, file] = args;
  if (verb === 'export' && file) {
    const profile = exportProfile(targetDir, file);
    if (cli.jsonReport) console.log(JSON.stringify(profile, null, 2));
    else log.info(`${S.profileExportDone} ${file}`);
    return 0;
  }
  if (verb === 'import' && file) {
    const result = importProfile(file);
    if ('error' in result) {
      log.error(`${S.profileImportInvalid}: ${result.error}`);
      return 1;
    }
    if (cli.jsonReport) console.log(JSON.stringify(result, null, 2));
    else {
      log.info(
        `${S.profileImportDone}: ${Object.keys(result.repos).length} repos` +
          (result.pins ? `, ${Object.keys(result.pins).length} pins` : ''),
      );
    }
    return 0;
  }
  log.error(`${S.errUnknownCommand}: profile ${verb ?? ''}`.trim());
  return 2;
}

// forge-cli recover — interrupted-run recovery report (§2.7)
export async function runRecoverCommand(cli: CliOptions): Promise<number> {
  const targetDir = resolveTargetDir(cli.dir);
  const interrupted = interruptedRuns(loadState(targetDir));
  emit(
    cli,
    { interrupted },
    () =>
      interrupted.length
        ? interrupted
            .map((i) => `${i.forge}: ${i.phase} → ${i.suggestion}${i.at ? ` (${i.at})` : ''}`)
            .join('\n')
        : S.doctorAllOk,
    S.recoveredRun,
  );
  return interrupted.length ? 1 : 0;
}

// forge-cli versions --check-bumps? — breaking analysis rides on versions data.
// Kept as a library function here; surfaced via `update --check` report lines.
export async function bumpAnalysis(
  targetDir: string,
  names: string[],
): Promise<Record<string, ReturnType<typeof analyzeBumps>>> {
  const catalog = catalogFor(targetDir);
  const out: Record<string, ReturnType<typeof analyzeBumps>> = {};
  for (const name of names) {
    const repo = catalog.find((r) => r.name === name);
    const dir = repo ? resolveInside(targetDir, repo.name) : null;
    if (!repo || !dir || !hasGitRepo(dir)) continue;
    const current = await commandOutput('git', ['-C', dir, 'describe', '--tags', '--abbrev=0']);
    if (!current || current === 'ok') continue;
    const tags =
      (await commandOutput('git', ['-C', dir, 'tag', '--list', '--sort=-v:refname'])) ?? '';
    const candidates = tags
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 8);
    out[name] = analyzeBumps(current, candidates);
  }
  return out;
}
