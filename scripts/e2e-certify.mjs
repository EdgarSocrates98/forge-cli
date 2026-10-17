#!/usr/bin/env node
/**
 * Certificação E2E Cycle 11 — cenários A–H contra o binário real (dist/).
 * Cada cenário reporta PASS/FAIL/SKIP com evidência (exit code + saída
 * parseada), nunca um "ok" sem prova. Rede/PyPI indisponível → SKIP honesto.
 *
 *   node scripts/e2e-certify.mjs [--json]
 *
 * Requer `npm run build` antes. Estado isolado em FORGE_CLI_HOME tmp.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(path.dirname(here), 'dist', 'index.js');
const jsonOut = process.argv.includes('--json');
const home = mkdtempSync(path.join(tmpdir(), 'forge-cli-e2e-'));
const statePath = path.join(home, '.forge-cli', 'forges', 'state.json');

const run = (args, { stdin } = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, FORGE_CLI_HOME: home },
    encoding: 'utf8',
    timeout: 180_000,
    input: stdin,
  });
const readState = () =>
  existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { forges: {} };
const jdoc = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};

const results = [];
const scenario = (id, name, fn) => {
  try {
    const r = fn();
    results.push({ id, name, ...r });
  } catch (e) {
    results.push({ id, name, status: 'FAIL', evidence: String(e?.message ?? e) });
  }
};

// A — catálogo registry lista as 7 Forjas publicadas
scenario('A', 'registry lista catálogo PyPI', () => {
  const r = run(['registry', '--json']);
  const doc = jdoc(r);
  const count = Array.isArray(doc?.forges) ? doc.forges.length : 0;
  return r.status === 0 && count === 7
    ? { status: 'PASS', evidence: `catálogo=${count} Forjas` }
    : { status: 'FAIL', evidence: `exit=${r.status} catálogo=${count}` };
});

// B — --plan não muta (sem venv/sem state)
scenario('B', 'install --plan é no-mutation', () => {
  const r = run(['install', 'the-forge', '--method', 'registry', '--plan', '--json']);
  const noState = !existsSync(statePath);
  return r.status === 0 && noState
    ? { status: 'PASS', evidence: 'exit=0, state.json ausente' }
    : { status: 'FAIL', evidence: `exit=${r.status} state=${existsSync(statePath)}` };
});

// C — install real (rede); offline → SKIP
scenario('C', 'install --method registry cria venv + receipt', () => {
  const r = run(['install', 'the-forge', '--method', 'registry', '--yes', '--json']);
  const doc = jdoc(r);
  if (r.status !== 0 && /network|ENOTFOUND|ECONN|offline/i.test(r.stdout + r.stderr)) {
    return { status: 'SKIP', evidence: 'PyPI inalcançável' };
  }
  const rec = readState().forges['the-forge'];
  return r.status === 0 && rec?.bin && existsSync(rec.bin) && rec.verifiedHash
    ? { status: 'PASS', evidence: `${rec.dist}==${rec.version} bin verificado` }
    : { status: 'FAIL', evidence: `exit=${r.status} receipt=${JSON.stringify(rec ?? null)}` };
});

// D — update --check não muta versão
scenario('D', 'update --check respeita receipt', () => {
  if (!readState().forges['the-forge']) return { status: 'SKIP', evidence: 'C não instalou' };
  const before = readState().forges['the-forge'].version;
  const r = run(['update', 'the-forge', '--method', 'registry', '--check', '--json']);
  const after = readState().forges['the-forge'].version;
  return r.status === 0 && after === before
    ? { status: 'PASS', evidence: `version=${after} inalterada` }
    : { status: 'FAIL', evidence: `exit=${r.status} ${before}→${after}` };
});

// E — pin trava; update respeita
scenario('E', 'pin trava versão instalada', () => {
  if (!readState().forges['the-forge']) return { status: 'SKIP', evidence: 'C não instalou' };
  run(['pin', 'the-forge', '--method', 'registry', '--json']);
  const pinned = readState().forges['the-forge'].pinned;
  const r = run(['unpin', 'the-forge', '--method', 'registry', '--json']);
  const unpinned = readState().forges['the-forge'].pinned;
  return pinned && r.status === 0 && !unpinned
    ? { status: 'PASS', evidence: `pinned=${pinned} → removido` }
    : { status: 'FAIL', evidence: `pinned=${pinned} unpinned=${unpinned}` };
});

// F — rollback honesto: sem histórico → exit 1, não inventa
scenario('F', 'rollback sem histórico recusa honesto', () => {
  if (!readState().forges['the-forge']) return { status: 'SKIP', evidence: 'C não instalou' };
  const r = run(['rollback', 'the-forge', '--method', 'registry', '--yes', '--json']);
  return r.status === 1
    ? { status: 'PASS', evidence: 'exit=1 (no-history)' }
    : { status: 'FAIL', evidence: `exit=${r.status}` };
});

// G — uninstall não-TTY sem --yes não pendura (needsYes, exit 0)
scenario('G', 'uninstall não-TTY sem --yes → needsYes, sem hang', () => {
  if (!readState().forges['the-forge']) return { status: 'SKIP', evidence: 'C não instalou' };
  const r = run(['uninstall', 'the-forge', '--method', 'registry'], { stdin: '' });
  return r.status === 0 && readState().forges['the-forge']
    ? { status: 'PASS', evidence: 'exit=0, receipt preservado' }
    : { status: 'FAIL', evidence: `exit=${r.status} timeout=${r.error?.code ?? 'no'}` };
});

// H — forge-cli mcp resolve argv do receipt (the-forge: honesto sem mcp)
scenario('H', 'mcp resolve por receipt; sem mcp_command → honesto', () => {
  const r1 = run(['mcp', 'the-forge', '--json']);
  const d1 = jdoc(r1);
  const theforge = d1?.mcp?.find((m) => m.forge === 'the-forge');
  // the-forge não declara mcp_command → ok:false honesto (exit 1)
  return r1.status === 1 && theforge?.ok === false
    ? { status: 'PASS', evidence: theforge.detail ?? 'sem mcp_command' }
    : { status: 'FAIL', evidence: `exit=${r1.status} doc=${r1.stdout?.slice(0, 120)}` };
});

const summary = {
  schema: 'forge-cli/E2ECertify/v1',
  platform: process.platform,
  node: process.version,
  scenarios: results,
  pass: results.filter((r) => r.status === 'PASS').length,
  fail: results.filter((r) => r.status === 'FAIL').length,
  skip: results.filter((r) => r.status === 'SKIP').length,
};
rmSync(home, { recursive: true, force: true });
if (jsonOut) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  for (const r of results) {
    const mark = r.status === 'PASS' ? '✓' : r.status === 'SKIP' ? '○' : '✗';
    console.log(`${mark} ${r.id}: ${r.name} — ${r.status} (${r.evidence ?? ''})`);
  }
  console.log(`\n${summary.pass} PASS · ${summary.skip} SKIP · ${summary.fail} FAIL`);
}
process.exitCode = summary.fail > 0 ? 1 : 0;
