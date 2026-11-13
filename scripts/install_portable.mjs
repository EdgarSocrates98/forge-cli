#!/usr/bin/env node
/** Cross-platform source installer for forge-cli.
 *
 * Channels: the machine contract stays on stdout (the forge/node-install/v1
 * plan under --dry-run). All human-facing presentation — banner, numbered
 * stepper with spinner, failure evidence and the closing panel — goes to
 * stderr, so `install.sh --dry-run | jq` is clean end-to-end.
 *
 * Decoration is TTY-gated and honors NO_COLOR / FORGE_NO_UI / CI /
 * GITHUB_ACTIONS / TERM=dumb plus the --quiet and --plain flags; --verbose
 * streams each command's output instead of capturing it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const input = process.argv.slice(2);
const dryRun = input.includes('--dry-run');
const quiet = input.includes('--quiet');
const plain = input.includes('--plain');
const verbose = input.includes('--verbose');
const noLink = input.includes('--no-link');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// ---- presentation (stderr only) ------------------------------------------
const stderrTTY = process.stderr.isTTY === true;
// FORGE_BOOTSTRAP_UI=always|never — same escape hatch as forge_bootstrap.py;
// explicit --quiet/--plain flags still outrank it.
const uiForced = (process.env.FORGE_BOOTSTRAP_UI || '').trim().toLowerCase();
const uiAlways = ['always', 'on', 'rich', '1', 'yes', 'true'].includes(uiForced);
const uiNever = ['never', 'off', 'plain', '0', 'no', 'false'].includes(uiForced);
const decorated =
  !quiet &&
  !plain &&
  !uiNever &&
  (uiAlways ||
    (stderrTTY &&
      !process.env.NO_COLOR &&
      !process.env.FORGE_NO_UI &&
      !process.env.CI &&
      !process.env.GITHUB_ACTIONS &&
      process.env.TERM !== 'dumb'));
const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '';
const unicode = /utf-?8/i.test(locale) || !!process.env.WT_SESSION || !!process.env.MSYSTEM;
const mark = unicode
  ? { ok: '✓', fail: '✗', plan: '◌', next: '→', em: '◆', rule: '─', bullet: '·' }
  : { ok: 'OK', fail: 'x', plan: 'o', next: '->', em: '*', rule: '-', bullet: '-' };
const FRAMES = unicode ? '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' : '|/-\\';
const sgr = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const ui = {
  write(text = '') {
    if (quiet) return;
    process.stderr.write(`${text}\n`);
  },
  banner() {
    if (!decorated) return;
    const mode = dryRun ? 'plan only' : 'user scope';
    this.write('');
    this.write(
      `  ${sgr('38;5;208;1', `${mark.em} FORJAS`)} ${sgr('2', mark.bullet)} ${sgr('1', packageJson.name)}`,
    );
    this.write(
      `  ${sgr('2', `portable install ${mark.bullet} node ${process.versions.node} ${mark.bullet} ${mode}`)}`,
    );
    this.write(`  ${sgr('2', mark.rule.repeat(54))}`);
  },
  steps(steps) {
    if (!decorated) return;
    steps.forEach(([, , label], i) => {
      this.write(
        `  ${sgr('33', mark.plan)} ${sgr('2', `[${i + 1}/${steps.length}]`)} ${label} ${sgr('2', 'planned')}`,
      );
    });
  },
  summary(rows, hint) {
    if (!decorated) return;
    this.write(`  ${sgr('2', mark.rule.repeat(54))}`);
    this.write(`  ${sgr('32', mark.ok)} ${sgr('1', 'install complete')}`);
    this.write('');
    for (const [key, value] of rows) this.write(`    ${sgr('36', key.padEnd(9))} ${value}`);
    if (hint) {
      this.write('');
      this.write(`    ${sgr('33', 'next')}  ${hint}`);
    }
    this.write(`  ${sgr('2', mark.rule.repeat(54))}`);
    this.write('');
  },
  refuse(code, detail, remedy) {
    // The FORGE-* line is the greppable contract — always emitted, even
    // under --quiet; the decorated panel only appears when styled.
    if (quiet) {
      process.stderr.write(`${code}: ${detail}\n`);
      return;
    }
    this.write('');
    this.write(
      `  ${sgr('31', mark.fail)} ${sgr('1;31', 'install refused')} ${sgr('2', mark.rule)} ${sgr('31', code)}`,
    );
    this.write(`    ${sgr('2', detail)}`);
    if (remedy) this.write(`    ${sgr('33', 'remedy')}  ${remedy}`);
    this.write('');
  },
};

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  ui.refuse(
    'FORGE-NODE-VERSION-UNSUPPORTED',
    `Node.js >=20 é necessário (detectado ${process.versions.node})`,
    'instale Node.js >=20 e rode ./install.sh novamente',
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
  ui.banner();
  ui.steps(steps);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}

ui.banner();

// runStep: spinner on stderr while the child is captured; --verbose streams
// instead. On failure the captured output becomes the refusal evidence.
function runStep(command, args, label, i, n) {
  const t0 = Date.now();
  const runner = process.platform === 'win32' ? 'cmd.exe' : command;
  const runnerArgs =
    process.platform === 'win32' ? ['/d', '/s', '/c', [command, ...args].join(' ')] : args;

  let timer = null;
  let frame = 0;
  if (decorated && !verbose) {
    timer = setInterval(() => {
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      process.stderr.write(
        `\r\x1b[K  ${sgr('38;5;208', FRAMES[frame % FRAMES.length])} ${sgr('2', `[${i}/${n}]`)} ${label} ${sgr('2', `${dt}s`)}`,
      );
      frame += 1;
    }, 90);
  } else if (!quiet) {
    process.stderr.write(`  ${sgr('2', `[${i}/${n}]`)} ${label}\n`);
  }

  const result = spawnSync(runner, runnerArgs, {
    cwd: root,
    stdio: verbose && !quiet ? 'inherit' : 'pipe',
    encoding: 'utf8',
  });
  if (timer) clearInterval(timer);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  return { result, dt, label };
}

for (const [i, [command, args, label]] of steps.entries()) {
  const { result, dt } = runStep(command, args, label, i + 1, steps.length);
  if (result.error) {
    if (decorated) process.stderr.write('\r\x1b[K');
    ui.refuse(
      'FORGE-NODE-RUNTIME-UNAVAILABLE',
      result.error.message,
      'instale Node.js/npm e reabra o terminal',
    );
    process.exit(2);
  }
  if (result.status !== 0) {
    if (decorated) process.stderr.write('\r\x1b[K');
    ui.refuse(
      'FORGE-NODE-INSTALL-FAILED',
      `${label} saiu com código ${result.status}`,
      'o log do passo acima é a evidência — corrija e rode ./install.sh novamente',
    );
    const captured = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
    if (captured) process.stderr.write(`${sgr('2', captured)}\n`);
    process.exit(result.status ?? 1);
  }
  if (decorated) {
    process.stderr.write(
      `\r\x1b[K  ${sgr('32', mark.ok)} ${sgr('2', `[${i + 1}/${steps.length}]`)} ${label} ${sgr('2', `${dt}s`)}\n`,
    );
  } else if (!quiet) {
    process.stderr.write(`  ${sgr('2', `[${i + 1}/${steps.length}]`)} ${label} done (${dt}s)\n`);
  }
}

ui.summary(
  [
    ['package', `${packageJson.name} ${packageJson.version}`],
    ['root', root],
    ['link', noLink ? 'skipped (--no-link)' : `npm link ${mark.next} comando forge-cli`],
  ],
  'abra um novo terminal e execute: forge-cli',
);
// Human completion text on stdout is harmless — the machine contract only
// exists under --dry-run, which exits above before reaching this point.
process.stdout.write(`\n${mark.ok} ${packageJson.name} ${packageJson.version} instalado.\n`);
process.stdout.write('Abra um novo terminal e execute: forge-cli\n');
