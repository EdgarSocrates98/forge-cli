import { describe, expect, it } from 'vitest';
import {
  CliError,
  DEFAULT_TIMEOUT_SECS,
  isNonInteractive,
  parseCliArgs,
  resolveSelection,
  usage,
} from '../src/cli-args.js';
import { FORGE_REPOS } from '../src/constants/repos.js';

describe('parseCliArgs', () => {
  it('defaults to interactive with no selection flags', () => {
    const cli = parseCliArgs([]);
    expect(cli.all).toBe(false);
    expect(cli.only).toBeUndefined();
    expect(cli.plan).toBe(false);
    expect(cli.timeoutSecs).toBe(DEFAULT_TIMEOUT_SECS);
    expect(isNonInteractive(cli)).toBe(false);
  });

  it('parses selection and confirmation flags', () => {
    const cli = parseCliArgs(['--all', '--yes']);
    expect(cli.all).toBe(true);
    expect(cli.yes).toBe(true);
    expect(isNonInteractive(cli)).toBe(true);
  });

  it('parses --only as a trimmed name list', () => {
    const cli = parseCliArgs(['--only', 'the-forge, api-forge ,forge-portal']);
    expect(cli.only).toEqual(['the-forge', 'api-forge', 'forge-portal']);
    expect(isNonInteractive(cli)).toBe(true);
  });

  it('accepts --dir, skips, timeout and -h/-y shorts', () => {
    const cli = parseCliArgs([
      '--dir',
      'ws',
      '--skip-scripts',
      '--skip-verify',
      '--timeout',
      '60',
      '-y',
      '-h',
    ]);
    expect(cli.dir).toBe('ws');
    expect(cli.skipScripts).toBe(true);
    expect(cli.skipVerify).toBe(true);
    expect(cli.timeoutSecs).toBe(60);
    expect(cli.yes).toBe(true);
    expect(cli.help).toBe(true);
  });

  it('parses --fix for doctor mode', () => {
    const cli = parseCliArgs(['doctor', '--fix']);
    expect(cli.fix).toBe(true);
    expect(cli.positionals).toEqual(['doctor']);
    expect(parseCliArgs(['doctor']).fix).toBe(false);
  });

  it('treats --dry-run as --plan', () => {
    expect(parseCliArgs(['--plan']).plan).toBe(true);
    expect(parseCliArgs(['--dry-run']).plan).toBe(true);
  });

  it('parses --jobs/--only-changed/--shallow with defaults', () => {
    const cli = parseCliArgs(['--jobs', '4', '--only-changed', '--shallow']);
    expect(cli.jobs).toBe(4);
    expect(cli.jobsSet).toBe(true);
    expect(cli.onlyChanged).toBe(true);
    expect(cli.shallow).toBe(true);
    const bare = parseCliArgs([]);
    expect(bare.jobs).toBe(1);
    expect(bare.jobsSet).toBe(false);
    expect(bare.onlyChanged).toBe(false);
    expect(bare.shallow).toBe(false);
  });

  it('throws CliError on out-of-range or non-numeric --jobs', () => {
    for (const value of ['0', '9', 'abc', '2.5x']) {
      expect(() => parseCliArgs(['--jobs', value])).toThrow(CliError);
    }
    expect(parseCliArgs(['--jobs', '8']).jobs).toBe(8);
  });

  it('throws CliError on unknown flag and bad timeout', () => {
    expect(() => parseCliArgs(['--nope'])).toThrow(CliError);
    expect(() => parseCliArgs(['--timeout', 'abc'])).toThrow(CliError);
    expect(() => parseCliArgs(['--timeout', '-5'])).toThrow(CliError);
  });
});

describe('resolveSelection', () => {
  it('--all returns the whole catalog', () => {
    const sel = resolveSelection(parseCliArgs(['--all']));
    expect('repos' in sel && sel.repos).toHaveLength(FORGE_REPOS.length);
  });

  it('--only returns matching catalog entries', () => {
    const sel = resolveSelection(parseCliArgs(['--only', 'api-forge,forge-portal']));
    expect('repos' in sel && sel.repos.map((r) => r.name)).toEqual(['api-forge', 'forge-portal']);
  });

  it('reports unknown names with the valid list', () => {
    const sel = resolveSelection(parseCliArgs(['--only', 'api-forge,nope']));
    expect('error' in sel && sel.error).toContain('nope');
    expect('error' in sel && sel.error).toContain('forge-portal');
  });

  it('returns empty when nothing selected', () => {
    const sel = resolveSelection(parseCliArgs([]));
    expect('repos' in sel && sel.repos).toHaveLength(0);
  });
});

describe('usage', () => {
  it('documents the main flags', () => {
    const text = usage();
    for (const flag of [
      '--dir',
      '--all',
      '--only',
      '--plan',
      '--timeout',
      '--help',
      '--jobs',
      '--only-changed',
      '--shallow',
    ]) {
      expect(text).toContain(flag);
    }
  });
});
