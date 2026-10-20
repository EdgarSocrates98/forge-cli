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
 * todo spawn é inofensivo com timeout ≤ 5 s. A seção `python` é o
 * pipeline universal do lf-0017: estágios FORGE_PYTHON → --python →
 * py-launcher → PATH → venv → managers → plataforma → convencional,
 * cada candidato validado por `--version` executado com veredito
 * FORGE-PYTHON-* — rejeitados permanecem no relatório.
 */
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import type { ForgeErrorCode } from '../errors.js';
import { isNodeSupported, pythonToolchain, type PythonInfo } from '../preflight.js';
import { loadForgeState, type ForgeState } from '../registry/install.js';
import { parseVersion } from '../registry/versions.js';
import { cliHome, commandOutput, commandProbe, type CommandProbeResult } from '../utils/system.js';
import { resolveWriteTargets, type WriteTarget } from './paths.js';
import {
  DEFAULT_PYTHON_FLOOR,
  discoverPythons,
  type ProbedPythonCandidate,
  type PythonDeps,
  type PythonDiscovery,
  type PythonRefusal,
} from './python.js';
import {
  discoverShells,
  windowsRoute,
  type ShellDeps,
  type ShellDiscovery,
  type ShellRefusal,
} from './shells.js';

export const ENVIRONMENT_DISCOVERY_SCHEMA = 'forge/EnvironmentDiscovery/v1' as const;
/** Teto da lista de candidatos no relatório — a descoberta capa em 32. */
export const PYTHON_REPORT_MAX = 24;

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
    /** Origem do selecionado ('env', 'flag', 'venv', 'path', …) ou null. */
    source: string | null;
    /** Por que o selecionado venceu — receipt `selection_reason`. */
    selection_reason: string | null;
    pipeline: 'lf-0017';
    /** Candidatos sondados (após dedup/cap) — os rejeitados ficam listados. */
    candidates_total: number;
    candidates: {
      executable: string;
      source: string;
      version: string | null;
      valid: boolean;
      verdict: string;
      code?: ForgeErrorCode | null;
      note?: string | null;
    }[];
    /** Recusa FORGE-PYTHON-* quando nenhum interpretador é selecionável. */
    refusal: PythonRefusal | null;
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
  /** Pipeline lf-0017 injetável — default `discoverPythons`. */
  pythonDiscovery?: (deps: PythonDeps) => Promise<PythonDiscovery>;
  /**
   * Sonda legada (`{exe,args,version}|null`) — compatibilidade de testes
   * anteriores ao lf-0017; convertida numa descoberta sintética de um
   * único candidato válido (ou recusa FORGE-PYTHON-NOT-FOUND).
   */
  pythonProbe?: (platform: NodeJS.Platform) => Promise<PythonInfo | null>;
  /** `--python` do chamador — entra como estágio 1 do pipeline. */
  pythonExplicit?: string;
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

/**
 * Adapta a sonda legada (`pythonProbe`) a uma PythonDiscovery sintética:
 * um candidato 'path' válido quando ela responde, recusa NOT-FOUND senão.
 * Mantém fixtures de teste anteriores ao lf-0017 funcionando sem tocar
 * no pipeline real.
 */
