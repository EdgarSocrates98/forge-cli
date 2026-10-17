/**
 * Instalação registry-first: venv isolada por Forja em
 * `~/.forge-cli/forges/<nome>/`, `pip install` pinado na versão resolvida,
 * verify do console script e receipt auditável — tudo com runner/fetch
 * injetáveis para teste determinístico.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import type { RegistryEntry } from './catalog.js';
import { resolveRelease, type FetchLike, type ResolveError, type ResolvedRelease } from './pypi.js';
import {
  compareVersions,
  parseVersion,
  satisfiesRequiresPython,
  type ParsedVersion,
} from './versions.js';

export interface RegistryInstallReceipt {
  forge: string;
  method: 'pypi';
  dist: string;
  version: string;
  requiresPython?: string;
  python: string;
  source: ResolvedRelease['source'];
  venv: string;
  bin: string;
  installedAt: string;
  verify: { command: string[]; ok: boolean };
  files: { filename: string; sha256?: string; packagetype?: string }[];
}

export interface ForgeState {
  forges: Record<string, RegistryInstallReceipt>;
}

export function forgesRoot(home: string): string {
  return path.join(home, '.forge-cli', 'forges');
}

export function forgeStatePath(home: string): string {
  return path.join(forgesRoot(home), 'state.json');
}

export function forgeVenv(home: string, name: string): string {
  return path.join(forgesRoot(home), name, 'venv');
}

export function receiptPath(home: string, name: string): string {
  return path.join(forgesRoot(home), name, 'install.json');
}

export function loadForgeState(home: string): ForgeState {
  try {
    const raw = JSON.parse(readFileSync(forgeStatePath(home), 'utf8')) as ForgeState;
    return typeof raw.forges === 'object' && raw.forges ? raw : { forges: {} };
  } catch {
    return { forges: {} };
  }
}

function saveForgeState(home: string, state: ForgeState): void {
  mkdirSync(forgesRoot(home), { recursive: true });
  writeFileSync(forgeStatePath(home), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function venvBin(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.join(venvDir, 'Scripts') : path.join(venvDir, 'bin');
}

export function venvPython(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(venvBin(venvDir, platform), platform === 'win32' ? 'python.exe' : 'python');
}

export interface RunResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}
export type RunLike = (cmd: string, args: string[]) => Promise<RunResult>;

async function execaRun(cmd: string, args: string[]): Promise<RunResult> {
  const res = await execa(cmd, args, { reject: false });
  return { exitCode: res.exitCode ?? 1, stdout: res.stdout, stderr: res.stderr };
}

export interface ProbedInterpreter {
  exe: string[];
  version: string;
  parsed: ParsedVersion;
}

export interface RegistryInstallDeps {
  run?: RunLike;
  home: string;
  cacheDir: string;
  offline?: boolean;
  /** Interpretadores detectados; o mais novo que satisfaz requires_python vence. */
  pythons: ProbedInterpreter[];
  /** Injetável em testes; default = PyPI real. */
  fetchImpl?: FetchLike;
  platform?: NodeJS.Platform;
  now?: () => string;
}

export type InstallError =
  | { stage: 'resolve'; error: ResolveError }
  | { stage: 'no-python'; detail: string }
  | { stage: 'venv'; detail: string }
  | { stage: 'pip'; detail: string }
  | { stage: 'verify'; detail: string };

export async function registryInstall(
  entry: RegistryEntry,
  pin: string | undefined,
  deps: RegistryInstallDeps,
): Promise<RegistryInstallReceipt | InstallError> {
  const run = deps.run ?? execaRun;
  const platform = deps.platform ?? process.platform;
  if (!deps.pythons.length) {
    return { stage: 'no-python', detail: 'nenhum interpretador Python detectado' };
  }

  const resolved = await resolveRelease(entry.dist, {
    pin,
    offline: deps.offline,
    cacheDir: deps.cacheDir,
    fetchImpl: deps.fetchImpl,
  });
  if ('kind' in resolved) return { stage: 'resolve', error: resolved };

  // Seleciona o interpretador mais novo que satisfaz requires_python (+ piso do catálogo).
  const floor = parseVersion(entry.minPython);
  const usable = deps.pythons.filter((p) => {
    if (floor && compareVersions(p.parsed, floor) < 0) return false;
    if (!resolved.requiresPython) return true;
    return satisfiesRequiresPython(resolved.requiresPython, p.parsed) === true;
  });
  if (!usable.length) {
    return {
      stage: 'resolve',
      error: {
        kind: 'python-incompatible',
        dist: entry.dist,
        version: resolved.version,
        requires: resolved.requiresPython ?? `>=${entry.minPython}`,
        have: deps.pythons.map((p) => p.version).join(', '),
      },
    };
  }
  const python = usable[0];

  const venvDir = forgeVenv(deps.home, entry.name);
  const venv = await run(python.exe[0], [...python.exe.slice(1), '-m', 'venv', venvDir]);
  if (venv.exitCode !== 0) {
    return { stage: 'venv', detail: venv.stderr ?? venv.stdout ?? 'falha ao criar venv' };
  }

  const vpy = venvPython(venvDir, platform);
  const spec = `${entry.dist}==${resolved.version}`;
  const pipArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', spec];
  const pip = await run(vpy, pipArgs);
  if (pip.exitCode !== 0) {
    return { stage: 'pip', detail: (pip.stderr ?? pip.stdout ?? 'falha no pip install').trim() };
  }

  const binPath = path.join(
    venvBin(venvDir, platform),
    platform === 'win32' ? `${entry.bin}.exe` : entry.bin,
  );
  const verifyCmd = [binPath, '--help'];
  const verify = await run(binPath, ['--help']);

  const receipt: RegistryInstallReceipt = {
    forge: entry.name,
    method: 'pypi',
    dist: entry.dist,
    version: resolved.version,
    requiresPython: resolved.requiresPython,
    python: python.version,
    source: resolved.source,
    venv: venvDir,
    bin: binPath,
    installedAt: (deps.now ?? (() => new Date().toISOString()))(),
    verify: { command: verifyCmd, ok: verify.exitCode === 0 },
    files: resolved.files.map((f) => ({
      filename: f.filename,
      sha256: f.sha256,
      packagetype: f.packagetype,
    })),
  };

  mkdirSync(path.dirname(receiptPath(deps.home, entry.name)), { recursive: true });
  writeFileSync(
    receiptPath(deps.home, entry.name),
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8',
  );
  const state = loadForgeState(deps.home);
  state.forges[entry.name] = receipt;
  saveForgeState(deps.home, state);

  if (verify.exitCode !== 0) {
    return { stage: 'verify', detail: `${entry.bin} --help saiu com código ${verify.exitCode}` };
  }
  return receipt;
}

export interface RegistryUninstallDeps {
  home: string;
  platform?: NodeJS.Platform;
}

export function registryUninstall(
  entry: RegistryEntry,
  deps: RegistryUninstallDeps,
): { removed: boolean; receiptRemoved: boolean } {
  const dir = path.join(forgesRoot(deps.home), entry.name);
  const removed = existsSync(dir);
  if (removed) rmSync(dir, { recursive: true, force: true });
  const state = loadForgeState(deps.home);
  const hadReceipt = Boolean(state.forges[entry.name]);
  delete state.forges[entry.name];
  saveForgeState(deps.home, state);
  return { removed, receiptRemoved: hadReceipt };
}
