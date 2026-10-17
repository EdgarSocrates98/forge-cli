/**
 * `install --method registry` — instalação registry-first via PyPI.
 * Resolve names → catálogo, escolhe o melhor interpretador que satisfaz
 * `requires_python`, cria venv isolada por Forja e grava receipt.
 */
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { confirm, isCancel } from '@clack/prompts';
import { log, note, outro, spinner } from '@clack/prompts';
import type { CliOptions } from '../cli-args.js';
import { exitCancelled } from '../prompts.js';
import { pythonCandidates } from '../preflight.js';
import { isSafeRepoName, redactSecrets, writeFileAtomic } from '../safety.js';
import { registryEntry, REGISTRY_PACKAGES, type RegistryEntry } from '../registry/catalog.js';
import {
  execaRun,
  forgeVenv,
  ghostEntry,
  loadForgeState,
  receiptPath,
  registryInstall,
  registryUninstall,
  saveForgeState,
  selectInterpreter,
  wheelCacheDir,
  type InstallError,
  type RegistryInstallReceipt,
  type RunLike,
} from '../registry/install.js';
import {
  buildNativeInstall,
  buildNativeOp,
  hasNativeRequest,
  validateNativeOptions,
} from '../native-install.js';
import { FORGE_REPOS } from '../constants/repos.js';
import { resolveRelease, type FetchLike, type ResolveError } from '../registry/pypi.js';
import { compareVersions, parseVersion, type ParsedVersion } from '../registry/versions.js';
import { S } from '../ui/strings.js';
import { icons, theme } from '../ui/theme.js';
import { cliHome, commandOutput } from '../utils/system.js';
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

export function registryCacheDir(home = cliHome()): string {
  return path.join(home, '.forge-cli', 'cache', 'pypi');
}

