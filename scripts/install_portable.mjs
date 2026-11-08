#!/usr/bin/env node
/** Cross-platform source installer for forge-cli. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const input = process.argv.slice(2);
const dryRun = input.includes('--dry-run');
const quiet = input.includes('--quiet');
const noLink = input.includes('--no-link');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  process.stderr.write(
    `FORGE-NODE-VERSION-UNSUPPORTED: Node.js >=20 é necessário (detectado ${process.versions.node})\n`,
  );
  process.exit(2);
}
const steps = [
  [npm, ['ci'], 'dependências'],
  [npm, ['run', 'build'], 'bundle'],
];
if (!noLink) steps.push([npm, ['link'], 'comando forge-cli']);

const plan = {
  schema: 'forge/node-install/v1',
  package: packageJson.name,
  version: packageJson.version,
  root,
  platform: process.platform,
  dry_run: dryRun,
  mutates: !dryRun,
  steps: steps.map(([command, args, label]) => ({ command, args, label })),
};
if (dryRun) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}

for (const [command, args, label] of steps) {
  if (!quiet) process.stdout.write(`\n✦ Preparando ${label}...\n`);
  const runner = process.platform === 'win32' ? 'cmd.exe' : command;
  const runnerArgs =
    process.platform === 'win32' ? ['/d', '/s', '/c', [command, ...args].join(' ')] : args;
  const result = spawnSync(runner, runnerArgs, {
    cwd: root,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) {
    process.stderr.write(`FORGE-NODE-RUNTIME-UNAVAILABLE: ${result.error.message}\n`);
    process.exit(2);
  }
  if (result.status !== 0) {
    process.stderr.write(`FORGE-NODE-INSTALL-FAILED: ${label} saiu com código ${result.status}\n`);
    if (quiet && result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}
process.stdout.write(`\n✓ ${packageJson.name} ${packageJson.version} instalado.\n`);
process.stdout.write('Abra um novo terminal e execute: forge-cli\n');
