import { parseArgs } from 'node:util';
import { FORGE_REPOS } from './constants/repos.js';
import type { ForgeRepo } from './types.js';
import { S } from './ui/strings.js';

export const DEFAULT_TIMEOUT_SECS = 900;

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