export interface RegistryInstallResult {
  forge: string;
  ok: boolean;
  detail: string;
  native?: RegistryInstallReceipt['native'];
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
  // --profile/--scope/--components/--host/--gateway-profile/--native são
  // honrados via delegação ao instalador nativo da Forja (fase 2).
  ['skipVerify', '--skip-verify'],
  ['skipScripts', '--skip-scripts'],
  ['retryFailed', '--retry-failed'],
  ['shallow', '--shallow'],
  ['fix', '--fix'],
  ['rollback', '--rollback'],
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

/** Valida as flags nativas antes de qualquer instalação — erro nomeado, não warning. */
export function validateRegistryNativeFlags(cli: CliOptions): string | null {
  return validateNativeOptions({
    profile: cli.profile,
    scope: cli.scope,
    components: cli.components,
    host: cli.host,
    gatewayProfile: cli.gatewayProfile,
  });
}

/**
 * Delegação ao instalador nativo da Forja (fase 2). Roda o bin da venv
 * verificada — nunca um shim global. `{python} scripts/...` aponta para o
 * repositório, que não existe no método registry → skip honesto com razão.
 * Sem aprovação (`--yes`) o instalador roda `--dry-run` (default-deny).
 */
export async function delegateNative(
  cli: CliOptions,
  entry: RegistryEntry,
  receipt: RegistryInstallReceipt,
  op: 'install' | 'update',
  run: RunLike = execaRun,
): Promise<RegistryInstallReceipt['native'] | undefined> {
  const wants =
    cli.native ||
    hasNativeRequest({
      profile: cli.profile,
      scope: cli.scope,
      components: cli.components,
      host: cli.host,
      gatewayProfile: cli.gatewayProfile,
    });
  if (!wants) return undefined;
  const repo = FORGE_REPOS.find((r) => r.name === entry.name);
  const built =
    repo &&
    (op === 'install'
      ? buildNativeInstall(repo, {
          profile: cli.profile,
          scope: cli.scope,
          components: cli.components,
          host: cli.host,
          gatewayProfile: cli.gatewayProfile,
          approve: cli.yes,
        })
      : buildNativeOp(repo, 'update', cli.yes ?? false));
  if (!built) {
    return { argv: [], ran: false, skipped: 'sem instalador nativo documentado' };
  }
  if (built.argv[0] === '{python}') {
    return {
      argv: built.argv,
      ran: false,
      skipped:
        'instalador por script do repositório (scripts/forge_install.py) — indisponível no método registry',
    };
  }
  const argv = [receipt.bin, ...built.argv.slice(1)];
  const res = await run(argv[0], argv.slice(1));
  const ignored = 'ignored' in built ? (built.ignored as string[]) : [];
  return {
    argv,
    ran: true,
    dryRun: built.dryRun,
    exitCode: res.exitCode,
    ...(ignored.length ? { ignored } : {}),
  };
}

/** Persiste `receipt.native` — receipt + state ficam consistentes. */
function persistReceipt(home: string, receipt: RegistryInstallReceipt): void {
  writeFileAtomic(receiptPath(home, receipt.forge), `${JSON.stringify(receipt, null, 2)}\n`);
  const state = loadForgeState(home);
  if (Object.hasOwn(state.forges, receipt.forge)) {
    state.forges[receipt.forge] = receipt;
    saveForgeState(home, state);
  }
}

function writeRegistryReport(reportPath: string, doc: unknown): void {
  const file = path.resolve(reportPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, redactSecrets(JSON.stringify(doc, null, 2)));
}

export async function runRegistryInstall(
  cli: CliOptions,
  names: string[],
  deps: { home?: string; pythons?: ProbedPython[]; fetchImpl?: FetchLike; run?: RunLike } = {},
): Promise<RegistryInstallResult[]> {
  const home = deps.home ?? cliHome();
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

  // Flags nativas inválidas falham antes de gastar rede/disco —
  // erro nomeado (mesmo contrato do fluxo git), nunca warning.
  const nativeErr = validateRegistryNativeFlags(cli);
  if (nativeErr) {
    reportTo({ error: nativeErr, warnings });
    if (quiet) emitJson({ error: nativeErr, warnings }, 1);
    log.error(nativeErr);
    process.exit(1);
    return [];
  }

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
      run: deps.run,
    });
    if ('stage' in receipt) {
      if (!quiet) spin.stop(`${name}: ${theme.err('falhou')}`);
      results.push({ forge: name, ok: false, detail: describeInstallError(receipt) });
      continue;
    }
    // Fase 2: delegação ao instalador nativo (skills/agents/hosts/components).
    receipt.native = await delegateNative(cli, entry!, receipt, 'install', deps.run);
    if (receipt.native) {
      persistReceipt(home, receipt);
      const n = receipt.native;
      if (!quiet) {
        if (n.skipped) log.warn(`${name}: ${n.skipped}`);
        else if (n.exitCode !== 0) log.warn(`${name}: instalador nativo saiu ${n.exitCode}`);
        else
          log.info(`${name}: nativo ${n.dryRun ? '(dry-run)' : 'aplicado'} — ${n.argv.join(' ')}`);
      }
      if (n.skipped) warnings.push(`${name}: ${n.skipped}`);
      if (n.ran && n.exitCode !== 0) warnings.push(`${name}: instalador nativo saiu ${n.exitCode}`);
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
      ...(receipt.native ? { native: receipt.native } : {}),
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
  const home = deps.home ?? cliHome();
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
  deps: { home?: string; run?: RunLike } = {},
): Promise<void> {
  const home = deps.home ?? cliHome();
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

  const results = [];
  for (const r of removals) {
    // `--native`: desfaz a fase 2 primeiro — op documentada da Forja,
    // rodada pelo bin da venv antes de removê-la. `{python}` é skip
    // honesto (script do repo, ausente na wheel).
    let native: RegistryInstallReceipt['native'];
    if (cli.native) {
      const repo = FORGE_REPOS.find((x) => x.name === r.name);
      const receipt = Object.hasOwn(state, r.name) ? state[r.name] : undefined;
      const op = repo && buildNativeOp(repo, 'uninstall', cli.yes ?? false);
      if (!op) {
        native = { argv: [], ran: false, skipped: 'sem op nativa de uninstall documentada' };
      } else if (op.argv[0] === '{python}' || !receipt) {
        native = {
          argv: op.argv,
          ran: false,
          skipped: 'op nativa por script do repositório — indisponível no método registry',
        };
      } else {
        const argv = [receipt.bin, ...op.argv.slice(1)];
        const res = await (deps.run ?? execaRun)(argv[0], argv.slice(1));
        native = { argv, ran: true, dryRun: op.dryRun, exitCode: res.exitCode };
        if (res.exitCode !== 0) warnings.push(`${r.name}: uninstall nativo saiu ${res.exitCode}`);
      }
    }
    const res = registryUninstall({ name: r.name, dist: r.dist }, { home });
    if (res.refused) log.error(`${r.name}: recusado — ${res.refused}`);
    results.push({
      forge: r.name,
      removed: res.removed,
      cacheRemoved: res.cacheRemoved,
      ...(native ? { native } : {}),
    });
  }
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

// ---------------------------------------------------------------------------
// Wave 3 — lifecycle registry: update / reinstall / rollback / pin / unpin
// ---------------------------------------------------------------------------

interface LifecycleItem {
  name: string;
  entry: RegistryEntry;
  receipt: RegistryInstallReceipt;
  action: 'update' | 'reinstall' | 'rollback';
  from: string;
  to?: string;
  detail?: string;
}

/** Recibo → entrada de catálogo real ou sintética (ghost-forge). */
function entryFor(name: string, receipt: RegistryInstallReceipt) {
  return registryEntry(name) ?? ghostEntry(name, receipt);
}

/**
 * Escopo compartilhado: resolve alvos → receipts → plano. Recusas de nome
 * inseguro e desconhecidos seguem o mesmo contrato do uninstall.
 */
function lifecycleTargets(
  cli: CliOptions,
  names: string[],
  home: string,
): { ok: LifecycleTarget[]; unknown: string[]; skipped: string[] } {
  const state = loadForgeState(home).forges;
  const targets = resolveRegistryTargets(cli, names, Object.keys(state));
  const ok: LifecycleTarget[] = [];
  const unknown: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const entry = registryEntry(raw);
    const name = entry?.name ?? raw;
    if (!isSafeRepoName(name) || seen.has(name)) {
      if (!seen.has(name) && !isSafeRepoName(name)) unknown.push(raw);
      continue;
    }
    seen.add(name);
    const receipt = Object.hasOwn(state, name) ? state[name] : undefined;
    if (!receipt) {
      if (entry) skipped.push(name);
      else unknown.push(name);
      continue;
    }
    ok.push({ name, receipt });
  }
  return { ok, unknown, skipped };
}

