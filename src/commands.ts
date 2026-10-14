import type { CliOptions } from './cli-args.js';

export type Command =
  | 'run'
  | 'install'
  | 'clone'
  | 'update'
  | 'list'
  | 'status'
  | 'versions'
  | 'pin'
  | 'unpin'
  | 'rollback'
  | 'reinstall'
  | 'doctor'
  | 'help'
  | 'components'
  | 'discover'
  | 'recommend'
  | 'env'
  | 'hosts'
  | 'wizard'
  | 'lock'
  | 'profile'
  | 'recover'
  | 'self-install'
  | 'self-update'
  | 'self-uninstall'
  | 'uninstall'
  | 'unknown';

export interface ResolvedCommand {
  command: Command;
  names: string[];
  unknown?: string;
}

const REPO_COMMANDS = new Set([
  'install',
  'clone',
  'update',
  'versions',
  'status',
  'list',
  'pin',
  'unpin',
  'rollback',
  'reinstall',
]);

export function resolveCommand(cli: Pick<CliOptions, 'positionals'>): ResolvedCommand {
  const [head, ...rest] = cli.positionals;
  if (head === undefined) return { command: 'run', names: [] };
  if (head === 'self') {
    if (rest[0] === 'install') return { command: 'self-install', names: [] };
    if (rest[0] === 'uninstall') return { command: 'self-uninstall', names: [] };
    if (rest[0] === 'update') return { command: 'self-update', names: [] };
    return { command: 'unknown', names: [], unknown: `self ${rest[0] ?? ''}`.trim() };
  }
  if (head === 'help') return { command: 'help', names: [] };
  if (head === 'components') return { command: 'components', names: rest };
  if (head === 'doctor') return { command: 'doctor', names: rest };
  if (head === 'discover') return { command: 'discover', names: rest };
  if (head === 'recommend') return { command: 'recommend', names: rest };
  if (head === 'env') return { command: 'env', names: rest };
  if (head === 'hosts') return { command: 'hosts', names: rest };
  if (head === 'wizard') return { command: 'wizard', names: rest };
  if (head === 'lock') return { command: 'lock', names: rest };
  if (head === 'profile') return { command: 'profile', names: rest };
  if (head === 'recover') return { command: 'recover', names: rest };
  if (head === 'uninstall') return { command: 'uninstall', names: rest };
  if (REPO_COMMANDS.has(head)) return { command: head as Command, names: rest };
  return { command: 'unknown', names: [], unknown: head };
}
