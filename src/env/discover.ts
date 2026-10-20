/**
 * Descoberta de ambiente agregada — `forge/EnvironmentDiscovery/v1`
 * (ciclo 12.1, lf-0016; é o "Preflight 2.0" do plano).
 *
 * Um documento só, determinístico e offline, que responde quatro perguntas
 * antes de qualquer mutação:
 *
 *   - o que a máquina EXECUTA (shells verificadas por sonda, nunca por
 *     existência — WSL reportado, jamais rota nativa);
 *   - por onde o setup ENTRA (route: powershell → pwsh → git_bash →
 *     FORGE-SHELL-NOT-FOUND; POSIX = sh);
 *   - onde a instalação ESCREVE (write_targets na prioridade flag > env >
 *     usuário > sistema, com FORGE-INSTALL-PERMISSION-DENIED + alternativa);
 *   - o que falta TODA VEZ (blockers[]/warnings[]/recommendations[] —
 *     agregado nunca para no primeiro bloqueio).
 *
 * Nenhum probe toca a rede (`network.status` é declaração, não sonda) e
 * todo spawn é inofensivo com timeout ≤ 5 s. O resumo de Python sai do
 * probe `pythonCandidates` já existente — o pipeline completo é lf-0017.
 */
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import type { ForgeErrorCode } from '../errors.js';
import { isNodeSupported, pythonInfo, pythonToolchain, type PythonInfo } from '../preflight.js';
import { loadForgeState, type ForgeState } from '../registry/install.js';
import { cliHome, commandOutput, type CommandProbeResult } from '../utils/system.js';
import { resolveWriteTargets, type WriteTarget } from './paths.js';
import {
  discoverShells,
  windowsRoute,
  type ShellDeps,
  type ShellDiscovery,
  type ShellRefusal,
} from './shells.js';

export const ENVIRONMENT_DISCOVERY_SCHEMA = 'forge/EnvironmentDiscovery/v1' as const;

/** Achado do agregado — blocker impede instalação; warning degrada. */
export interface EnvFinding {
  id: string;
  code?: ForgeErrorCode;
  message: string;
  remedy?: string | null;
}

export interface EnvironmentDiscovery {
  schema: typeof ENVIRONMENT_DISCOVERY_SCHEMA;
  generated_at: string;
  status: 'ok' | 'warnings' | 'blocked';
  os: { platform: string; arch: string; release: string };
  shells: ShellDiscovery;
  route: {
    platform: string;
    selected: 'powershell' | 'pwsh' | 'git_bash' | 'sh' | 'none';
    shell: string | null;
    /** Arquivos procurados nessa rota, na ordem da cadeia. */
    script_chain: string[];
    refusal?: ShellRefusal;
  };
  python: {
    present: boolean;
    exe: string | null;
    args: string[];
    version: string | null;
    toolchain: string | null;
    /** Sonda usada hoje — pipeline completo fica para lf-0017. */
    source: 'pythonCandidates';
    pipeline: string;
  };
  git: { present: boolean; version: string | null; executable: string | null };
  /** Declaração, nunca sonda: 'off' = --offline do chamador, senão 'unknown'. */
  network: { status: 'off' | 'unknown'; probed: false; detail: string };
  disk: { candidates: { path: string; writable: boolean | null }[] };
  permissions: {
    home_writable: boolean | null;
    tmpdir_writable: boolean | null;
    /** Nomes dos write_targets com escrita negada. */
    denied: string[];
  };
  write_targets: WriteTarget[];
  forges_detected: {
    count: number;
    names: string[];
    by_method: { local: number; pypi: number; unknown: number };
  };
  blockers: EnvFinding[];
  warnings: EnvFinding[];
  recommendations: EnvFinding[];
}