interface LifecycleTarget {
  name: string;
  receipt: RegistryInstallReceipt;
}

async function runRegistryLifecycle(
  cli: CliOptions,
  names: string[],
  deps: { home?: string; pythons?: ProbedPython[]; fetchImpl?: FetchLike; run?: RunLike },
): Promise<void> {
  const home = deps.home ?? cliHome();
  const quiet = registryQuiet(cli);
  const reportTo = (doc: unknown) => {
    if (cli.reportPath !== undefined) writeRegistryReport(cli.reportPath, doc);
  };
  const { ok: targets, unknown, skipped } = lifecycleTargets(cli, names, home);
  if (!targets.length && !skipped.length && !unknown.length) {
    const msg = 'nenhuma Forja instalada via registry — nada a atualizar';
    reportTo({ error: msg });
    if (quiet) emitJson({ error: msg }, 2);
    log.error(msg);
    process.exit(2);
    return;
  }
  const ignored = ignoredRegistryFlags(cli);
  const warnings: string[] = [
    ...skipped.map((n) => `${n}: não estava instalado via registry — ignorado`),
    ...(ignored.length ? [`${S.registryIgnoredFlags}: ${ignored.join(', ')}`] : []),
  ];

  const pinVersion = cli.ref?.replace(/^v(?=\d)/, '');
  const isCheck = cli.plan || cli.check;
  const items: LifecycleItem[] = [];
  for (const t of targets) {
    const entry = entryFor(t.name, t.receipt);
    if (t.receipt.pinned && !pinVersion) {
      items.push({
        ...t,
        entry,
        action: 'update',
        from: t.receipt.version,
        detail: `${S.registryPinnedAt} ${t.receipt.pinned}`,
      });
      continue;
    }
    const resolved = await resolveRelease(entry.dist, {
      pin: pinVersion,
      offline: cli.offline,
      cacheDir: registryCacheDir(home),
      fetchImpl: deps.fetchImpl,
    });
    if ('kind' in resolved) {
      items.push({
        ...t,
        entry,
        action: 'update',
        from: t.receipt.version,
        detail: describeResolveError(resolved),
      });
      continue;
    }
    const same = resolved.version === t.receipt.version;
    items.push({
      ...t,
      entry,
      action: 'update',
      from: t.receipt.version,
      to: resolved.version,
      detail: same ? 'já na mais recente' : undefined,
    });
  }

  if (isCheck) {
    const doc = {
      method: 'pypi',
      plan: true,
      updates: items.map((i) => ({
        forge: i.name,
        from: i.from,
        to: i.to ?? null,
        status: i.detail ?? 'update',
      })),
      skipped,
      warnings,
      ...(unknown.length ? { error: `${unknown.join(', ')}: sem dist no catálogo registry` } : {}),
    };
    reportTo(doc);
    if (quiet) emitJson(doc, unknown.length ? 2 : 0);
    note(
      items
        .map((i) => `${i.name}: ${i.from} → ${i.to ?? '—'}${i.detail ? ` (${i.detail})` : ''}`)
        .join('\n'),
      'Plano de update',
    );
    if (unknown.length) process.exit(2);
    return;
  }

  const actionable = items.filter((i) => i.to && i.to !== i.from);
  if (!quiet) {
    for (const i of items.filter((i) => i.detail)) log.warn(`${i.name}: ${i.detail}`);
    for (const w of warnings) log.warn(w);
    note(
      actionable.length
        ? actionable.map((i) => `${i.name}: ${i.from} → ${i.to}`).join('\n')
        : 'nada a atualizar',
      'Update registry-first',
    );
  }
  if (!actionable.length) {
    const doc = {
      method: 'pypi',
      updated: [],
      skipped,
      warnings,
      ...(unknown.length ? { error: `${unknown.join(', ')}: sem dist no catálogo registry` } : {}),
    };
    reportTo(doc);
    if (quiet) emitJson(doc, unknown.length ? 2 : skipped.length && !items.length ? 1 : 0);
    if (!quiet) log.info('Nada a atualizar.');
    if (unknown.length) process.exit(2);
    // Alvo existe no catálogo mas não instalado → nada aconteceu, exit 1.
    if (skipped.length && !items.length) process.exit(1);
    return;
  }
  if (!quiet && !cli.yes && process.stdout.isTTY && process.stdin.isTTY) {
    const answer = await confirm({ message: S.confirmRun });
    if (isCancel(answer) || !answer) {
      if (isCancel(answer)) exitCancelled();
      reportTo({ error: S.registryUninstallNeedsYes });
      log.warn(S.registryUninstallNeedsYes);
      process.exit(0);
      return;
    }
  }

  const pythons = deps.pythons ?? (await probePythons());
  const results = [];
  const state = loadForgeState(home);
  for (const i of actionable) {
    const spin = spinner();
    if (!quiet) spin.start(`${i.name}: ${i.from} → ${i.to}…`);
    const receipt = await registryInstall(i.entry, i.to, {
      home,
      cacheDir: registryCacheDir(home),
      offline: cli.offline,
      pythons,
      clean: true,
      fetchImpl: deps.fetchImpl,
      run: deps.run,
    });
    if ('stage' in receipt) {
      if (!quiet) spin.stop(`${i.name}: ${theme.err('falhou')} (${describeInstallError(receipt)})`);
      results.push({
        forge: i.name,
        ok: false,
        from: i.from,
        to: i.to,
        detail: describeInstallError(receipt),
      });
      continue;
    }
    // histórico: versão anterior entra no topo — rollback desempilha.
    const prev = state.forges[i.name];
    receipt.history = [
      ...(i.receipt.history ?? []),
      { version: i.from, installedAt: i.receipt.installedAt },
    ];
    // `--ref` é override pontual — não cria nem remove pin.
    receipt.pinned = prev?.pinned;
    receipt.native = await delegateNative(cli, i.entry, receipt, 'update', deps.run);
    if (receipt.native?.skipped) warnings.push(`${i.name}: ${receipt.native.skipped}`);
    if (receipt.native?.ran && receipt.native.exitCode !== 0)
      warnings.push(`${i.name}: instalador nativo saiu ${receipt.native.exitCode}`);
    state.forges[i.name] = receipt;
    if (!quiet) spin.stop(`${i.name}: ${theme.ok(`${i.from} → ${i.to}`)}`);
    results.push({ forge: i.name, ok: true, from: i.from, to: i.to, bin: receipt.bin });
  }
  saveForgeState(home, state);
  const doc = {
    method: 'pypi',
    updated: results,
    skipped,
    warnings,
    ...(unknown.length ? { error: `${unknown.join(', ')}: sem dist no catálogo registry` } : {}),
  };
  reportTo(doc);
  if (quiet) emitJson(doc, results.every((r) => r.ok) ? (unknown.length ? 2 : 0) : 1);
  if (results.some((r) => !r.ok)) process.exit(1);
  if (unknown.length) process.exit(2);
}

