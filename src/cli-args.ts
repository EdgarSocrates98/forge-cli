import { parseArgs } from 'node:util';
import { FORGE_REPOS } from './constants/repos.js';
import { isValidRef } from './git-revs.js';
import { validateNativeOptions } from './native-install.js';
import type { ForgeRepo } from './types.js';
import { S } from './ui/strings.js';

export const DEFAULT_TIMEOUT_SECS = 900;
export const MAX_JOBS = 8;

export interface CliOptions {
  dir?: string;
  all: boolean;
  only?: string[];
  yes: boolean;
  plan: boolean;
  skipScripts: boolean;
  skipVerify: boolean;
  timeoutSecs: number;
  help: boolean;
  jsonReport: boolean;
  reportPath?: string;
  retryFailed: boolean;
  fix: boolean;
  timeoutSet: boolean;
  jsonSet: boolean;
  jobs: number;
  jobsSet: boolean;
  onlyChanged: boolean;
  shallow: boolean;
  check: boolean;
  native: boolean;
  rollback: boolean;
  host?: string;
  gatewayProfile?: string;
  verbose: boolean;
  offline: boolean;
  profile?: string;
  scope?: string;
  components?: string;
  clean: boolean;
  ref?: string;
  trustCustom: boolean;
  runAfterSyncFailure: boolean;
  positionals: string[];
}

export class CliError extends Error {}

export function parseCliArgs(argv: string[]): CliOptions {
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        dir: { type: 'string' },
        all: { type: 'boolean' },
        only: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        plan: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'skip-scripts': { type: 'boolean' },
        'skip-verify': { type: 'boolean' },
        timeout: { type: 'string' },
        json: { type: 'boolean' },
        report: { type: 'string' },
        'retry-failed': { type: 'boolean' },
        fix: { type: 'boolean' },
        jobs: { type: 'string' },
        'only-changed': { type: 'boolean' },
        shallow: { type: 'boolean' },
        check: { type: 'boolean' },
        native: { type: 'boolean' },
        host: { type: 'string' },
        'gateway-profile': { type: 'string' },
        verbose: { type: 'boolean' },
        offline: { type: 'boolean' },
        profile: { type: 'string' },
        scope: { type: 'string' },
        components: { type: 'string' },
        clean: { type: 'boolean' },
        ref: { type: 'string' },
        version: { type: 'string' },
        'trust-custom': { type: 'boolean' },
        'run-after-sync-failure': { type: 'boolean' },
        rollback: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  const timeoutSecs = Number.parseInt(values.timeout ?? '', 10);
  if (values.timeout !== undefined && (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0)) {
    throw new CliError(S.errTimeoutInvalid);
  }
  const jobs = Number(values.jobs ?? '');
  if (values.jobs !== undefined && (!Number.isInteger(jobs) || jobs < 1 || jobs > MAX_JOBS)) {
    throw new CliError(S.errJobsInvalid);
  }

  if (values.ref !== undefined && values.version !== undefined) {
    throw new CliError(S.errRefExclusive);
  }
  const nativeError = validateNativeOptions({
    profile: values.profile,
    scope: values.scope,
    components: values.components,
    host: values.host,
    gatewayProfile: values['gateway-profile'],
  });
  if (nativeError) throw new CliError(nativeError);
  const ref = values.ref ?? values.version;
  if (ref !== undefined && !isValidRef(ref)) {
    throw new CliError(`${S.errRefInvalid}: ${ref}`);
  }

  return {
    dir: values.dir,
    all: values.all ?? false,
    only: values.only
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    yes: values.yes ?? false,
    plan: values.plan ?? values['dry-run'] ?? false,
    skipScripts: values['skip-scripts'] ?? false,
    skipVerify: values['skip-verify'] ?? false,
    timeoutSecs: values.timeout === undefined ? DEFAULT_TIMEOUT_SECS : timeoutSecs,
    help: values.help ?? false,
    jsonReport: (values.json ?? false) || values.report !== undefined,
    reportPath: values.report,
    retryFailed: values['retry-failed'] ?? false,
    fix: values.fix ?? false,
    timeoutSet: values.timeout !== undefined,
    jsonSet: values.json !== undefined || values.report !== undefined,
    jobs: values.jobs === undefined ? 1 : jobs,
    jobsSet: values.jobs !== undefined,
    onlyChanged: values['only-changed'] ?? false,
    shallow: values.shallow ?? false,
    check: values.check ?? false,
    native: values.native ?? false,
    rollback: values.rollback ?? false,
    host: values.host,
    gatewayProfile: values['gateway-profile'],
    verbose: values.verbose ?? false,
    offline: values.offline ?? false,
    profile: values.profile,
    scope: values.scope,
    components: values.components,
    clean: values.clean ?? false,
    ref,
    trustCustom: values['trust-custom'] ?? false,
    runAfterSyncFailure: values['run-after-sync-failure'] ?? false,
    positionals,
  };
}

export function isNonInteractive(cli: CliOptions): boolean {
  return cli.all || (cli.only?.length ?? 0) > 0 || cli.retryFailed;
}

export type Selection = { repos: ForgeRepo[] } | { error: string };

export function resolveSelection(
  cli: CliOptions,
  catalog: readonly ForgeRepo[] = FORGE_REPOS,
): Selection {
  if (cli.all) return { repos: [...catalog] };
  if (!cli.only?.length) return { repos: [] };
  const byName = new Map(catalog.map((r) => [r.name, r]));
  const missing = cli.only.filter((name) => !byName.has(name));
  if (missing.length) {
    return {
      error: `${S.errUnknownRepos}: ${missing.join(', ')} — ${S.validAre}: ${catalog
        .map((r) => r.name)
        .join(', ')}`,
    };
  }
  return { repos: cli.only.map((name) => byName.get(name)!) };
}

export function usage(): string {
  return S.usage;
}
