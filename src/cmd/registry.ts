/**
 * `install --method registry` — instalação registry-first via PyPI.
 * Resolve names → catálogo, escolhe o melhor interpretador que satisfaz
 * `requires_python`, cria venv isolada por Forja e grava receipt.
 */
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { confirm, isCancel, multiselect } from '@clack/prompts';
import { log, note, outro, spinner } from '@clack/prompts';
import type { CliOptions } from '../cli-args.js';
import { exitCancelled } from '../prompts.js';
import { discoverPythons, type PythonDiscovery, type PythonRefusal } from '../env/python.js';
import type { ProbeRun } from '../env/shells.js';
import { isSafeRepoName, redactSecrets, writeFileAtomic } from '../safety.js';
import { registryEntry, REGISTRY_PACKAGES, type RegistryEntry } from '../registry/catalog.js';
import {
  acquireForgeLock,
  execaRun,
  forgeVenv,
  ghostEntry,
  installConsistency,
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
import { generateOfflineLock, type OfflineLock } from '../registry/lock.js';
import { compareVersions, type ParsedVersion } from '../registry/versions.js';
import { S } from '../ui/strings.js';
import { icons, theme } from '../ui/theme.js';
import { cliHome, commandOutput, resolveTargetDir } from '../utils/system.js';
import { emitJson } from './shared.js';
import {
  askOptionalIntegrations,
  classifyIntegrations,
  defaultWhich,
  pendingIntegrations,
  type IntegrationStatus,
} from '../integrations.js';

export interface ProbedPython {
  exe: string[];
  version: string;
  parsed: ParsedVersion;
  /** Origem no pipeline lf-0017 ('env', 'flag', 'venv', 'path', …). */
  source?: string;
  /** Por que este candidato foi produzido — vai ao receipt. */
  selection_reason?: string;
}

/** Candidatos válidos do pipeline → forma ProbedPython (dedup por versão, mais novo primeiro). */
export function probedFromDiscovery(discovery: PythonDiscovery): ProbedPython[] {
  const seen = new Set<string>();
  const out: ProbedPython[] = [];
  for (const c of discovery.candidates) {
    if (!c.valid || !c.parsed || c.version === null || seen.has(c.version)) continue;
    seen.add(c.version);
    out.push({
      exe: c.argv,
      version: c.version,
      parsed: c.parsed,
      source: c.source,
      selection_reason:
        c.stage <= 1
          ? `seleção explícita (${c.source === 'env' ? 'FORGE_PYTHON' : '--python'}) — vence a descoberta automática`
          : `descoberta automática — estágio '${c.source}' do pipeline lf-0017`,
    });
  }
  out.sort((a, b) => compareVersions(b.parsed, a.parsed));
  return out;
}

/**
 * Sonda compatível com o formato legado `(exe, args) → string|null` por
 * cima do pipeline lf-0017 — candidatos de TODOS os estágios, validados
 * por execução; dedup por versão, mais novo primeiro.
 */
export async function probePythons(
  platform: NodeJS.Platform = process.platform,
  probe: (exe: string, args: string[]) => Promise<string | null> = commandOutput,
  opts: { explicit?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProbedPython[]> {
  const run: ProbeRun = async (cmd, args) => {
    // O probe legado só sabe responder `<exe> --version` — a resolução
    // de nome (`command -v`/`where.exe`) responde o próprio nome e deixa
    // a sonda --version decidir (mesma semântica da sonda legada).
    if (cmd === 'sh' && args[0] === '-c' && /^command -v \S+$/.test(args[1] ?? '')) {
      return { ok: true, output: (args[1] ?? '').replace('command -v ', ''), timed_out: false };
    }
    if (cmd === 'where.exe') {
      return { ok: true, output: args[0] ?? null, timed_out: false };
    }
    const out = await probe(cmd, args);
    return { ok: out !== null, output: out, timed_out: false };
  };
  const discovery = await discoverPythons({
    platform,
    run,
    explicit: opts.explicit,
    env: opts.env,
  });
  return probedFromDiscovery(discovery);
}

/**
 * Interpretadores do fluxo registry via pipeline lf-0017. Seleção
 * explícita (`--python`/`FORGE_PYTHON`) inválida volta em `refusal`
 * (FORGE-PYTHON-*) — nunca fallback silencioso para a auto-descoberta.
 */
async function registryPythons(
  cli: CliOptions,
  injected: ProbedPython[] | undefined,
): Promise<{ pythons: ProbedPython[]; refusal: PythonRefusal | null }> {
  if (injected !== undefined) return { pythons: injected, refusal: null };
  const discovery = await discoverPythons({ explicit: cli.python });
  return { pythons: probedFromDiscovery(discovery), refusal: discovery.refusal };
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
  if (e.stage === 'lock') return `${e.error.kind}: ${e.error.detail}`;
  // 'busy'/'persist'/'incomplete' — o detail já é a mensagem completa
  // (nome da Forja + causa + reparo); o stage prefixa como etiqueta.
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
  /** Extras PEP 508 que o install pedirá junto da dist. */
  extras?: string[];
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

/**
 * Persiste `receipt.native` — receipt + state ficam consistentes. A
 * leitura→mutação→grava roda sob o lifecycle lock: um pin/uninstall
 * concorrente não pode perder a atualização do `native`.
 */
async function persistReceipt(home: string, receipt: RegistryInstallReceipt): Promise<void> {
  const res = await acquireForgeLock(home);
  if (!res.ok) throw new Error(res.detail);
  try {
    writeFileAtomic(receiptPath(home, receipt.forge), `${JSON.stringify(receipt, null, 2)}\n`);
    const state = loadForgeState(home);
    if (Object.hasOwn(state.forges, receipt.forge)) {
      state.forges[receipt.forge] = receipt;
      saveForgeState(home, state);
    }
  } finally {
    res.lock.release();
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
  deps: {
    home?: string;
    pythons?: ProbedPython[];
    fetchImpl?: FetchLike;
    run?: RunLike;
    which?: (bin: string) => Promise<string | null>;
    /** Guard anti-recursão — a oferta pós-install roda só uma vez. */
    skipIntegrations?: boolean;
  } = {},
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

  const { pythons, refusal } = await registryPythons(cli, deps.pythons);
  if (refusal || !pythons.length) {
    // Recusa FORGE-PYTHON-* nomeada (explicit inválido, nada compatível,
    // zero candidatos) — causa + remédio PT-BR, nunca mensagem muda.
    const code = refusal?.code ?? 'FORGE-PYTHON-NOT-FOUND';
    const msg = refusal
      ? `${refusal.code}: ${refusal.cause}`
      : 'FORGE-PYTHON-NOT-FOUND: nenhum interpretador Python detectado — instale Python ≥3.10';
    reportTo({ error: msg, warnings, code });
    if (quiet) emitJson({ error: msg, warnings }, 1);
    log.error(msg);
    if (refusal) log.info(`→ ${refusal.remedy}`);
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
        ephemeral: true, // P0-002: plan não persiste nem cache
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
        ...(entry!.extras?.length ? { extras: entry!.extras } : {}),
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
            ? `${p.forge} → ${p.dist}${p.extras?.length ? `[${p.extras.join(',')}]` : ''}==${p.version} (python ${p.python}, venv ${p.venv})`
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
      lockFile: cli.lockFile,
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
      await persistReceipt(home, receipt);
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

  // lf-0031: integrações opcionais — classificadas por evidência (receipt /
  // checkout / PATH), reportadas no doc JSON e oferecidas com consentimento
  // explícito no modo interativo. Nunca instalam sozinhas.
  const integrationStatuses = deps.skipIntegrations
    ? []
    : await collectIntegrationStatuses(results, home, cli, deps.which);
  const pending = pendingIntegrations(integrationStatuses);

  const doc = {
    method: 'pypi',
    results,
    warnings,
    ...(pending.length ? { optional_integrations: pending.map(integrationJson) } : {}),
  };
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
    if (!inst) return '';
    return inst.shim
      ? `${r.forge} → ${path.basename(inst.shim)} (em ${path.dirname(inst.shim)})`
      : `${r.forge} → ${inst.bin}`;
  });
  note(
    bins.filter(Boolean).join('\n'),
    'Launchers em ~/.forge-cli/bin (no PATH do forge-cli); sem shim, invoque o caminho da venv',
  );
  outro(`${icons.ok} instalação registry-first concluída`);

  // Oferta checkbox-style: só em TTY interativo e sem --yes — consentimento
  // nunca é presumido. Nos demais modos a lista vira nota (opcional, informativa).
  if (pending.length && !deps.skipIntegrations) {
    const canAsk = !quiet && !cli.yes && process.stdout.isTTY && process.stdin.isTTY;
    if (canAsk) {
      const offer = await askOptionalIntegrations(pending, async (options) => {
        const picked = await multiselect({
          message: S.integrationsOffer,
          options,
          required: false,
        });
        if (isCancel(picked)) exitCancelled();
        return picked;
      });
      for (const n of offer.notInstallable) {
        log.warn(`${n}: ${S.integrationNoInstallRoute}`);
      }
      if (offer.installable.length) {
        await runRegistryInstall(cli, offer.installable, { ...deps, skipIntegrations: true });
      }
    } else if (!quiet) {
      note(
        pending
          .map(
            (s) =>
              `${s.integration.name} — ${s.integration.reason}${s.integration.installable ? '' : ` (${S.integrationNoInstallRoute})`}`,
          )
          .join('\n'),
        S.integrationsTitle,
      );
    }
  }
  return results;
}

function integrationJson(s: IntegrationStatus) {
  return {
    name: s.integration.name,
    state: s.state,
    adapter: s.integration.adapter,
    installable: s.integration.installable,
    reason: s.integration.reason,
    evidence: s.evidence,
  };
}

async function collectIntegrationStatuses(
  results: RegistryInstallResult[],
  home: string,
  cli: CliOptions,
  which?: (bin: string) => Promise<string | null>,
): Promise<IntegrationStatus[]> {
  const root = resolveTargetDir(cli.dir);
  const bin = (n: string) => FORGE_REPOS.find((r) => r.name === n)?.verify?.[0];
  const statuses: IntegrationStatus[] = [];
  for (const r of results) {
    if (!r.ok) continue;
    statuses.push(
      ...(await classifyIntegrations(r.forge, {
        root,
        home,
        which: which ?? defaultWhich,
        bin,
      })),
    );
  }
  return statuses;
}

/**
 * `forge-cli registry lock <forja…>` — resolve ONLINE uma vez e gera
 * `<forja>.offline-lock.json` (--out <arquivo|dir>) com o fecho transitivo
 * inteiro (name/version/filename/sha256/tags). É o preparo do modo offline:
 * exige rede justamente por isso — `--offline` aqui seria contradição.
 */
export async function runRegistryLock(
  cli: CliOptions,
  names: string[],
  deps: {
    home?: string;
    pythons?: ProbedPython[];
    fetchImpl?: FetchLike;
    run?: RunLike;
  } = {},
): Promise<{ forge: string; ok: boolean; detail: string; file?: string }[]> {
  const home = deps.home ?? cliHome();
  const quiet = registryQuiet(cli);
  const reportTo = (doc: unknown) => {
    if (cli.reportPath !== undefined) writeRegistryReport(cli.reportPath, doc);
  };
  if (!names.length) {
    const msg = S.errRegistryNeedsNames;
    reportTo({ error: msg });
    if (quiet) emitJson({ error: msg }, 2);
    log.error(msg);
    process.exit(2);
  }
  if (cli.offline) {
    const msg = 'registry lock exige rede — ele gera o fecho que o --offline consome';
    reportTo({ error: msg });
    if (quiet) emitJson({ error: msg }, 2);
    log.error(msg);
    process.exit(2);
  }
  const entries = names.map((n) => ({ name: n, entry: registryEntry(n) }));
  const unknown = entries.filter((e) => !e.entry);
  if (unknown.length) {
    const msg = `${unknown.map((u) => u.name).join(', ')}: sem dist no catálogo registry`;
    reportTo({ error: msg });
    if (quiet) emitJson({ error: msg }, 2);
    log.error(msg);
    process.exit(2);
  }
  const { pythons, refusal } = await registryPythons(cli, deps.pythons);
  if (refusal || !pythons.length) {
    const code = refusal?.code ?? 'FORGE-PYTHON-NOT-FOUND';
    const msg = refusal
      ? `${refusal.code}: ${refusal.cause}`
      : 'FORGE-PYTHON-NOT-FOUND: nenhum interpretador Python detectado — instale Python ≥3.10';
    reportTo({ error: msg, code });
    if (quiet) emitJson({ error: msg }, 1);
    log.error(msg);
    if (refusal) log.info(`→ ${refusal.remedy}`);
    process.exit(1);
  }
  const pin = cli.ref?.replace(/^v(?=\d)/, '');
  // --plan/--check: resolve + valida o que o lock conteria (sem escrever
  // cache, sem rodar pip download, sem gravar o lockfile).
  const isPlan = cli.plan || cli.check;
  const results: { forge: string; ok: boolean; detail: string; file?: string }[] = [];
  const locks: { forge: string; lock: OfflineLock; file: string }[] = [];
  for (const { entry } of entries) {
    const e = entry!;
    const resolved = await resolveRelease(e.dist, {
      pin,
      cacheDir: registryCacheDir(home),
      fetchImpl: deps.fetchImpl,
      ephemeral: isPlan,
    });
    if ('kind' in resolved) {
      results.push({ forge: e.name, ok: false, detail: describeResolveError(resolved) });
      continue;
    }
    const picked = selectInterpreter(e, resolved, pythons);
    if ('error' in picked) {
      results.push({ forge: e.name, ok: false, detail: describeResolveError(picked.error) });
      continue;
    }
    // --out: arquivo quando uma Forja, diretório quando várias; default
    // `<forja>.offline-lock.json` no cwd.
    const out = cli.out
      ? entries.length === 1
        ? path.resolve(cli.out)
        : path.join(path.resolve(cli.out), `${e.name}.offline-lock.json`)
      : path.resolve(`${e.name}.offline-lock.json`);
    if (isPlan) {
      results.push({
        forge: e.name,
        ok: true,
        file: out,
        detail: `${e.dist}==${resolved.version} — ${S.lockPlanWouldWrite} ${out}`,
      });
      continue;
    }
    const lock = await generateOfflineLock(e, resolved.version, {
      run: deps.run ?? execaRun,
      python: picked.python,
      cacheDir: registryCacheDir(home),
    });
    if ('kind' in lock) {
      results.push({ forge: e.name, ok: false, detail: `${lock.kind}: ${lock.detail}` });
      continue;
    }
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileAtomic(out, `${JSON.stringify(lock, null, 2)}\n`);
    locks.push({ forge: e.name, lock, file: out });
    results.push({
      forge: e.name,
      ok: true,
      file: out,
      detail: `${e.dist}==${resolved.version} · ${lock.artifacts.length} artefatos`,
    });
    if (!quiet)
      log.info(`${e.name}: lock → ${theme.dim(out)} (${lock.artifacts.length} artefatos)`);
  }
  const doc = {
    ...(isPlan ? { plan: true } : {}),
    locks: locks.map((l) => ({ forge: l.forge, file: l.file, artifacts: l.lock.artifacts.length })),
    results,
  };
  reportTo(doc);
  if (quiet) emitJson(doc, results.every((r) => r.ok) ? 0 : 1);
  for (const r of results) if (!r.ok) log.error(`${r.forge}: ${r.detail}`);
  if (results.some((r) => !r.ok)) process.exit(1);
  outro(isPlan ? `${icons.ok} ${S.planDryRunNote}` : `${icons.ok} lock(s) offline gerado(s)`);
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
    // Consistência state↔receipt↔venv: instalação quebrada por crash
    // (receipt ausente, versão divergente, venv órfã sem state) NUNCA
    // se apresenta como saudável — o marker nomeia o reparo e o JSON
    // carrega `consistency` com o status exato.
    const consistency = installConsistency(home, e.name);
    const relevant = consistency.status !== 'not-installed';
    return {
      forge: e.name,
      dist: e.dist,
      installed: inst?.version ?? null,
      method: inst?.method ?? null,
      verifyOk: inst ? (inst.verify?.ok ?? null) : null,
      binPresent: binOk,
      bin: inst ? (binOk ? inst.bin : `${inst.bin ?? '?'} (ausente)`) : null,
      consistent: relevant ? consistency.ok : null,
      consistency: relevant && !consistency.ok ? consistency.status : null,
      minPython: e.minPython,
      ...(inst?.method === 'local'
        ? {
            is_git: inst.is_git,
            source_trust: inst.source_trust,
            manifest_valid: inst.manifest_valid,
            integrity: inst.integrity,
            source_dir: inst.source_dir,
          }
        : {}),
    };
  });
  // Receipts fora do catálogo (fonte local com forge_id próprio ou ghost
  // PyPI) — uma linha por receipt para que nada instalado fique invisível.
  const extraRows = Object.entries(state.forges)
    .filter(([name]) => !REGISTRY_PACKAGES.some((e) => e.name === name))
    .filter(([name]) => !wanted || wanted.has(name))
    .map(([name, inst]) => ({
      forge: name,
      dist: inst.dist,
      installed: inst.version ?? null,
      method: inst.method ?? null,
      verifyOk: inst.verify?.ok ?? null,
      binPresent: typeof inst.bin === 'string' ? existsSync(inst.bin) : null,
      bin: inst.bin ?? null,
      consistent: null,
      consistency: null,
      minPython: null,
      ...(inst.method === 'local'
        ? {
            is_git: inst.is_git,
            source_trust: inst.source_trust,
            manifest_valid: inst.manifest_valid,
            integrity: inst.integrity,
            source_dir: inst.source_dir,
          }
        : {}),
    }));
  const allRows = [...rows, ...extraRows];
  if (cli.reportPath !== undefined) writeRegistryReport(cli.reportPath, { forges: allRows });
  if (registryQuiet(cli)) emitJson({ forges: allRows });
  note(
    allRows
      .map(
        (r) =>
          `${r.installed ? icons.ok : '·'} ${r.forge.padEnd(20)} ${r.dist.padEnd(20)} ${(r.installed ?? '—') + (r.method === 'local' ? ' (local)' : '') + (r.installed && r.verifyOk === false ? ` ${S.registryVerifyFailed}` : '') + (r.consistent === false ? ` ${S.registryIncomplete}` : '')}`,
      )
      .join('\n'),
    'Forjas (registry + fontes locais)',
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
  // `uninstall` não tem alvo de revisão — `--ref` seria ignorado: recusa.
  if (cli.ref !== undefined) {
    const msg = S.errUninstallNoRef;
    reportTo({ error: msg });
    if (quiet) emitJson({ error: msg }, 2);
    log.error(msg);
    process.exit(2);
    return;
  }
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
  const plan: {
    name: string;
    dist?: string;
    known: boolean;
    installed: boolean;
    local?: boolean;
  }[] = [];
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
      // Receipt de fonte local NUNCA vira rmSync registry: o envelope do
      // receipt e os artefatos na fonte são da rota local (`uninstall
      // <nome>` sem --method), que preserva o diretório-fonte.
      local: receipt?.method === 'local',
      // Órfão de crash (venv/dir presente sem entrada no state) também é
      // removível — senão a instalação incompleta ficaria sem reparo:
      // install recusa ('incomplete') e uninstall diria "não instalada".
      installed:
        receipt?.method !== 'local' &&
        (installed.includes(name) || installConsistency(home, name).status === 'orphaned'),
    });
  }
  const unknown = [...plan.filter((p) => !p.known).map((p) => p.name), ...unsafe];
  const errText = [
    ...plan.filter((p) => !p.known).map((p) => `${p.name}: sem dist no catálogo registry`),
    ...unsafe.map((u) => `${u}: nome inseguro no state — recusado (path traversal)`),
  ].join(' | ');
  const removals = plan.filter((p) => p.installed);
  const skipped = plan.filter((p) => p.known && !p.installed && !p.local).map((p) => p.name);
  warnings.push(...skipped.map((n) => `${n}: não estava instalado via registry — ignorado`));
  warnings.push(
    ...plan
      .filter((p) => p.local)
      .map(
        (p) =>
          `${p.name}: instalada via fonte local — use \`uninstall ${p.name}\` sem --method (preserva a fonte)`,
      ),
  );
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
  // --plan/--check: o plano já foi exibido — sai ANTES de --yes/prompt e
  // sem tocar em venv, cache, receipt ou state.
  if (cli.plan || cli.check) {
    const planDoc = {
      method: 'pypi',
      plan: true,
      removals: removals.map((r) => ({ forge: r.name, dist: r.dist ?? null })),
      skipped,
      warnings,
      ...(errText ? { error: errText } : {}),
    };
    reportTo(planDoc);
    if (quiet) emitJson(planDoc, unknown.length ? 2 : 0);
    log.info(S.planDryRunNote);
    if (unknown.length) process.exit(2);
    return;
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
      } else if (op.argv[0] === '{python}' || !receipt || receipt.method === 'local') {
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
    // Lifecycle lock: rm de venv + grava de state serializam contra
    // installs/pins concorrentes. Ocupado = recusa nomeada por Forja.
    const lockRes = await acquireForgeLock(home);
    if (!lockRes.ok) {
      log.error(`${r.name}: ${lockRes.detail}`);
      warnings.push(`${r.name}: ${lockRes.detail}`);
      results.push({
        forge: r.name,
        removed: false,
        cacheRemoved: false,
        ...(native ? { native } : {}),
      });
      continue;
    }
    try {
      const res = registryUninstall({ name: r.name, dist: r.dist }, { home });
      if (res.refused) log.error(`${r.name}: recusado — ${res.refused}`);
      results.push({
        forge: r.name,
        removed: res.removed,
        cacheRemoved: res.cacheRemoved,
        ...(native ? { native } : {}),
      });
    } finally {
      lockRes.lock.release();
    }
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
  /** Resolução falhou (ex.: release alvo yanked/rede) — falha nomeada, não "nada a fazer". */
  failed?: boolean;
}

/** Recibo → entrada de catálogo real ou sintética (ghost-forge). */
function entryFor(name: string, receipt: RegistryInstallReceipt) {
  return registryEntry(name) ?? ghostEntry(name, receipt);
}

/**
 * Escopo compartilhado: resolve alvos → receipts → plano. Recusas de nome
 * inseguro e desconhecidos seguem o mesmo contrato do uninstall.
 * Receipts `method:'local'` (install <dir>) NÃO são alvos registry —
 * viram bucket próprio para o warning explicar a rota correta em vez
 * do falso "não estava instalado via registry".
 */
function lifecycleTargets(
  cli: CliOptions,
  names: string[],
  home: string,
): { ok: LifecycleTarget[]; unknown: string[]; skipped: string[]; local: string[] } {
  const state = loadForgeState(home).forges;
  const targets = resolveRegistryTargets(cli, names, Object.keys(state));
  const ok: LifecycleTarget[] = [];
  const unknown: string[] = [];
  const skipped: string[] = [];
  const local: string[] = [];
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
    if (receipt.method === 'local') {
      local.push(name);
      continue;
    }
    ok.push({ name, receipt });
  }
  return { ok, unknown, skipped, local };
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
  const installed = Object.keys(loadForgeState(home).forges);
  const isCheck = cli.plan || cli.check;
  // `update --check` sem seleção cobre TODAS as instaladas via registry —
  // leitura pura, mesmo contrato do `update --check` git que varre os
  // clones. Sem isso o E2E 11.2.1 via "nenhuma Forja instalada" mesmo
  // com receipts presentes.
  const wanted = isCheck && !names.length && !cli.only?.length && !cli.all ? installed : names;
  const { ok: targets, unknown, skipped, local } = lifecycleTargets(cli, wanted, home);
  if (!targets.length && !skipped.length && !unknown.length && !local.length) {
    if (isCheck) {
      // Check sem alvo não é erro: estado vazio reportado com honestidade.
      const doc = { method: 'pypi', plan: true, updates: [], skipped: [], warnings: [] };
      reportTo(doc);
      if (quiet) emitJson(doc, 0);
      note('nenhuma Forja instalada via registry — nada a verificar', 'Plano de update');
      return;
    }
    // Instaladas existem mas nenhuma foi selecionada: erro nomeado que
    // diz COMO selecionar — nunca a mensagem falsa "nenhuma instalada".
    const msg = installed.length
      ? S.errRegistryUpdateNeedsNames
      : 'nenhuma Forja instalada via registry — nada a atualizar';
    reportTo({ error: msg });
    if (quiet) emitJson({ error: msg }, 2);
    log.error(msg);
    process.exit(2);
    return;
  }
  const ignored = ignoredRegistryFlags(cli);
  const warnings: string[] = [
    ...skipped.map((n) => `${n}: não estava instalado via registry — ignorado`),
    ...local.map(
      (n) =>
        `${n}: instalada via fonte local — verbos registry não se aplicam (use \`update <dir>\` ou \`uninstall ${n}\` sem --method)`,
    ),
    ...(ignored.length ? [`${S.registryIgnoredFlags}: ${ignored.join(', ')}`] : []),
  ];

  const pinVersion = cli.ref?.replace(/^v(?=\d)/, '');
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
      ephemeral: isCheck, // P0-002: update --check não persiste nem cache
    });
    if ('kind' in resolved) {
      items.push({
        ...t,
        entry,
        action: 'update',
        from: t.receipt.version,
        detail: describeResolveError(resolved),
        failed: true,
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
    const failed = items.filter((i) => i.failed);
    const doc = {
      method: 'pypi',
      updated: [],
      skipped,
      warnings,
      // Falha de resolução (alvo yanked, rede, hash) é recusa nomeada —
      // nunca "nada a atualizar" com exit 0 silencioso.
      ...(failed.length
        ? { failed: failed.map((i) => ({ forge: i.name, detail: i.detail })) }
        : {}),
      ...(unknown.length ? { error: `${unknown.join(', ')}: sem dist no catálogo registry` } : {}),
    };
    reportTo(doc);
    if (quiet)
      emitJson(
        doc,
        unknown.length ? 2 : failed.length || (skipped.length && !items.length) ? 1 : 0,
      );
    if (!quiet) log.info('Nada a atualizar.');
    if (unknown.length) process.exit(2);
    if (failed.length) process.exit(1);
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

  const { pythons, refusal } = await registryPythons(cli, deps.pythons);
  if (refusal) {
    const msg = `${refusal.code}: ${refusal.cause}`;
    reportTo({ error: msg, code: refusal.code });
    if (quiet) emitJson({ error: msg }, 1);
    log.error(msg);
    log.info(`→ ${refusal.remedy}`);
    process.exit(1);
  }
  const results = [];
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
      receiptPatch: (r) => {
        // histórico: versão anterior entra no topo — rollback desempilha.
        // No patch (antes das escritas atômicas) um crash pós-pip não
        // perde o histórico nem deixa install.json divergente do state.
        r.history = [
          ...(i.receipt.history ?? []),
          { version: i.from, installedAt: i.receipt.installedAt },
        ];
        // `--ref` é override pontual — não cria nem remove pin.
        r.pinned = i.receipt.pinned;
      },
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
    receipt.native = await delegateNative(cli, i.entry, receipt, 'update', deps.run);
    if (receipt.native?.skipped) warnings.push(`${i.name}: ${receipt.native.skipped}`);
    if (receipt.native?.ran && receipt.native.exitCode !== 0)
      warnings.push(`${i.name}: instalador nativo saiu ${receipt.native.exitCode}`);
    // `native` chega depois do install — repersiste receipt + state juntos.
    if (receipt.native) await persistReceipt(home, receipt);
    if (!quiet) spin.stop(`${i.name}: ${theme.ok(`${i.from} → ${i.to}`)}`);
    results.push({ forge: i.name, ok: true, from: i.from, to: i.to, bin: receipt.bin });
  }
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
  const { ok: targets, unknown, skipped, local } = lifecycleTargets(cli, names, home);
  const ignored = ignoredRegistryFlags(cli);
  const warnings = [
    ...skipped.map((n) => `${n}: não instalado via registry — ignorado`),
    ...local.map((n) => `${n}: instalada via fonte local — use \`reinstall ${n}\` sem --method`),
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
  const { pythons, refusal } = await registryPythons(cli, deps.pythons);
  if (refusal) {
    const msg = `${refusal.code}: ${refusal.cause}`;
    reportTo({ error: msg, code: refusal.code });
    if (quiet) emitJson({ error: msg }, 1);
    log.error(msg);
    log.info(`→ ${refusal.remedy}`);
    process.exit(1);
  }
  const results = [];
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
      receiptPatch: (r) => {
        // Preserva pin e histórico — reinstall não é lifecycle de versão.
        r.pinned = t.receipt.pinned;
        r.history = t.receipt.history;
      },
    });
    if ('stage' in receipt) {
      if (!quiet) spin.stop(`${t.name}: ${theme.err('falhou')} (${describeInstallError(receipt)})`);
      results.push({ forge: t.name, ok: false, detail: describeInstallError(receipt) });
      continue;
    }
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
    if (receipt.native) await persistReceipt(home, receipt);
    if (!quiet) spin.stop(`${t.name}: ${theme.ok('reinstalado')} (${receipt.version})`);
    results.push({ forge: t.name, ok: true, version: receipt.version, bin: receipt.bin });
  }
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
  const { ok: targets, unknown, skipped, local } = lifecycleTargets(cli, names, home);
  const ignored = ignoredRegistryFlags(cli);
  const warnings = [
    ...skipped.map((n) => `${n}: não instalado via registry — ignorado`),
    ...local.map((n) => `${n}: instalada via fonte local — rollback de versão não se aplica`),
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
  const { pythons, refusal } = await registryPythons(cli, deps.pythons);
  if (refusal) {
    const msg = `${refusal.code}: ${refusal.cause}`;
    reportTo({ error: msg, code: refusal.code });
    if (quiet) emitJson({ error: msg }, 1);
    log.error(msg);
    log.info(`→ ${refusal.remedy}`);
    process.exit(1);
  }
  const results = [];
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
      receiptPatch: (r) => {
        // Desempilha o alvo e empilha a versão abandonada — rollback de
        // rollback funciona. No patch, history/pinned entram nas escritas
        // atômicas do próprio install: um crash pós-pip não deixa
        // state/install.json sem o histórico restaurado.
        const rest = (p.receipt.history ?? []).slice(0, -1);
        r.history = [...rest, { version: p.receipt.version, installedAt: p.receipt.installedAt }];
        r.pinned = p.receipt.pinned;
      },
    });
    if ('stage' in receipt) {
      if (!quiet) spin.stop(`${p.name}: ${theme.err('falhou')} (${describeInstallError(receipt)})`);
      results.push({ forge: p.name, ok: false, detail: describeInstallError(receipt) });
      continue;
    }
    if (!quiet) spin.stop(`${p.name}: ${theme.ok(`${p.receipt.version} → ${p.to}`)}`);
    results.push({ forge: p.name, ok: true, from: p.receipt.version, to: p.to, bin: receipt.bin });
  }
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
  // `unpin --ref/--version` não tem sentido — a trava sempre cai por
  // inteiro; flag ignorada seria mentira (mesmo contrato do unpin git).
  // No pin, `--version` é honrada: deve igualar a versão INSTALADA —
  // divergente vira recusa nomeada por Forja (validada mais abaixo).
  if (!pin && cli.ref !== undefined) {
    const msg = `unpin --method registry não aceita --ref/--version — remove a trava existente`;
    reportTo({ error: msg });
    if (quiet) emitJson({ error: msg }, 2);
    log.error(msg);
    process.exit(2);
    return;
  }
  const { ok: targets, unknown, skipped, local } = lifecycleTargets(cli, names, home);
  const ignored = ignoredRegistryFlags(cli);
  const warnings = [
    ...skipped.map((n) => `${n}: não instalado via registry — ignorado`),
    ...local.map((n) => `${n}: instalada via fonte local — pin registry não se aplica`),
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
  // --plan/--check: mostra exatamente o que o pin/unpin gravaria no
  // state — ZERO mutação (era o bug real: --plan era ignorado e o
  // state.json era reescrito).
  if (cli.plan || cli.check) {
    const planned = targets.map((t) => ({
      forge: t.name,
      pinned: pin ? t.receipt.version : null,
      current: t.receipt.pinned ?? null,
    }));
    const doc = {
      method: 'pypi',
      plan: true,
      [pin ? 'pinned' : 'unpinned']: planned,
      skipped,
      warnings,
      ...(unknown.length ? { error: `${unknown.join(', ')}: sem dist no catálogo registry` } : {}),
    };
    reportTo(doc);
    if (quiet) emitJson(doc, unknown.length ? 2 : 0);
    note(
      planned
        .map((p) =>
          pin
            ? `${p.forge} → pin ${p.pinned}${p.current ? ` (atual: ${p.current})` : ''}`
            : `${p.forge} → unpin${p.current ? ` (atual: ${p.current})` : ' (não estava fixada)'}`,
        )
        .join('\n'),
      S.registryPinPlanTitle,
    );
    log.info(S.planDryRunNote);
    if (unknown.length) process.exit(2);
    return;
  }
  // `--version X` no registry fixa a versão INSTALADA — pedir outra criaria
  // um pin que não corresponde ao receipt: recusa honesta por Forja em vez
  // de ignorar o argumento silenciosamente.
  const want = pin ? cli.ref?.replace(/^v(?=\d)/, '') : undefined;
  // load→mutate→save sob o lifecycle lock: um install/uninstall
  // concorrente não pode perder a atualização do pin.
  const lockRes = await acquireForgeLock(home);
  if (!lockRes.ok) {
    reportTo({ error: lockRes.detail });
    if (quiet) emitJson({ error: lockRes.detail }, 1);
    log.error(lockRes.detail);
    process.exit(1);
    return;
  }
  const done = [];
  const failed: { forge: string; detail: string }[] = [];
  try {
    const state = loadForgeState(home);
    for (const t of targets) {
      // Receipt pode ter sido removido entre o escopo e o lock — o
      // re-cheque own-property evita recriar entrada apagada.
      const cur = Object.hasOwn(state.forges, t.name) ? state.forges[t.name] : undefined;
      if (!cur) {
        warnings.push(`${t.name}: removido enquanto o lock era aguardado — ignorado`);
        continue;
      }
      if (pin && want && t.receipt.version !== want) {
        failed.push({
          forge: t.name,
          detail: `${S.errPinVersionMismatch} (instalada ${t.receipt.version} ≠ ${want})`,
        });
        continue;
      }
      if (pin) {
        cur.pinned = t.receipt.version;
        done.push({ forge: t.name, pinned: t.receipt.version });
      } else {
        delete cur.pinned;
        done.push({ forge: t.name, pinned: null });
      }
    }
    saveForgeState(home, state);
  } finally {
    lockRes.lock.release();
  }
  const doc = {
    method: 'pypi',
    [pin ? 'pinned' : 'unpinned']: done,
    ...(failed.length ? { failed } : {}),
    skipped,
    warnings,
    ...(unknown.length ? { error: `${unknown.join(', ')}: sem dist no catálogo registry` } : {}),
  };
  reportTo(doc);
  // Precedência igual à saída humana: falha operacional (pin em versão
  // divergente) → 1; só restam desconhecidos → 2 (erro de uso).
  if (quiet) emitJson(doc, failed.length ? 1 : unknown.length ? 2 : 0);
  for (const d of done) {
    log.success(pin ? `${d.forge}: ${S.pinDone} ${d.pinned}` : `${d.forge}: ${S.unpinDone}`);
  }
  for (const f of failed) log.error(`${f.forge}: ${f.detail}`);
  if (failed.length) process.exit(1);
  if (unknown.length) process.exit(2);
}