export async function runRegistryUpdate(
  cli: CliOptions,
  names: string[],
  deps: { home?: string; pythons?: ProbedPython[]; fetchImpl?: FetchLike; run?: RunLike } = {},
): Promise<void> {
  await runRegistryLifecycle(cli, names, deps);
}

/** Reinstala a MESMA versão registrada no receipt — reparo de drift. */
export async function runRegistryReinstall(
  cli: CliOptions,
  names: string[],
  deps: { home?: string; pythons?: ProbedPython[]; fetchImpl?: FetchLike; run?: RunLike } = {},
): Promise<void> {
  const home = deps.home ?? cliHome();
  const quiet = registryQuiet(cli);
  const reportTo = (doc: unknown) => {
    if (cli.reportPath !== undefined) writeRegistryReport(cli.reportPath, doc);
  };
  const { ok: targets, unknown, skipped } = lifecycleTargets(cli, names, home);
  const ignored = ignoredRegistryFlags(cli);
  const warnings = [
    ...skipped.map((n) => `${n}: não instalado via registry — ignorado`),
    ...(ignored.length ? [`${S.registryIgnoredFlags}: ${ignored.join(', ')}`] : []),
  ];
  if (!targets.length) {
    const msg = S.errRegistryReinstallNeedsNames;
    reportTo({ error: msg, warnings, ...(unknown.length ? { unknown } : {}) });
    if (quiet) emitJson({ error: msg, warnings, unknown }, unknown.length ? 2 : 1);
    log.error(msg);
    process.exit(unknown.length ? 2 : 1);
    return;
  }
  if (cli.plan || cli.check) {
    const doc = {
      method: 'pypi',
      plan: true,
      reinstalls: targets.map((t) => ({ forge: t.name, version: t.receipt.version })),
      skipped,
      warnings,
    };
    reportTo(doc);
    if (quiet) emitJson(doc, 0);
    note(
      targets.map((t) => `${t.name}==${t.receipt.version} (reinstall limpo)`).join('\n'),
      'Plano de reinstall',
    );
    return;
  }
  const pythons = deps.pythons ?? (await probePythons());
  const results = [];
  const state = loadForgeState(home);
  for (const t of targets) {
    const spin = spinner();
    if (!quiet) spin.start(`${t.name}: reinstall ${t.receipt.version}…`);
    const receipt = await registryInstall(entryFor(t.name, t.receipt), t.receipt.version, {
      home,
      cacheDir: registryCacheDir(home),
      offline: cli.offline,
      pythons,
      clean: true,
      fetchImpl: deps.fetchImpl,
      run: deps.run,
    });
    if ('stage' in receipt) {
      if (!quiet) spin.stop(`${t.name}: ${theme.err('falhou')} (${describeInstallError(receipt)})`);
      results.push({ forge: t.name, ok: false, detail: describeInstallError(receipt) });
      continue;
    }
    // Preserva pin e histórico — reinstall não é lifecycle de versão.
    receipt.pinned = t.receipt.pinned;
    receipt.history = t.receipt.history;
    receipt.native = await delegateNative(
      cli,
      entryFor(t.name, t.receipt),
      receipt,
      'update',
      deps.run,
    );
    if (receipt.native?.skipped) warnings.push(`${t.name}: ${receipt.native.skipped}`);
    if (receipt.native?.ran && receipt.native.exitCode !== 0)
      warnings.push(`${t.name}: instalador nativo saiu ${receipt.native.exitCode}`);
    state.forges[t.name] = receipt;
    if (!quiet) spin.stop(`${t.name}: ${theme.ok('reinstalado')} (${receipt.version})`);
    results.push({ forge: t.name, ok: true, version: receipt.version, bin: receipt.bin });
  }
  saveForgeState(home, state);
  const doc = {
    method: 'pypi',
    reinstalled: results,
    skipped,
    warnings,
    ...(unknown.length ? { error: `${unknown.join(', ')}: sem dist no catálogo registry` } : {}),
  };
  reportTo(doc);
  if (quiet) emitJson(doc, results.every((r) => r.ok) ? (unknown.length ? 2 : 0) : 1);
  if (results.some((r) => !r.ok)) process.exit(1);
  if (unknown.length) process.exit(2);
}

