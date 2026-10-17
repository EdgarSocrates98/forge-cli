#!/usr/bin/env node
/**
 * Bench Wave 7 — números REAIS medidos localmente, nunca inventados.
 * Mede: startup (--help), status (preflight+state merge), registry resolve
 * (PyPI online + cache-hit) e install registry completo num FORGE_CLI_HOME
 * descartável. Saída JSON estável em stdout; --runs N (default 3) tira a
 * mediana por métrica.
 *
 *   node scripts/bench.mjs [--runs 5] [--skip-install]
 *
 * Install precisa de rede+Python; pule com --skip-install em offline.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const cli = path.join(root, 'dist', 'index.js');
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 3;
const skipInstall = process.argv.includes('--skip-install');

const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (fn) => {
  const t0 = performance.now();
  const r = fn();
  return {
    ms: Math.round(performance.now() - t0),
    code: r.status,
    stderr: r.stderr?.toString().slice(0, 200),
  };
};
const run = (args, env = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });

const home = mkdtempSync(path.join(tmpdir(), 'forge-cli-bench-'));
const results = {
  schema: 'forge-cli/BenchReport/v1',
  node: process.version,
  platform: process.platform,
  runs,
  metrics: {},
};
try {
  const bench = (name, args, env = {}) => {
    const samples = [];
    let last;
    for (let i = 0; i < runs; i++) {
      last = time(() => run(args, env));
      samples.push(last.ms);
      if (last.code !== 0 && last.code !== null) {
        results.metrics[name] = { error: `exit ${last.code}`, detail: last.stderr };
        return;
      }
    }
    results.metrics[name] = { median_ms: median(samples), samples_ms: samples };
  };

  bench('startup_help', ['--help']);
  bench('status_cold', ['status', '--json'], { FORGE_CLI_HOME: home });
  bench('registry_list', ['registry', '--json'], { FORGE_CLI_HOME: home });
  bench('resolve_plan', ['install', 'the-forge', '--method', 'registry', '--plan', '--json'], {
    FORGE_CLI_HOME: home,
  });
  if (!skipInstall) {
    // Install frio mede 1x (idempotência recusa repetição); reinstall mede
    // o caminho quente de reinstalação por versão já resolvida.
    const cold = time(() =>
      run(['install', 'the-forge', '--method', 'registry', '--yes', '--json'], {
        FORGE_CLI_HOME: home,
      }),
    );
    results.metrics['registry_install_cold'] =
      cold.code === 0
        ? { median_ms: cold.ms, samples_ms: [cold.ms] }
        : { error: `exit ${cold.code}` };
    bench(
      'registry_reinstall',
      ['reinstall', 'the-forge', '--method', 'registry', '--yes', '--json'],
      {
        FORGE_CLI_HOME: home,
      },
    );
    bench(
      'update_check_cached',
      ['update', 'the-forge', '--method', 'registry', '--check', '--json'],
      {
        FORGE_CLI_HOME: home,
      },
    );
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