export interface DiscoverDeps extends ShellDeps {
  /** Home do estado forge-cli (state/receipts) — default `cliHome()`. */
  home?: string;
  /** Workspace resolvido do chamador (--dir) → tier 'explicit' dos alvos de workspace. */
  workspace?: string;
  osHome?: string;
  cwd?: string;
  tmpDir?: string;
  writable?: (dir: string) => boolean;
  /** Overrides do tier 'explicit' (flags do chamador). */
  explicit?: { home?: string; binDir?: string; forgesDir?: string; workspaceDir?: string };
  now?: () => string;
  /** --offline do chamador → network.status 'off'. */
  offline?: boolean;
  pythonProbe?: (platform: NodeJS.Platform) => Promise<PythonInfo | null>;
  toolchainProbe?: (platform: NodeJS.Platform) => Promise<string | null>;
  gitProbe?: () => Promise<CommandProbeResult | null>;
  forgesProbe?: (home: string) => ForgeState;
  arch?: string;
  release?: string;
  nodeVersion?: string;
}

const WIN_PS_CHAIN = ['setup.ps1', 'install.ps1'];
const WIN_BASH_CHAIN = ['install.windows.sh', 'setup.sh', 'install.sh'];
const POSIX_CHAIN = ['setup.sh', 'install.sh'];

function routeOf(platform: NodeJS.Platform, shells: ShellDiscovery): EnvironmentDiscovery['route'] {
  if (platform !== 'win32') {
    return {
      platform,
      selected: 'sh',
      shell: 'sh',
      script_chain: POSIX_CHAIN,
    };
  }
  const route = windowsRoute(shells);
  if (route.route === 'none') {
    return {
      platform,
      selected: 'none',
      shell: null,
      script_chain: [],
      refusal: route.refusal,
    };
  }
  const chain =
    route.route === 'git_bash'
      ? WIN_BASH_CHAIN
      : [...WIN_PS_CHAIN, ...(route.bash ? WIN_BASH_CHAIN : [])];
  return {
    platform,
    selected: route.route,
    shell: route.route === 'git_bash' ? (route.bash ?? null) : (route.ps ?? null),
    script_chain: chain,
  };
}

/** Achados derivados dos alvos de escrita — um blocker por alvo negado. */
function targetFindings(targets: WriteTarget[]): EnvFinding[] {
  const findings: EnvFinding[] = [];
  for (const target of targets) {
    if (!target.denied) continue;
    findings.push({
      id: `write-target:${target.name}`,
      code: 'FORGE-INSTALL-PERMISSION-DENIED',
      message: target.denied.cause,
      remedy: target.denied.remedy,
    });
  }
  return findings;
}

/**
 * Compõe o relatório agregado — NUNCA para no primeiro bloqueio: todos os
 * checks rodam, cada falha vira um item em blockers[]/warnings[].
 */