/** Rollback: desempilha a versão anterior do receipt.history. */
export async function runRegistryRollback(
  cli: CliOptions,
  names: string[],
  deps: { home?: string; pythons?: ProbedPython[]; fetchImpl?: FetchLike; run?: RunLike } = {},
): Promise<void> {
  const home = deps.home ?? cliHome();
  const quiet = registryQuiet(cli);
  const reportTo = (doc: unknown) => {
    if (cli.reportPath !== undefined) writeRegistryReport(cli.reportPath, doc);
  };
  const { ok: targets, unknown, skipped } = lifecycleTargets(cli, names, home);
  const ignored = ignoredRegistryFlags(cli);
  const warnings = [
    ...skipped.map((n) => `${n}: não instalado via registry — ignorado`),
    ...(ignored.length ? [`${S.registryIgnoredFlags}: ${ignored.join(', ')}`] : []),
  ];
  const plan = targets.map((t) => {
    const prev = t.receipt.history?.at(-1);
    return {
      name: t.name,
      receipt: t.receipt,
      to: prev?.version,
      detail: prev ? undefined : S.rollbackNoPrevious,
    };
  });
  const actionable = plan.filter((p) => p.to);
  if (cli.plan || cli.check) {
    const doc = {
      method: 'pypi',
      plan: true,
      rollbacks: plan.map((p) => ({
        forge: p.name,
        from: p.receipt.version,
        to: p.to ?? null,
        status: p.detail ?? 'rollback',
      })),
      skipped,
      warnings,
    };
    reportTo(doc);
    if (quiet) emitJson(doc, 0);
    note(
      plan
        .map(
          (p) =>
            `${p.name}: ${p.receipt.version} → ${p.to ?? '—'}${p.detail ? ` (${p.detail})` : ''}`,
        )
        .join('\n'),
      'Plano de rollback',
    );
    return;
  }
  if (!actionable.length) {
    const msg = targets.length
      ? `${S.rollbackNoPrevious} — ${targets.map((t) => t.name).join(', ')}`
      : S.errRegistryRollbackNeedsNames;
    reportTo({ error: msg, warnings, ...(unknown.length ? { unknown } : {}) });
    if (quiet) emitJson({ error: msg, warnings, unknown }, 1);
    log.error(msg);
    process.exit(1);
    return;
  }
  const pythons = deps.pythons ?? (await probePythons());
  const results = [];
  const state = loadForgeState(home);
  for (const p of actionable) {
    const spin = spinner();
    if (!quiet) spin.start(`${p.name}: ${p.receipt.version} → ${p.to}…`);
    const receipt = await registryInstall(entryFor(p.name, p.receipt), p.to, {
      home,
      cacheDir: registryCacheDir(home),
      offline: cli.offline,
      pythons,
      clean: true,
      fetchImpl: deps.fetchImpl,
      run: deps.run,
    });
    if ('stage' in receipt) {
      if (!quiet) spin.stop(`${p.name}: ${theme.err('falhou')} (${describeInstallError(receipt)})`);
      results.push({ forge: p.name, ok: false, detail: describeInstallError(receipt) });
      continue;
    }
    // Desempilha o alvo e empilha a versão abandonada — rollback de rollback funciona.
    const rest = (p.receipt.history ?? []).slice(0, -1);
    receipt.history = [...rest, { version: p.receipt.version, installedAt: p.receipt.installedAt }];
    receipt.pinned = p.receipt.pinned;
    state.forges[p.name] = receipt;
    if (!quiet) spin.stop(`${p.name}: ${theme.ok(`${p.receipt.version} → ${p.to}`)}`);
    results.push({ forge: p.name, ok: true, from: p.receipt.version, to: p.to, bin: receipt.bin });
  }
  saveForgeState(home, state);
  const doc = {
    method: 'pypi',
    rolledBack: results,
    skipped,
    warnings,
    ...(unknown.length ? { error: `${unknown.join(', ')}: sem dist no catálogo registry` } : {}),
  };
  reportTo(doc);
  if (quiet) emitJson(doc, results.every((r) => r.ok) ? (unknown.length ? 2 : 0) : 1);
  if (results.some((r) => !r.ok)) process.exit(1);
  if (unknown.length) process.exit(2);
}