async function legacyPythonDiscovery(
  platform: NodeJS.Platform,
  probe: (platform: NodeJS.Platform) => Promise<PythonInfo | null>,
): Promise<PythonDiscovery> {
  const info = await probe(platform);
  const version = info?.version.replace(/^Python\s+/i, '') ?? null;
  const parsed = version ? parseVersion(version) : null;
  const base: Pick<PythonDiscovery, 'explicit_requested' | 'floor' | 'floor_known' | 'truncated'> =
    {
      explicit_requested: false,
      floor: DEFAULT_PYTHON_FLOOR,
      floor_known: true,
      truncated: 0,
    };
  if (!info || !version || !parsed) {
    return {
      ...base,
      candidates: [],
      selected: null,
      refusal: {
        code: 'FORGE-PYTHON-NOT-FOUND',
        cause: 'nenhum interpretador Python respondeu à sonda injetada',
        remedy: 'instale Python 3.10+ (python.org ou pyenv/uv)',
      },
    };
  }
  const candidate: ProbedPythonCandidate = {
    argv: [info.exe, ...info.args],
    executable: [info.exe, ...info.args].join(' '),
    source: 'path',
    stage: 3,
    version,
    parsed,
    valid: true,
    verdict: 'ok',
    code: null,
    note: 'sonda legada (pythonProbe injetado)',
  };
  return {
    ...base,
    candidates: [candidate],
    selected: {
      argv: candidate.argv,
      executable: candidate.executable,
      source: candidate.source,
      version,
      parsed,
      selection_reason: 'sonda legada pythonProbe — candidato único injetado',
    },
    refusal: null,
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
  // As três frentes de sonda são independentes entre si — shells, git e o
  // pipeline Python não consomem resultados umas das outras (o toolchain de
  // Python fica depois porque precisa do interpretador selecionado). No
  // Windows cada frente soma dezenas de probes ≤5 s (reg.exe, Program
  // Files, `py`, `where.exe`, shells); rodá-las em paralelo evita a soma
  // serial sem mudar o relatório resultante — mesma máquina → mesmo JSON.
  const [shells, gitProbe, pyDiscovery] = await Promise.all([
    discoverShells(deps),
    deps.gitProbe
      ? deps.gitProbe()
      : commandOutput('git', ['--version']).then((output) => ({ output, timedOut: false })),
    // Pipeline lf-0017 completo — `run`/`exists`/`env`/`platform` são os
    // MESMOS da sonda de shells: um fake único controla a descoberta toda.
    // `pythonProbe` legado (testes pré-lf-0017) vira descoberta sintética.
    deps.pythonDiscovery
      ? deps.pythonDiscovery({
          platform,
          env: deps.env,
          run: deps.run,
          exists: deps.exists,
          osHome: deps.osHome,
          cwd: deps.cwd,
          targetDir: deps.workspace,
          explicit: deps.pythonExplicit,
        })
      : deps.pythonProbe
        ? legacyPythonDiscovery(platform, deps.pythonProbe)
        : discoverPythons({
            platform,
            env: deps.env,
            run: deps.run,
            exists: deps.exists,
            osHome: deps.osHome,
            cwd: deps.cwd,
            targetDir: deps.workspace,
            explicit: deps.pythonExplicit,
          }),
  ]);
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

  const git = {
    present: gitProbe !== null && !gitProbe.timedOut && gitProbe.output !== null,
    version: gitProbe?.output ?? null,
    executable: gitProbe?.output ? 'git' : null,
  };

  const pySelected = pyDiscovery.selected;
  // Interpretador já selecionado alimenta a sonda de toolchain — sem
  // segunda descoberta (o `-m pip` dela roda no interpretador escolhido).
  const pyInfo: PythonInfo | null = pySelected
    ? {
        exe: pySelected.argv[0],
        args: pySelected.argv.slice(1),
        version: `Python ${pySelected.version}`,
      }
    : null;
  let toolchain = deps.toolchainProbe
    ? await deps.toolchainProbe(platform)
    : await pythonToolchain(platform, pyInfo);
  if (!toolchain && pySelected) {
    // Interpretador fora do PATH (venv/manager/explícito) — o `pip` dele
    // não aparece na sonda por nome; probe direto `<sel> -m pip --version`.
    const sel = pySelected.argv;
    const pip = deps.run
      ? await deps.run(sel[0], [...sel.slice(1), '-m', 'pip', '--version'])
      : await commandProbe(sel[0], [...sel.slice(1), '-m', 'pip', '--version']).then((r) => ({
          ok: r.output !== null && !r.timedOut,
          output: r.output,
          timed_out: r.timedOut,
        }));
    if (pip.ok) toolchain = 'pip';
  }
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

  if (!pySelected) {
    warnings.push({
      id: 'python',
      code: pyDiscovery.refusal?.code ?? 'FORGE-PYTHON-NOT-FOUND',
      message:
        pyDiscovery.refusal?.cause ??
        'nenhum interpretador Python válido — método registry indisponível',
      remedy: pyDiscovery.refusal?.remedy ?? 'instale Python 3.10+ (python.org ou pyenv/uv)',
    });
  }
  if (pySelected && !toolchain) {
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
      present: pySelected !== null,
      exe: pySelected?.argv[0] ?? null,
      args: pySelected?.argv.slice(1) ?? [],
      version: pySelected?.version ?? null,
      toolchain,
      source: pySelected?.source ?? null,
      selection_reason: pySelected?.selection_reason ?? null,
      pipeline: 'lf-0017',
      candidates_total: pyDiscovery.candidates.length + pyDiscovery.truncated,
      candidates: pyDiscovery.candidates
        .slice(0, PYTHON_REPORT_MAX)
        .map((c: ProbedPythonCandidate) => ({
          executable: c.executable,
          source: c.source,
          version: c.version,
          valid: c.valid,
          verdict: c.verdict,
          ...(c.code ? { code: c.code } : {}),
          ...(c.note ? { note: c.note } : {}),
        })),
      refusal: pyDiscovery.refusal,
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
    `python: ${report.python.present ? `${report.python.version} (${report.python.exe})` : 'ausente'} — fonte ${report.python.source ?? 'nenhuma'}, pipeline ${report.python.pipeline} · ${report.python.candidates_total} candidato(s) sondado(s)`,
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
