/**
 * §6.5 — predictive compatibility. Deterministic rules only.
 *
 * Every Prediction carries evidence[] + version{from,to} + certainty and is
 * emitted only when real evidence exists — an absent floor, a missing
 * schema or an unprobed runtime produce silence, never a guess.
 *
 * Rules (all local, no network):
 *  - schema-change:    forge.json `schema` vs the known contract ids, plus
 *                      re-validation of the manifest against what it declares
 *  - breaking-change:  analyzeBumps/classifyBump over semver refs declared
 *                      in forge.json (version), env.lock.json (head) and
 *                      state.json (pins)
 *  - runtime-incompat: prereqs.ts checks (engines/requires-python) plus the
 *                      manifest `python` floor vs the detected interpreter
 *  - host-version:     manifest `min_host_versions` floor vs the adapter's
 *                      detected version — no floor declared, no finding
 *  - renamed-var /     envintel schema vs .env keys — keys absent from the
 *    obsolete:         schema with a similar declared key → renamed-var,
 *                      without one → obsolete (key names only, never values)
 *  - install-conflict: two repos claiming the same MCP server key or the
 *                      same managed bin path (cli / mcp_command[0] / package)
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { artifactsRoot, loadState } from '../artifacts.js';
import { CONTRACT_IDS, contractValidator } from '../contracts/index.js';
import { analyzeEnv } from '../envintel/validate.js';
import { hostAdapters } from '../hosts/index.js';
import type { HostAdapter, HostDetection } from '../hosts/types.js';
import { analyzeBumps, type EnvLock } from '../maintenance.js';
import { pythonInfo } from '../preflight.js';
import { checkRepoPrereqs, compareVersions, satisfiesVersion } from '../prereqs.js';
import { redactSecrets, resolveInside } from '../safety.js';
import type { ForgeRepo } from '../types.js';
import type { Certainty, Evidence, Prediction } from './contracts.js';

export interface PredictOptions {
  /** Home dir for host adapters (default: os.homedir()). */
  home?: string;
  /** Host adapters — tests inject hostAdapters(fakeProbe). */
  adapters?: readonly HostAdapter[];
}

const MAX_MANIFEST_BYTES = 64 * 1024;
const SEMVERISH = /^v?\d+\.\d+\.\d+/;

const ev = (source: string, fact: string): Evidence => ({
  source,
  fact: redactSecrets(fact),
});

/** Code-unit compare — identical order on every machine (localeCompare isn't). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const mk = (
  id: string,
  kind: Prediction['kind'],
  subject: string,
  certainty: Certainty,
  version: { from: string | null; to: string | null },
  evidence: readonly Evidence[],
  explanation: string,
): Prediction => ({ id, kind, subject, certainty, version, evidence, explanation });

function readManifest(repoDir: string): Record<string, unknown> | null {
  const file = path.join(repoDir, 'forge.json');
  try {
    if (!existsSync(file) || statSync(file).size > MAX_MANIFEST_BYTES) return null;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// schema-change — declared contract id vs known contracts + self-validation.
// ---------------------------------------------------------------------------

function schemaChange(repoName: string, m: Record<string, unknown>): Prediction[] {
  if (typeof m.schema !== 'string' || !m.schema) return [];
  const src = `${repoName}/forge.json`;
  if (!CONTRACT_IDS.includes(m.schema)) {
    return [
      mk(
        `schema-change:${repoName}:${m.schema}`,
        'schema-change',
        repoName,
        'high',
        { from: m.schema, to: null },
        [
          ev(src, `declara schema=${m.schema}`),
          ev('contracts', `${CONTRACT_IDS.length} contratos conhecidos`),
        ],
        `o manifesto declara um contrato fora do conjunto forge/<Name>/v1 conhecido`,
      ),
    ];
  }
  const errors = contractValidator().validate(m.schema, m);
  if (!errors.length) return [];
  return [
    mk(
      `schema-change:${repoName}:${m.schema}`,
      'schema-change',
      repoName,
      'high',
      { from: m.schema, to: m.schema },
      [
        ev(src, `declara schema=${m.schema}`),
        ...errors.slice(0, 5).map((e) => ev('validator', `${e.code} ${e.path} — ${e.message}`)),
      ],
      `o manifesto declara ${m.schema} mas ${errors.length} campo(s) não validam`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// breaking-change — semver refs declared in manifest / lockfile / pins.
// ---------------------------------------------------------------------------

function declaredRefs(
  targetDir: string,
  repoName: string,
  m: Record<string, unknown> | null,
): { value: string; source: string }[] {
  const refs: { value: string; source: string }[] = [];
  if (typeof m?.version === 'string' && SEMVERISH.test(m.version)) {
    refs.push({ value: m.version, source: `${repoName}/forge.json version` });
  }
  try {
    const lock = JSON.parse(
      readFileSync(path.join(artifactsRoot(targetDir), 'env.lock.json'), 'utf8'),
    ) as EnvLock;
    const head = lock?.forges?.[repoName]?.head;
    if (typeof head === 'string' && SEMVERISH.test(head)) {
      refs.push({ value: head, source: '.forge-cli/env.lock.json head' });
    }
  } catch {
    /* sem lockfile — nada declarado */
  }
  const pin = loadState(targetDir)?.pins?.[repoName];
  if (typeof pin === 'string' && SEMVERISH.test(pin)) {
    refs.push({ value: pin, source: '.forge-cli/state.json pins' });
  }
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.value) ? false : (seen.add(r.value), true)));
}