/** pin/unpin — trava a versão atual do receipt no state (update respeita). */
export async function runRegistryPin(
  cli: CliOptions,
  names: string[],
  pin: boolean,
  deps: { home?: string } = {},
): Promise<void> {
  const home = deps.home ?? cliHome();
  const quiet = registryQuiet(cli);
  const reportTo = (doc: unknown) => {
    if (cli.reportPath !== undefined) writeRegistryReport(cli.reportPath, doc);
  };
  const { ok: targets, unknown, skipped } = lifecycleTargets(cli, names, home);
  const ignored = ignoredRegistryFlags(cli);
  const warnings = [
    ...skipped.map((n) => `${n}: não instalado via registry — ignorado`),
    ...(ignored.length ? [`${S.registryIgnoredFlags}: ${ignored.join(', ')}`] : []),
  ];
  if (!targets.length) {
    const msg = pin ? S.errRegistryPinNeedsNames : S.errRegistryUnpinNeedsNames;
    reportTo({ error: msg, warnings, unknown });
    if (quiet) emitJson({ error: msg, warnings, unknown }, unknown.length ? 2 : 1);
    log.error(msg);
    process.exit(unknown.length ? 2 : 1);
    return;
  }
  const state = loadForgeState(home);
  const done = [];
  for (const t of targets) {
    if (pin) {
      state.forges[t.name].pinned = t.receipt.version;
      done.push({ forge: t.name, pinned: t.receipt.version });
    } else {
      delete state.forges[t.name].pinned;
      done.push({ forge: t.name, pinned: null });
    }
  }
  saveForgeState(home, state);
  const doc = {
    method: 'pypi',
    [pin ? 'pinned' : 'unpinned']: done,
    skipped,
    warnings,
    ...(unknown.length ? { error: `${unknown.join(', ')}: sem dist no catálogo registry` } : {}),
  };
  reportTo(doc);
  if (quiet) emitJson(doc, unknown.length ? 2 : 0);
  for (const d of done) {
    log.success(pin ? `${d.forge}: ${S.pinDone} ${d.pinned}` : `${d.forge}: ${S.unpinDone}`);
  }
  if (unknown.length) process.exit(2);
}
