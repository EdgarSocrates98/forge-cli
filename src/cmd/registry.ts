/**
 * `install --method registry` — instalação registry-first via PyPI.
 * Resolve names → catálogo, escolhe o melhor interpretador que satisfaz
 * `requires_python`, cria venv isolada por Forja e grava receipt.
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { confirm, isCancel } from '@clack/prompts';
import { log, note, outro, spinner } from '@clack/prompts';
import type { CliOptions } from '../cli-args.js';
import { exitCancelled } from '../prompts.js';
import { pythonCandidates } from '../preflight.js';
import { isSafeRepoName, redactSecrets, writeFileAtomic } from '../safety.js';
import { registryEntry, REGISTRY_PACKAGES } from '../registry/catalog.js';
import {
  forgeVenv,
  loadForgeState,
  registryInstall,
  registryUninstall,
  selectInterpreter,
  wheelCacheDir,
  type InstallError,
} from '../registry/install.js';
import { resolveRelease, type FetchLike, type ResolveError } from '../registry/pypi.js';
import { compareVersions, parseVersion, type ParsedVersion } from '../registry/versions.js';
import { S } from '../ui/strings.js';
import { icons, theme } from '../ui/theme.js';
import { commandOutput } from '../utils/system.js';
import { emitJson } from './shared.js';

export interface ProbedPython {
  exe: string[];
  version: string;
  parsed: ParsedVersion;
}

/** Prova todos os candidatos documentados; dedup por versão, mais novo primeiro. */
export async function probePythons(
  platform: NodeJS.Platform = process.platform,
  probe: (exe: string, args: string[]) => Promise<string | null> = commandOutput,
): Promise<ProbedPython[]> {
  const seen = new Set<string>();
  const out: ProbedPython[] = [];
  for (const c of pythonCandidates(platform)) {
    const raw = await probe(c.exe, [...c.args, '--version']);
    const m = raw?.match(/Python\s+(\d+\.\d+\.\d+(?:[a-z]+\d+)?)/);
    if (!m) continue;
    const parsed = parseVersion(m[1]);
    if (!parsed || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ exe: [c.exe, ...c.args], version: m[1], parsed });
  }
  out.sort((a, b) => compareVersions(b.parsed, a.parsed));
  return out;
}

function describeResolveError(e: ResolveError): string {
  switch (e.kind) {
    case 'not-found':
      return `dist ${e.dist} não existe no PyPI`;
    case 'version-not-found':
      return `${e.dist}==${e.requested} não existe — disponíveis: ${e.available.slice(-5).join(', ')}`;
    case 'python-incompatible':
      return `${e.dist} ${e.version} exige python ${e.requires} (detectado ${e.have})`;
    case 'specifier-unknown':
      return `${e.dist} ${e.version}: requires_python fora do subconjunto suportado (${e.requires})`;
    case 'offline-miss':
      return `${e.dist}: sem cache local e --offline ativo — rode online uma vez`;
    case 'malformed':
      return `${e.dist}: metadados fora do formato esperado (${e.detail})`;
    case 'network':
      return `rede/PyPI: ${e.detail}`;
  }
}

function describeInstallError(e: InstallError): string {
  if (e.stage === 'resolve') return describeResolveError(e.error);
  if (e.stage === 'offline-missing-artifact') return `${S.registryOfflineMissing}: ${e.detail}`;
  if (e.stage === 'hash-mismatch') return `${S.registryHashMismatch}: ${e.detail}`;
  if (e.stage === 'already-installed') return e.detail;
  return `${e.stage}: ${e.detail}`;
}

export function registryCacheDir(home = os.homedir()): string {
  return path.join(home, '.forge-cli', 'cache', 'pypi');
}

export interface RegistryInstallResult {
  forge: string;
  ok: boolean;
  detail: string;
  version?: string;
}

interface RegistryPlanItem {
  forge: string;
  ok: boolean;
  detail?: string;
  dist?: string;
  version?: string;
  requiresPython?: string;
  python?: string;
  venv?: string;
  wheels?: string;
  source?: string;
  staleCache?: boolean;
  yanked?: boolean;
}

