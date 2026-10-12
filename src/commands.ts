import type { CliOptions } from './cli-args.js';

export type Command =
  | 'run'
  | 'install'
  | 'clone'
  | 'update'
  | 'list'
  | 'status'
  | 'versions'
  | 'doctor'
  | 'self-install'
  | 'self-uninstall'
  | 'uninstall'
  | 'unknown';

export interface ResolvedCommand {
  command: Command;
  names: string[];
  unknown?: string;
}

const REPO_COMMANDS = new Set(['install', 'clone', 'update', 'versions', 'status', 'list']);

export function resolveCommand(cli: Pick<CliOptions, 'positionals'>): ResolvedCommand {
  const [head, ...rest] = cli.positionals;
  if (head === undefined) return { command: 'run', names: [] };
  if (head === 'self') {
    if (rest[0] === 'install') return { command: 'self-install', names: [] };
    if (rest[0] === 'uninstall') return { command: 'self-uninstall', names: [] };
    return { command: 'unknown', names: [], unknown: `self ${rest[0] ?? ''}`.trim() };
  }
  if (head === 'doctor') return { command: 'doctor', names: rest };
  if (head === 'uninstall') return { command: 'uninstall', names: rest };
  if (REPO_COMMANDS.has(head)) return { command: head as Command, names: rest };
  return { command: 'unknown', names: [], unknown: head };
}