export async function discoverEnvironment(deps: DiscoverDeps = {}): Promise<EnvironmentDiscovery> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? cliHome();
  const shells = await discoverShells(deps);
  const route = routeOf(platform, shells);
  const targets = resolveWriteTargets({
    env: deps.env,
    osHome: deps.osHome,
    cwd: deps.cwd,
    tmpDir: deps.tmpDir,
    exists: deps.exists,
    writable: deps.writable,
    explicit: {
      home: deps.explicit?.home,
      binDir: deps.explicit?.binDir,
      forgesDir: deps.explicit?.forgesDir,
      workspaceDir: deps.workspace ?? deps.explicit?.workspaceDir,
    },
  });

  const gitProbe = deps.gitProbe
    ? await deps.gitProbe()
    : { output: await commandOutput('git', ['--version']), timedOut: false };
  const git = {
    present: gitProbe !== null && !gitProbe.timedOut && gitProbe.output !== null,
    version: gitProbe?.output ?? null,
    executable: gitProbe?.output ? 'git' : null,
  };

  const py = await (deps.pythonProbe ?? pythonInfo)(platform);
  const toolchain = await (deps.toolchainProbe ?? pythonToolchain)(platform);
  const forges = (deps.forgesProbe ?? loadForgeState)(home).forges;
  const names = Object.keys(forges).sort();
  const byMethod = { local: 0, pypi: 0, unknown: 0 };
  for (const name of names) {
    const method = forges[name]?.method;
    if (method === 'local') byMethod.local += 1;
    else if (method === 'pypi') byMethod.pypi += 1;
    else byMethod.unknown += 1;
  }

  const deniedTargets = targets.filter((t) => t.denied !== null);
  const diskCandidates: { path: string; writable: boolean | null }[] = [];
  const seenChecked = new Set<string>();
  for (const target of targets) {
    if (!target.checked || seenChecked.has(target.checked)) continue;
    seenChecked.add(target.checked);
    diskCandidates.push({ path: target.checked, writable: target.writable });
  }
  const tmpdir = deps.tmpDir ?? os.tmpdir();
  const writableDir =
    deps.writable ??
    ((dir: string): boolean => {
      try {
        accessSync(dir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });
  let tmpdirWritable: boolean | null;
  try {
    tmpdirWritable = writableDir(tmpdir);
  } catch {
    tmpdirWritable = null;
  }

  const blockers: EnvFinding[] = [];
  const warnings: EnvFinding[] = [];
  const recommendations: EnvFinding[] = [];

  if (!git.present) {
    blockers.push({
      id: 'git',
      message: 'git não executa — clone/pull indisponíveis',
      remedy: 'instale git (winget install Git.Git, apt install git ou brew install git)',
    });
  }
  const nodeVersion = deps.nodeVersion ?? process.version;
  if (!isNodeSupported(nodeVersion)) {
    blockers.push({
      id: 'node',
      message: `Node.js >= 20 exigido — encontrado ${nodeVersion}`,
      remedy: 'atualize o Node.js para a LTS atual (https://nodejs.org)',
    });
  }
  if (route.refusal) {
    blockers.push({
      id: 'shell-route',
      code: route.refusal.code,
      message: route.refusal.cause,
      remedy: route.refusal.remedy,
    });
  }
  blockers.push(...targetFindings(targets));
  if (tmpdirWritable === false) {
    blockers.push({
      id: 'tmpdir',
      code: 'FORGE-INSTALL-PERMISSION-DENIED',
      message: `tmpdir sem escrita: ${tmpdir}`,
      remedy: 'defina TMPDIR para um diretório gravável — logs e staging dependem dele',
    });
  }

  if (!py) {
    warnings.push({
      id: 'python',
      message:
        'nenhum interpretador Python encontrado via pythonCandidates — método registry indisponível',
      remedy: 'instale Python 3.10+ (python.org, pyenv ou winget install Python.Python.3.13)',
    });
  }
  if (py && !toolchain) {
    warnings.push({
      id: 'python-toolchain',
      message: 'Python presente mas nenhum instalador (pip/pipx/uv) respondeu',
      remedy: 'instale pipx ou habilite `python -m ensurepip`',
    });
  }
  if (platform === 'win32' && !shells.powershell.present && shells.pwsh.present) {
    recommendations.push({
      id: 'pwsh-route',
      message: 'powershell.exe (5.1) ausente — pwsh 7+ conduz a rota .ps1',
      remedy: null,
    });
  }
  if (platform === 'win32' && shells.wsl.present && route.selected === 'git_bash') {
    recommendations.push({
      id: 'wsl-not-route',
      message: 'WSL detectado mas a rota nativa é Git Bash — WSL nunca substitui shell nativo',
      remedy: null,
    });
  }
  if (platform === 'win32' && shells.wsl.present && route.selected === 'none') {
    recommendations.push({
      id: 'wsl-present',
      message:
        'WSL presente mas não é rota de instalação nativa — instale Git for Windows ou PowerShell 7+',
      remedy: null,
    });
  }

  const status = blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warnings' : 'ok';
  return {
    schema: ENVIRONMENT_DISCOVERY_SCHEMA,
    generated_at: (deps.now ?? (() => new Date().toISOString()))(),
    status,
    os: {
      platform,
      arch: deps.arch ?? process.arch,
      release: deps.release ?? os.release(),
    },
    shells,
    route,
    python: {
      present: py !== null,
      exe: py?.exe ?? null,
      args: py?.args ?? [],
      version: py?.version ?? null,
      toolchain,
      source: 'pythonCandidates',
      pipeline: 'lf-0017',
    },
    git,
    network: {
      status: deps.offline ? 'off' : 'unknown',
      probed: false,
      detail: 'rede nunca é sondada pela descoberta — "off" reflete --offline do chamador',
    },
    disk: { candidates: diskCandidates },
    permissions: {
      home_writable: targets.find((t) => t.name === 'home')?.writable ?? null,
      tmpdir_writable: tmpdirWritable,
      denied: deniedTargets.map((t) => t.name),
    },
    write_targets: targets,
    forges_detected: { count: names.length, names, by_method: byMethod },
    blockers,
    warnings,
    recommendations,
  };
}

/** Linhas do resumo humano de `env discover` — mesmo conteúdo, sem JSON. */
export function discoveryLines(report: EnvironmentDiscovery): string[] {
  const shellNames = ['powershell', 'pwsh', 'bash', 'git_bash', 'wsl', 'cygwin', 'msys2'] as const;
  const lines: string[] = [
    `SO: ${report.os.platform} ${report.os.arch} (${report.os.release})`,
    ...shellNames.map((name) => {
      const shell = report.shells[name];
      const detail = shell.present
        ? `${shell.version ?? 'presente'}${shell.kind ? ` [${shell.kind}]` : ''}${shell.executable ? ` — ${shell.executable}` : ''}`
        : 'ausente';
      return `shell ${name}: ${detail}`;
    }),
    `rota: ${report.route.selected}${report.route.shell ? ` (${report.route.shell})` : ''} — ${report.route.script_chain.join(' → ') || 'nenhuma cadeia'}`,
    `python: ${report.python.present ? `${report.python.version} (${report.python.exe})` : 'ausente'} — fonte ${report.python.source}, pipeline ${report.python.pipeline}`,
    `git: ${report.git.present ? (report.git.version ?? 'presente') : 'ausente'}`,
    `rede: ${report.network.status} (nunca sondada)`,
    `alvos graváveis: ${report.write_targets.filter((t) => t.writable !== false).length}/${report.write_targets.length} — negados: ${report.permissions.denied.join(', ') || 'nenhum'}`,
    `forjas detectadas: ${report.forges_detected.count}${report.forges_detected.names.length ? ` (${report.forges_detected.names.join(', ')})` : ''}`,
  ];
  if (report.blockers.length) {
    lines.push('blockers:');
    for (const blocker of report.blockers) {
      lines.push(
        `  ${blocker.code ? `${blocker.code}: ` : ''}${blocker.message}${blocker.remedy ? ` → ${blocker.remedy}` : ''}`,
      );
    }
  }
  if (report.warnings.length) {
    lines.push('avisos:');
    for (const warning of report.warnings) {
      lines.push(`  ${warning.message}${warning.remedy ? ` → ${warning.remedy}` : ''}`);
    }
  }
  for (const rec of report.recommendations) lines.push(`nota: ${rec.message}`);
  lines.push(`status: ${report.status}`);
  return lines;
}

export function pathTargetLines(targets: WriteTarget[]): string[] {
  return targets.flatMap((target) => {
    const mark = target.denied ? '✗' : '✓';
    const via = target.env_var ? ` via ${target.env_var}` : '';
    const write =
      target.writable === false
        ? ' · sem escrita'
        : target.writable === null
          ? ' · sem veredito'
          : '';
    const head = `${mark} ${target.name}: ${target.path} (${target.source}${via}${write})`;
    return target.denied
      ? [head, `    ${target.denied.code}: ${target.denied.cause}`, `    → ${target.denied.remedy}`]
      : [head];
  });
}

export function discoverySchemaId(): string {
  return ENVIRONMENT_DISCOVERY_SCHEMA;
}