// Flags do fluxo git sem efeito no método registry — avisadas, nunca mudas.
// `--plan`/`--check`/`--clean`/`--report` são honradas (plan mode / wipe /
// arquivo de relatório), não avisadas.
const REGISTRY_IGNORED_FLAGS: [keyof CliOptions, string][] = [
  ['dir', '--dir'],
  ['profile', '--profile'],
  ['scope', '--scope'],
  ['components', '--components'],
  ['host', '--host'],
  ['native', '--native'],
  ['skipVerify', '--skip-verify'],
  ['skipScripts', '--skip-scripts'],
  ['retryFailed', '--retry-failed'],
  ['shallow', '--shallow'],
  ['fix', '--fix'],
  ['rollback', '--rollback'],
  ['gatewayProfile', '--gateway-profile'],
  ['trustCustom', '--trust-custom'],
  ['runAfterSyncFailure', '--run-after-sync-failure'],
  ['onlyChanged', '--only-changed'],
  ['verbose', '--verbose'],
];

/** Flags do fluxo git sem efeito no método registry — nunca silencioso. */
export function ignoredRegistryFlags(cli: CliOptions): string[] {
  const out: string[] = [];
  for (const [key, label] of REGISTRY_IGNORED_FLAGS) {
    if (cli[key] === undefined || cli[key] === false) continue;
    out.push(label);
  }
  if (cli.timeoutSet) out.push('--timeout');
  if (cli.jobsSet) out.push('--jobs');
  return out;
}

/**
 * Contrato de saída do método registry:
 * - `--json` (sem --report) → JSON puro no stdout, logs humanos mudos.
 * - `--report <arq>` → documento no arquivo + saída humana (contrato do
 *   fluxo git) — a flag é honrada, nunca apenas "avisada como ignorada".
 */
function registryQuiet(cli: CliOptions): boolean {
  return cli.jsonReport && cli.reportPath === undefined;
}

function writeRegistryReport(reportPath: string, doc: unknown): void {
  const file = path.resolve(reportPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, redactSecrets(JSON.stringify(doc, null, 2)));
}

