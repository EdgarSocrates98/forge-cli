import { log } from '@clack/prompts';
import figlet from 'figlet';
import standardFont from 'figlet/importable-fonts/Standard.js';
import { loadCustomRepos, mergeCatalog } from '../artifacts.js';
import { type CliOptions } from '../cli-args.js';
import { FORGE_REPOS } from '../constants/repos.js';
import { runPreflight } from '../preflight.js';
import type { ForgeRepo } from '../types.js';
import { S } from '../ui/strings.js';
import { icons, theme } from '../ui/theme.js';
import { resolveTargetDir } from '../utils/system.js';

export const BANNER_LINE_DELAY_MS = 30;

export async function printBanner(): Promise<void> {
  figlet.parseFont('Standard', standardFont);
  const art = figlet.textSync(S.bannerWord, { font: 'Standard' });
  for (const line of art.split('\n')) {
    console.log(theme.brand(line));
    await new Promise((resolve) => setTimeout(resolve, BANNER_LINE_DELAY_MS));
  }
}

export async function checkEnvironment(): Promise<void> {
  log.step(`${icons.gear} ${S.preflightTitle}`);
  const checks = await runPreflight();
  for (const check of checks) {
    const hint = !check.ok && check.hint ? ` ${theme.dim(`→ ${check.hint}`)}` : '';
    if (check.ok) {
      log.success(`${icons.ok} ${check.name} ${theme.dim(`(${check.detail})`)}`);
    } else if (check.severity === 'warn') {
      log.warn(`${icons.warn} ${check.name} ${theme.dim(`(${check.detail})`)}${hint}`);
    } else {
      log.error(`${icons.err} ${check.name} ${theme.dim(`(${check.detail})`)}${hint}`);
    }
  }
  if (checks.some((check) => !check.ok && check.severity === 'fatal')) {
    log.error(S.preflightFailed);
    process.exit(1);
  }
}

export function emitJson(data: unknown, exitCode = 0): never {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  process.exit(exitCode);
}

export function catalogFor(targetDir: string): ForgeRepo[] {
  const custom = loadCustomRepos(targetDir);
  if (custom && 'repos' in custom) {
    if (custom.rejected.length) {
      log.warn(`${S.customReposRejected}: ${custom.rejected.join(', ')}`);
    }
    const hasNew = custom.repos.some((r) => !FORGE_REPOS.some((c) => c.name === r.name));
    if (hasNew) log.info(`${S.customReposLoaded} ${theme.dim(`(${custom.repos.length})`)}`);
    return mergeCatalog(FORGE_REPOS, custom.repos);
  }
  if (custom && 'error' in custom) log.warn(S.customReposInvalid);
  return [...FORGE_REPOS];
}

export function reposByNames(
  catalog: ForgeRepo[],
  names: string[],
): ForgeRepo[] | { error: string } {
  if (!names.length) return catalog;
  const missing = names.filter((n) => !catalog.some((r) => r.name === n));
  if (missing.length) return { error: `${S.errUnknownRepos}: ${missing.join(', ')}` };
  return catalog.filter((r) => names.includes(r.name));
}

export function pickOne(cli: CliOptions, names: string[]): ForgeRepo | null {
  if (names.length !== 1) {
    log.error(S.errNeedsOneName);
    process.exit(2);
  }
  const picked = reposByNames(catalogFor(resolveTargetDir(cli.dir)), names);
  if ('error' in picked) {
    log.error(picked.error);
    process.exit(2);
  }
  return picked[0] ?? null;
}

export const REFUSAL_TEXT = {
  'invalid-name': S.uninstallReasonInvalid,
  symlink: S.uninstallReasonSymlink,
  'non-git': S.uninstallReasonNonGit,
  'remote-mismatch': S.uninstallReasonRemote,
  dirty: S.uninstallReasonDirty,
} as const;
