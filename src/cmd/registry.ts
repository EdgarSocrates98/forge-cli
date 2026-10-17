/**
 * `install --method registry` — instalação registry-first via PyPI.
 * Resolve names → catálogo, escolhe o melhor interpretador que satisfaz
 * `requires_python`, cria venv isolada por Forja e grava receipt.
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { confirm, isCancel } from '@clack/prompts';
import { log, note, outro, spinner } from '@clack/prompts';
import type { CliOptions } from '../cli-args.js';
import { exitCancelled } from '../prompts.js';
import { pythonCandidates } from '../preflight.js';
import { registryEntry, REGISTRY_PACKAGES } from '../registry/catalog.js';
import {
  loadForgeState,
  registryInstall,
  registryUninstall,
  type InstallError,
} from '../registry/install.js';
import type { ResolveError } from '../registry/pypi.js';
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

const REGISTRY_IGNORED_FLAGS: [keyof CliOptions, string][] = [
  ['dir', '--dir'],
  ['profile', '--profile'],
  ['scope', '--scope'],
  ['components', '--components'],
  ['host', '--host'],
  ['native', '--native'],
  ['skipVerify', '--skip-verify'],
  ['retryFailed', '--retry-failed'],
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

export async function runRegistryInstall(
  cli: CliOptions,
  names: string[],
  deps: { home?: string; pythons?: ProbedPython[] } = {},
): Promise<RegistryInstallResult[]> {
  const home = deps.home ?? os.homedir();
  const quiet = cli.jsonReport;
  const entries = names.map((n) => ({ name: n, entry: registryEntry(n) }));
  const unknown = entries.filter((e) => !e.entry);
  if (unknown.length) {
    for (const u of unknown) {
      log.error(`${u.name}: sem dist no catálogo registry — use o método git`);
    }
    process.exit(2);
  }

  const ignored = ignoredRegistryFlags(cli);
  if (ignored.length && !quiet) {
    log.warn(`${S.registryIgnoredFlags}: ${ignored.join(', ')}`);
  }

  const pythons = deps.pythons ?? (await probePythons());
  if (!pythons.length) {
    log.error('Nenhum interpretador Python detectado — instale Python ≥3.10');
    process.exit(1);
  }
  if (!quiet) log.info(`Python detectado: ${pythons.map((p) => p.version).join(', ')}`);

  const results: RegistryInstallResult[] = [];
  for (const { name, entry } of entries) {
    const spin = spinner();
    if (!quiet) spin.start(`${name}: resolvendo ${entry!.dist}…`);
    const receipt = await registryInstall(entry!, cli.ref, {
      home,
      cacheDir: registryCacheDir(home),
      offline: cli.offline,
      pythons,
    });
    if ('stage' in receipt) {
      if (!quiet) spin.stop(`${name}: ${theme.err('falhou')}`);
      results.push({ forge: name, ok: false, detail: describeInstallError(receipt) });
      continue;
    }
    if (receipt.staleCache && !quiet) log.warn(`${S.registryStaleCache} (${entry!.dist})`);
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

  if (cli.jsonReport) {
    emitJson({ method: 'pypi', results }, results.every((r) => r.ok) ? 0 : 1);
  }
  for (const r of results) {
    if (!r.ok) log.error(`${r.forge}: ${r.detail}`);
  }
  if (results.some((r) => !r.ok)) process.exit(1);
  outro(`${icons.ok} instalação registry-first concluída`);
  return results;
}

export function runRegistryList(cli: CliOptions, deps: { home?: string } = {}): void {
  const home = deps.home ?? os.homedir();
  const state = loadForgeState(home);
  const rows = REGISTRY_PACKAGES.map((e) => {
    const inst = state.forges[e.name];
    return {
      forge: e.name,
      dist: e.dist,
      installed: inst?.version ?? null,
      method: inst?.method ?? null,
      verifyOk: inst ? inst.verify.ok : null,
      bin: inst ? (existsSync(inst.bin) ? inst.bin : `${inst.bin} (ausente)`) : null,
      minPython: e.minPython,
    };
  });
  if (cli.jsonReport) emitJson({ forges: rows });
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
  const installed = Object.keys(loadForgeState(home).forges);
  const targets = resolveRegistryTargets(cli, names, installed);
  if (!targets.length) {
    log.error(S.errRegistryUninstallNeedsNames);
    process.exit(2);
  }
  const plan = targets.map((name) => ({
    name,
    entry: registryEntry(name),
    installed: installed.includes(name),
  }));
  const unknown = plan.filter((p) => !p.entry);
  for (const u of unknown) log.error(`${u.name}: sem dist no catálogo registry`);
  const removals = plan.filter((p) => p.entry && p.installed);
  const skipped = plan.filter((p) => p.entry && !p.installed);
  for (const sk of skipped) log.warn(`${sk.name}: não estava instalado via registry — ignorado`);
  if (!removals.length) {
    if (unknown.length) process.exit(2);
    log.info('Nada a remover.');
    return;
  }

  if (!cli.jsonReport) {
    note(
      removals
        .map((r) => `${r.name} → ${r.entry!.dist} (venv + receipt em ~/.forge-cli/forges/)`)
        .join('\n'),
      S.registryUninstallConfirm,
    );
  }
  if (!cli.yes) {
    if (cli.jsonReport) {
      emitJson({ error: S.registryUninstallNeedsYes, planned: removals.map((r) => r.name) }, 2);
    }
    const answer = await confirm({ message: S.registryUninstallConfirm });
    if (isCancel(answer) || !answer) {
      if (isCancel(answer)) exitCancelled();
      log.warn(S.registryUninstallNeedsYes);
      process.exit(0);
    }
  }

  const results = removals.map((r) => {
    const res = registryUninstall(r.entry!, { home });
    return { forge: r.name, removed: res.removed };
  });
  if (cli.jsonReport) emitJson({ method: 'pypi', results });
  for (const r of results) {
    if (r.removed) log.success(`${r.forge}: removido`);
  }
}
