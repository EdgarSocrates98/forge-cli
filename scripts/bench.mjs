#!/usr/bin/env node
/**
 * Bench Wave 7+ — números REAIS medidos localmente, nunca inventados.
 * Mede: startup (--help/--version), status, registry list, plan de install
 * (resolve+select, sem mutação), install-dry (--plan git), handshake MCP
 * contra mock stdio local e, sem --skip-install, install registry completo
 * num FORGE_CLI_HOME descartável.
 *
 *   node scripts/bench.mjs [--runs 5] [--skip-install] [--json]
 *
 * Saída padrão: tabela no stdout + JSON completo em stderr… não —
 * a tabela vai no stdout e o JSON só sai com --json (máquina) ou
 * FORGE_CLI_BENCH_JSON=1. Install precisa de rede+Python; pule com
 * --skip-install em offline.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const cli = path.join(root, 'dist', 'index.js');
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 3;
const skipInstall = process.argv.includes('--skip-install');
const jsonOut = process.argv.includes('--json') || process.env.FORGE_CLI_BENCH_JSON === '1';

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

// --- mock MCP stdio: venv fake dentro do home descartável -------------------
// argv do catálogo api-forge = ['{binDir}/apiforge-mcp'] → basta um arquivo
// executável na venv fake. Windows não executa script sem extensão → métrica
// registrada como skipped (honesto, não inventado).
function seedMcpMock() {
  if (process.platform === 'win32') return { skipped: 'stdio mock só POSIX (shebang)' };
  const venvBin = path.join(home, '.forge-cli', 'forges', 'api-forge', 'venv', 'bin');
  mkdirSync(venvBin, { recursive: true });
  const mcp = path.join(venvBin, 'apiforge-mcp');
  writeFileSync(
    mcp,
    [
      '#!/usr/bin/env node',
      "const rl=require('readline').createInterface({input:process.stdin});",
      "rl.on('line',(l)=>{const m=JSON.parse(l);",
      "if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'bench-mock',version:'0'}}})+'\\n');",
      "if(m.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'apiforge_tools',inputSchema:{type:'object'}}]}})+'\\n');",
      "if(m.method==='tools/call')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'ok'}]}})+'\\n');",
      '});',
    ].join('\n'),
  );
  chmodSync(mcp, 0o755);
  const stateDir = path.join(home, '.forge-cli', 'forges');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'state.json'),
    JSON.stringify({
      forges: {
        'api-forge': {
          forge: 'api-forge',
          dist: 'apiforge-af',
          bin: path.join(venvBin, 'apiforge'),
          venv: path.dirname(venvBin),
        },
      },
    }),
  );
  return {};
}

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
  bench('startup_version', ['--version']);
  bench('status_cold', ['status', '--json'], { FORGE_CLI_HOME: home });
  bench('registry_list', ['registry', '--json'], { FORGE_CLI_HOME: home });
  // plan: resolve+seleção sem mutação (registry resolve usa rede/cache PyPI)
  bench('resolve_plan', ['install', 'the-forge', '--method', 'registry', '--plan', '--json'], {
    FORGE_CLI_HOME: home,
  });
  // install-dry: --plan do método git — preflight+catálogo+plano, sem clone
  bench('install_dry', ['install', 'the-forge', '--plan', '--json'], {
    FORGE_CLI_HOME: home,
  });
  const seeded = seedMcpMock();
  if (seeded.skipped) {
    results.metrics['mcp_handshake_mock'] = { skipped: seeded.skipped };
  } else {
    bench('mcp_handshake_mock', ['mcp', 'api-forge', '--verify', '--json'], {
      FORGE_CLI_HOME: home,
    });
  }
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

if (jsonOut) {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} else {
  // Tabela legível — mediana + amostras; erro/skip na coluna de status.
  const rows = Object.entries(results.metrics);
  const nameW = Math.max(6, ...rows.map(([n]) => n.length));
  const head = `${'métrica'.padEnd(nameW)}  mediana_ms  amostras_ms / status`;
  const lines = rows.map(([name, m]) => {
    if (m.error) return `${name.padEnd(nameW)}  —          ERRO ${m.error}`;
    if (m.skipped) return `${name.padEnd(nameW)}  —          SKIP ${m.skipped}`;
    return `${name.padEnd(nameW)}  ${String(m.median_ms).padStart(9)}  [${m.samples_ms.join(', ')}]`;
  });
  process.stdout.write(`forge-cli bench — node ${results.node} ${results.platform}\n`);
  process.stdout.write(`${head}\n${'-'.repeat(head.length)}\n${lines.join('\n')}\n`);
}