function breakingChange(
  repoName: string,
  refs: readonly { value: string; source: string }[],
): Prediction[] {
  const out: Prediction[] = [];
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      const a = refs[i];
      const b = refs[j];
      const [from, to] = compareVersions(a.value, b.value) < 0 ? [a, b] : [b, a];
      const bump = analyzeBumps(from.value, [to.value])[0];
      if (!bump?.breaking_suspect) continue;
      out.push(
        mk(
          `breaking-change:${repoName}:${from.value}->${to.value}`,
          'breaking-change',
          repoName,
          'high',
          { from: from.value, to: to.value },
          [
            ev(from.source, `declara ${from.value}`),
            ev(to.source, `declara ${to.value}`),
            ev('classifyBump', `${bump.level} bump`),
          ],
          `salto de versão major declarado entre ${from.value} e ${to.value}`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// runtime-incompat — prereqs.ts checks + manifest `python` floor.
// ---------------------------------------------------------------------------

const PREREQ_NAME_RE = /^(Python|Node|npm|pip|venv)\s*(.*)$/;
const VERSIONISH = /v?\d+\.\d+(?:\.\d+)*/;

async function runtimeIncompat(
  repoName: string,
  dir: string,
  m: Record<string, unknown> | null,
): Promise<Prediction[]> {
  const out: Prediction[] = [];
  for (const check of await checkRepoPrereqs(dir)) {
    if (check.ok) continue;
    const name = PREREQ_NAME_RE.exec(check.name);
    const spec = name?.[2]?.trim() || null;
    const found = VERSIONISH.exec(check.detail)?.[0] ?? null;
    out.push(
      mk(
        `runtime-incompat:${repoName}:${check.name}`,
        'runtime-incompat',
        `${repoName} · ${check.name}`,
        'high',
        { from: found, to: spec },
        [
          ev('checkRepoPrereqs', `${check.name}: ${check.detail}`),
          ev(`${repoName}`, 'pyproject.toml/package.json declara o pré-requisito'),
        ],
        `pré-requisito declarado não atendido pelo runtime detectado`,
      ),
    );
  }
  const floor = typeof m?.python === 'string' ? m.python.trim() : '';
  if (floor) {
    const py = await pythonInfo();
    if (!py) {
      out.push(
        mk(
          `runtime-incompat:${repoName}:python`,
          'runtime-incompat',
          `${repoName} · python ${floor}`,
          'medium',
          { from: null, to: floor },
          [
            ev(`${repoName}/forge.json`, `python=${floor}`),
            ev('pythonInfo', 'nenhum interpretador Python detectado'),
          ],
          `o manifesto exige python ${floor} e nenhum interpretador respondeu ao probe`,
        ),
      );
    } else if (!satisfiesVersion(py.version, floor)) {
      out.push(
        mk(
          `runtime-incompat:${repoName}:python`,
          'runtime-incompat',
          `${repoName} · python ${floor}`,
          'high',
          { from: py.version, to: floor },
          [
            ev(`${repoName}/forge.json`, `python=${floor}`),
            ev(`probe:${py.exe}`, `detectado ${py.version}`),
          ],
          `o interpretador detectado não satisfaz o piso declarado no manifesto`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// host-version — manifest min_host_versions floor vs detected adapter version.
// ---------------------------------------------------------------------------

async function hostVersion(
  repos: readonly ForgeRepo[],
  manifests: Map<string, Record<string, unknown> | null>,
  opts: PredictOptions,
): Promise<Prediction[]> {
  const floors = new Map<string, { spec: string; source: string }>();
  for (const repo of repos) {
    const raw = manifests.get(repo.name)?.min_host_versions;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    for (const [host, spec] of Object.entries(raw)) {
      const norm = host.trim().toLowerCase();
      if (typeof spec !== 'string' || !spec.trim() || !norm) continue;
      const key = norm;
      const prev = floors.get(key);
      // strongest declared floor wins (highest required version)
      if (!prev || compareVersions(spec.trim(), prev.spec) > 0) {
        floors.set(key, { spec: spec.trim(), source: `${repo.name}/forge.json` });
      }
    }
  }
  if (!floors.size) return [];

  const adapters = opts.adapters ?? hostAdapters();
  const detections = new Map<string, HostDetection>();
  for (const adapter of adapters) {
    try {
      detections.set(adapter.id, await adapter.detect(opts.home));
    } catch {
      /* probe falhou — sem evidência, sem finding */
    }
  }
  const out: Prediction[] = [];
  for (const [host, floor] of [...floors.entries()].sort(([a], [b]) => cmp(a, b))) {
    const d = detections.get(host);
    if (!d?.found || d.version == null) continue;
    if (satisfiesVersion(d.version, floor.spec)) continue;
    out.push(
      mk(
        `host-version:${host}`,
        'host-version',
        host,
        'high',
        { from: d.version, to: floor.spec },
        [
          ev(floor.source, `min_host_versions.${host}=${floor.spec}`),
          ev(`host:${host}`, `detectado ${d.version} (state=${d.state})`),
        ],
        `host ${host} detectado abaixo do piso declarado pelo manifesto`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// renamed-var / obsolete — schema keys vs .env keys (names only, never values).
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  const cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

/** Similarity in [0,1] — best of raw and separator-free comparison. */
function keySimilarity(a: string, b: string): number {
  const score = (x: string, y: string) => 1 - levenshtein(x, y) / Math.max(x.length, y.length, 1);
  const squash = (s: string) => s.replace(/[_-]/g, '');
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return Math.max(score(la, lb), score(squash(la), squash(lb)));
}

const RENAME_HINT = 0.7;

function envVarFindings(label: string, dir: string, envKeys?: readonly string[]): Prediction[] {
  const analysis = analyzeEnv(dir, envKeys);
  if (!analysis.schema.vars.length || !analysis.obsolete.length) return [];
  const schemaKeys = analysis.schema.vars.map((v) => v.key);
  const out: Prediction[] = [];
  for (const key of [...analysis.obsolete].sort()) {
    const hint = schemaKeys
      .map((k) => ({ key: k, score: keySimilarity(key, k) }))
      .sort((a, b) => b.score - a.score || cmp(a.key, b.key))[0];
    const source = `${label}/.env`;
    if (hint && hint.score >= RENAME_HINT) {
      out.push(
        mk(
          `renamed-var:${label}:${key}`,
          'renamed-var',
          `${label} · ${key}`,
          'medium',
          { from: key, to: hint.key },
          [
            ev(source, `chave ${key} presente mas fora do schema (${schemaKeys.length} vars)`),
            ev('envintel/schema', `candidata: ${hint.key} (similaridade ${hint.score.toFixed(2)})`),
          ],
          `a chave ${key} não consta no schema e se assemelha a ${hint.key} — possível renomeação`,
        ),
      );
    } else {
      out.push(
        mk(
          `obsolete:${label}:${key}`,
          'obsolete',
          `${label} · ${key}`,
          'medium',
          { from: key, to: null },
          [ev(source, `chave ${key} presente mas fora do schema (${schemaKeys.length} vars)`)],
          `a chave ${key} não consta em nenhum schema declarado — candidata a remoção`,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// install-conflict — same claimed MCP key or managed bin path across repos.
// ---------------------------------------------------------------------------

interface Claim {
  kind: 'mcp-key' | 'cli' | 'mcp-command' | 'package';
  value: string;
  repo: string;
  source: string;
}

function claims(repo: ForgeRepo, m: Record<string, unknown> | null): Claim[] {
  const out: Claim[] = [];
  const src = `${repo.name}/forge.json`;
  const forgeId = typeof m?.forge_id === 'string' ? m.forge_id : repo.name;
  const mcpCommand = Array.isArray(m?.mcp_command)
    ? m.mcp_command.filter((t): t is string => typeof t === 'string')
    : [];
  const serverName = typeof m?.mcp_server_name === 'string' ? m.mcp_server_name : null;
  // The key a host merge writes to mcpServers[…] (src/hosts merge logic).
  if (serverName || mcpCommand.length) {
    out.push({ kind: 'mcp-key', value: serverName ?? forgeId, repo: repo.name, source: src });
  }
  if (typeof m?.cli === 'string' && m.cli) {
    out.push({ kind: 'cli', value: m.cli, repo: repo.name, source: src });
  }
  if (mcpCommand[0]) {
    out.push({ kind: 'mcp-command', value: mcpCommand[0], repo: repo.name, source: src });
  }
  if (typeof m?.package === 'string' && m.package) {
    out.push({ kind: 'package', value: m.package, repo: repo.name, source: src });
  }
  return out.filter((c) => redactSecrets(c.value) === c.value);
}

function installConflict(all: Claim[]): Prediction[] {
  const groups = new Map<string, Claim[]>();
  for (const c of all) {
    const key = `${c.kind}|${c.value}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const out: Prediction[] = [];
  for (const [key, list] of [...groups.entries()].sort(([a], [b]) => cmp(a, b))) {
    const repos = [...new Set(list.map((c) => c.repo))].sort();
    if (repos.length < 2) continue;
    const sep = key.indexOf('|');
    const kind = key.slice(0, sep);
    const value = key.slice(sep + 1);
    out.push(
      mk(
        `install-conflict:${kind}:${value}`,
        'install-conflict',
        `${repos.join(' + ')} · ${value}`,
        'high',
        { from: null, to: null },
        list.map((c) => ev(c.source, `${c.repo} declara ${c.kind}=${c.value}`)),
        kind === 'mcp-key'
          ? `duas Forjas registrariam a mesma chave em mcpServers — a segunda viraria 'duplicate'`
          : `duas Forjas gerenciam o mesmo caminho gerenciável (${kind}=${value})`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// §6.5 — the predictor
// ---------------------------------------------------------------------------

export async function predictCompatibility(
  targetDir: string,
  repos: readonly ForgeRepo[],
  opts: PredictOptions = {},
): Promise<Prediction[]> {
  const sorted = [...repos].sort((a, b) => cmp(a.name, b.name));
  const out: Prediction[] = [];
  const manifests = new Map<string, Record<string, unknown> | null>();
  const allClaims: Claim[] = [];

  for (const repo of sorted) {
    const dir = resolveInside(targetDir, repo.name);
    if (!dir || !existsSync(dir)) continue;
    const m = readManifest(dir);
    manifests.set(repo.name, m);
    if (m) out.push(...schemaChange(repo.name, m));
    out.push(...breakingChange(repo.name, declaredRefs(targetDir, repo.name, m)));
    out.push(...(await runtimeIncompat(repo.name, dir, m)));
    allClaims.push(...claims(repo, m));
  }
  out.push(...(await hostVersion(sorted, manifests, opts)));

  // env vars: workspace root (no catalog envKeys) + every existing repo dir.
  out.push(...envVarFindings('<workspace>', targetDir));
  for (const repo of sorted) {
    const dir = resolveInside(targetDir, repo.name);
    if (!dir || !existsSync(dir)) continue;
    out.push(...envVarFindings(repo.name, dir, repo.envKeys));
  }

  out.push(...installConflict(allClaims));

  return out.sort((a, b) => cmp(a.id, b.id));
}