export async function runRegistryInstall(
  cli: CliOptions,
  names: string[],
  deps: { home?: string; pythons?: ProbedPython[]; fetchImpl?: FetchLike } = {},
): Promise<RegistryInstallResult[]> {
  const home = deps.home ?? os.homedir();
  const quiet = registryQuiet(cli);
  const reportTo = (doc: unknown) => {
    if (cli.reportPath !== undefined) writeRegistryReport(cli.reportPath, doc);
  };
  const entries = names.map((n) => ({ name: n, entry: registryEntry(n) }));
  const unknown = entries.filter((e) => !e.entry);
  // Alias de dist (`apiforge-af`) normaliza para o nome da Forja —
  // estado/venv/receipt sempre por `entry.name`.
  for (const e of entries) if (e.entry) e.name = e.entry.name;
  // Dedupe após normalização: `api-forge apiforge-af` é a mesma Forja —
  // sem dedupe o segundo alvo falharia com `already-installed` espúrio.
  const seen = new Set<string>();
  const deduped = entries.filter((e) => {
    const key = e.entry?.name ?? e.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unknown.length) {
    const msg = `${unknown.map((u) => u.name).join(', ')}: sem dist no catálogo registry — use o método git`;
    reportTo({ error: msg });
    if (quiet) emitJson({ error: msg }, 2);
    log.error(msg);
    process.exit(2);
  }

  const ignored = ignoredRegistryFlags(cli);
  const warnings: string[] = ignored.length
    ? [`${S.registryIgnoredFlags}: ${ignored.join(', ')}`]
    : [];
  if (warnings.length && !quiet) log.warn(warnings[0]);

  // Pin com 'v' prefixo (`--version v0.2.0`) — PyPI usa a chave sem 'v'.
  const pin = cli.ref?.replace(/^v(?=\d)/, '');

  const pythons = deps.pythons ?? (await probePythons());
  if (!pythons.length) {
    const msg = 'Nenhum interpretador Python detectado — instale Python ≥3.10';
    reportTo({ error: msg, warnings });
    if (quiet) emitJson({ error: msg, warnings }, 1);
    log.error(msg);
    process.exit(1);
  }
  if (!quiet) log.info(`Python detectado: ${pythons.map((p) => p.version).join(', ')}`);

  // `--plan`/`--check`: resolve e seleciona interpretador sem instalar —
  if (cli.plan || cli.check) {
    const planned: RegistryPlanItem[] = [];
    for (const { name, entry } of deduped) {
      const resolved = await resolveRelease(entry!.dist, {
        pin,
        offline: cli.offline,
        cacheDir: registryCacheDir(home),
        fetchImpl: deps.fetchImpl,
      });
      if ('kind' in resolved) {
        planned.push({ forge: name, ok: false, detail: describeResolveError(resolved) });
        continue;
      }
      const picked = selectInterpreter(entry!, resolved, pythons);
      if ('error' in picked) {
        planned.push({ forge: name, ok: false, detail: describeResolveError(picked.error) });
        continue;
      }
      planned.push({
        forge: name,
        ok: true,
        dist: entry!.dist,
        version: resolved.version,
        requiresPython: resolved.requiresPython,
        python: picked.python.version,
        venv: forgeVenv(home, name),
        wheels: wheelCacheDir(registryCacheDir(home), entry!.dist),
        source: resolved.source,
        staleCache: resolved.staleCache,
        yanked: resolved.yanked,
      });
    }
    const planDoc = { method: 'pypi', plan: true, planned, warnings };
    reportTo(planDoc);
    if (quiet) {
      emitJson(planDoc, planned.every((p) => p.ok) ? 0 : 1);
    }
    note(
      planned
        .map((p) =>
          p.ok
            ? `${p.forge} → ${p.dist}==${p.version} (python ${p.python}, venv ${p.venv})`
            : `${p.forge} → falhou: ${p.detail}`,
        )
        .join('\n'),
      // venv/receipt/state não são escritos; o cache de metadados do
      // PyPI pode ser atualizado (mesma regra de `update --check`).
      'Plano (venv e estado não alterados)',
    );
    if (planned.some((p) => !p.ok)) process.exit(1);
    outro(`${icons.ok} plano resolvido — execute sem --plan para instalar`);
    return planned.map((p) => ({
      forge: p.forge,
      ok: p.ok,
      detail: p.ok ? 'planned' : (p.detail ?? 'falhou'),
      version: p.version,
    }));
  }

  // Plano → confirmação → instalação: mesmo contrato do fluxo git
  // (`confirmRun`) — só quando interativo. `--json`/`--yes`/pipes
  // não perguntam (contrato para máquinas).
  if (!quiet && !cli.yes && process.stdout.isTTY && process.stdin.isTTY) {
    // Resolve agora para mostrar a versão exata no plano de confirmação;
    // o install re-resolve via cache (TTL) — não é rede duplicada.
    const lines: string[] = [];
    for (const { name, entry } of deduped) {
      const r = await resolveRelease(entry!.dist, {
        pin,
        offline: cli.offline,
        cacheDir: registryCacheDir(home),
        fetchImpl: deps.fetchImpl,
      });
      lines.push(
        'kind' in r
          ? `${name} → ${entry!.dist} (${describeResolveError(r)})`
          : `${name} → ${r.dist}==${r.version} (venv isolada em ${forgeVenv(home, name)})`,
      );
    }
    note(lines.join('\n'), 'Instalação registry-first');
    const answer = await confirm({ message: S.confirmRun });
    if (isCancel(answer) || !answer) {
      if (isCancel(answer)) exitCancelled();
      log.warn('Nada foi instalado.');
      process.exit(0);
      return [];
    }
  }

  const results: RegistryInstallResult[] = [];
  for (const { name, entry } of deduped) {
    const spin = spinner();
    if (!quiet) spin.start(`${name}: resolvendo ${entry!.dist}…`);
    const receipt = await registryInstall(entry!, pin, {
      home,
      cacheDir: registryCacheDir(home),
      offline: cli.offline,
      pythons,
      clean: cli.clean,
      fetchImpl: deps.fetchImpl,
    });
    if ('stage' in receipt) {
      if (!quiet) spin.stop(`${name}: ${theme.err('falhou')}`);
      results.push({ forge: name, ok: false, detail: describeInstallError(receipt) });
      continue;
    }
    if (receipt.staleCache) {
      const w = `${S.registryStaleCache} (${entry!.dist})`;
      warnings.push(w);
      if (!quiet) log.warn(w);
    }
    if (!quiet) {
      spin.stop(
        `${name}: ${theme.ok('instalado')} ${theme.dim(`${receipt.dist}==${receipt.version}`)}`,
      );
    }
    results.push({
      forge: name,
      ok: true,
      version: receipt.version,
      detail: `${receipt.dist}==${receipt.version} em ${receipt.venv}`,
    });
  }

  const doc = { method: 'pypi', results, warnings };
  reportTo(doc);
  if (cli.reportPath !== undefined) {
    log.info(`${S.reportSaved}: ${theme.dim(path.resolve(cli.reportPath))}`);
  }
  if (quiet) {
    emitJson(doc, results.every((r) => r.ok) ? 0 : 1);
  }
  for (const r of results) {
    if (!r.ok) log.error(`${r.forge}: ${r.detail}`);
  }
  if (results.some((r) => !r.ok)) process.exit(1);
  const bins = results.map((r) => {
    const inst = loadForgeState(home).forges[r.forge];
    return inst ? `${r.forge} → ${inst.bin}` : '';
  });
  note(bins.filter(Boolean).join('\n'), 'Para usar, adicione ao PATH ou invoque o caminho');
  outro(`${icons.ok} instalação registry-first concluída`);
  return results;
}

export function runRegistryList(
  cli: CliOptions,
  deps: { home?: string; names?: string[] } = {},
): void {
  const home = deps.home ?? os.homedir();
  const state = loadForgeState(home);
  // Aceita nome da Forja ou da dist; normaliza para `entry.name`.
  const wanted = deps.names?.length
    ? new Set(deps.names.map((n) => registryEntry(n)?.name).filter((n): n is string => Boolean(n)))
    : null;
  if (deps.names?.length) {
    const bad = deps.names.filter((n) => !registryEntry(n));
    if (bad.length) {
      const msg = `${bad.join(', ')}: fora do catálogo registry`;
      if (cli.reportPath !== undefined) writeRegistryReport(cli.reportPath, { error: msg });
      if (registryQuiet(cli)) emitJson({ error: msg }, 2);
      log.error(msg);
      process.exit(2);
    }
  }
  const rows = REGISTRY_PACKAGES.filter((e) => !wanted || wanted.has(e.name)).map((e) => {
    const inst = state.forges[e.name];
    const binOk = inst ? typeof inst.bin === 'string' && existsSync(inst.bin) : null;
    return {
      forge: e.name,
      dist: e.dist,
      installed: inst?.version ?? null,
      method: inst?.method ?? null,
      verifyOk: inst ? (inst.verify?.ok ?? null) : null,
      binPresent: binOk,
      bin: inst ? (binOk ? inst.bin : `${inst.bin ?? '?'} (ausente)`) : null,
      minPython: e.minPython,
    };
  });
  if (cli.reportPath !== undefined) writeRegistryReport(cli.reportPath, { forges: rows });
  if (registryQuiet(cli)) emitJson({ forges: rows });
  note(
    rows
      .map(
        (r) =>
          `${r.installed ? icons.ok : '·'} ${r.forge.padEnd(20)} ${r.dist.padEnd(20)} ${(r.installed ?? '—') + (r.installed && r.verifyOk === false ? ` ${S.registryVerifyFailed}` : '')}`,
      )
      .join('\n'),
    'Forjas (registry)',
  );
}

export function resolveRegistryTargets(
  cli: Pick<CliOptions, 'only' | 'all'>,
  names: string[],
  installed: string[],
): string[] {
  if (names.length) return names;
  if (cli.only?.length) return cli.only;
  if (cli.all) return installed;
  return [];
}

export async function runRegistryUninstall(
  cli: CliOptions,
  names: string[],
  deps: { home?: string } = {},
): Promise<void> {
  const home = deps.home ?? os.homedir();
  const quiet = registryQuiet(cli);
  const reportTo = (doc: unknown) => {
    if (cli.reportPath !== undefined) writeRegistryReport(cli.reportPath, doc);
  };
  const state = loadForgeState(home).forges;
  const installed = Object.keys(state);
  const targets = resolveRegistryTargets(cli, names, installed);
  if (!targets.length) {
    reportTo({ error: S.errRegistryUninstallNeedsNames });
    if (quiet) emitJson({ error: S.errRegistryUninstallNeedsNames }, 2);
    log.error(S.errRegistryUninstallNeedsNames);
    process.exit(2);
  }

  const ignored = ignoredRegistryFlags(cli);
  const warnings: string[] = ignored.length
    ? [`${S.registryIgnoredFlags}: ${ignored.join(', ')}`]
    : [];
  if (warnings.length && !quiet) log.warn(warnings[0]);

  // Alias de dist normalizado; duplicatas nome+alias planejam uma só vez.
  // Fora do catálogo mas presente no state → ainda desinstalável (uma
  // entrada removida do catálogo não pode travar a remoção). Chaves do
  // state são dado não confiável: nome inseguro (path traversal) é
  // recusa nomeada — nunca chega ao rmSync.
  const plan: { name: string; dist?: string; known: boolean; installed: boolean }[] = [];
  const unsafe: string[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const entry = registryEntry(raw);
    const name = entry?.name ?? raw;
    if (!isSafeRepoName(name)) {
      unsafe.push(raw);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    // `state` é dado não confiável: own-property apenas — nomes como
    // 'constructor' não podem casar membros do Object.prototype.
    const receipt = Object.hasOwn(state, name) ? state[name] : undefined;
    plan.push({
      name,
      dist: entry?.dist ?? receipt?.dist,
      known: Boolean(entry ?? receipt),
      installed: installed.includes(name),
    });
  }
  const unknown = [...plan.filter((p) => !p.known).map((p) => p.name), ...unsafe];
  const errText = [
    ...plan.filter((p) => !p.known).map((p) => `${p.name}: sem dist no catálogo registry`),
    ...unsafe.map((u) => `${u}: nome inseguro no state — recusado (path traversal)`),
  ].join(' | ');
  const removals = plan.filter((p) => p.installed);
  const skipped = plan.filter((p) => p.known && !p.installed).map((p) => p.name);
  warnings.push(...skipped.map((n) => `${n}: não estava instalado via registry — ignorado`));
  if (!quiet) {
    for (const u of plan.filter((p) => !p.known).map((p) => p.name))
      log.error(`${u}: sem dist no catálogo registry`);
    for (const u of unsafe) log.error(`${u}: nome inseguro no state — recusado (path traversal)`);
    for (const w of warnings.slice(ignored.length ? 1 : 0)) log.warn(w);
  }
  if (!removals.length) {
    const doc = {
      method: 'pypi',
      removed: [],
      skipped,
      warnings,
      ...(errText ? { error: errText } : {}),
    };
    reportTo(doc);
    if (quiet) emitJson(doc, unknown.length ? 2 : 0);
    if (unknown.length) process.exit(2);
    log.info('Nada a remover.');
    return;
  }

  if (!quiet) {
    note(
      removals
        .map((r) => `${r.name} → ${r.dist ?? '?'} (venv + wheel cache + receipt em ~/.forge-cli/)`)
        .join('\n'),
      S.registryUninstallConfirm,
    );
  }
  if (!cli.yes) {
    const needYesDoc = {
      error: S.registryUninstallNeedsYes,
      planned: removals.map((r) => r.name),
      skipped,
      warnings,
    };
    if (quiet) {
      emitJson(needYesDoc, 2);
    }
    // Não-interativo sem --yes nunca trava em prompt — recusa limpa,
    // mesmo contrato do fluxo git (manage.ts).
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      reportTo(needYesDoc);
      log.warn(S.registryUninstallNeedsYes);
      process.exit(0);
      return;
    }
    const answer = await confirm({ message: S.registryUninstallConfirm });
    if (isCancel(answer) || !answer) {
      if (isCancel(answer)) exitCancelled();
      reportTo(needYesDoc);
      log.warn(S.registryUninstallNeedsYes);
      process.exit(0);
      return;
    }
  }

  const results = removals.map((r) => {
    const res = registryUninstall({ name: r.name, dist: r.dist }, { home });
    if (res.refused) log.error(`${r.name}: recusado — ${res.refused}`);
    return { forge: r.name, removed: res.removed, cacheRemoved: res.cacheRemoved };
  });
  const doc = {
    method: 'pypi',
    results,
    skipped,
    warnings,
    ...(errText ? { error: errText } : {}),
  };
  reportTo(doc);
  if (quiet) emitJson(doc, unknown.length ? 2 : 0);
  for (const r of results) {
    if (r.removed) log.success(`${r.forge}: removido`);
  }
  // Nomes desconhecidos são falha nos dois modos — mesmo contrato que --json.
  if (unknown.length) process.exit(2);
}
