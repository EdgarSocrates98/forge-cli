/**
 * Matriz de seleção de caminhos — `forge/EnvironmentDiscovery/v1` (lf-0016).
 *
 * Cada alvo de escrita resolve pela mesma prioridade:
 *
 *   flag explícita (API/--dir)  >  variável de ambiente
 *   >  default de usuário (HOME/USERPROFILE)  >  default de sistema (os.homedir)
 *
 * Seis alvos, sempre na mesma ordem:
 *
 *   home            <home>            raiz do estado forge-cli
 *   bin             <home>/.forge-cli/bin       shims/launchers
 *   venvs           <home>/.forge-cli/forges    venvs por Forja
 *   receipts        <home>/.forge-cli/forges    install.json por Forja
 *   workspace_state <workspace>/.forge-cli      estado do workspace
 *   env_files       <workspace>                 .env / configs por Forja
 *
 * Alvo resolvido sem permissão de escrita carrega `denied`
 * (FORGE-INSTALL-PERMISSION-DENIED) + `fallback` — a primeira alternativa
 * gravável na mesma cadeia, ou um caminho concreto sob o tmpdir. O check é
 * puro (accessSync no ancestral existente mais próximo): nada é criado.
 */
import { accessSync, constants, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ForgeErrorCode } from '../errors.js';
import { DEFAULT_WORKSPACE } from '../utils/system.js';

/** Origem do tier que venceu a resolução do alvo. */
export type PathSource = 'explicit' | 'env' | 'user' | 'system';

export interface PathRefusal {
  code: ForgeErrorCode;
  cause: string;
  remedy: string;
}

export interface WriteTarget {
  name: 'home' | 'bin' | 'venvs' | 'receipts' | 'workspace_state' | 'env_files';
  /** Caminho resolvido pela prioridade — mesmo quando negado. */
  path: string;
  source: PathSource;
  /** Variável que forneceu o tier 'env'/'user' (evidência, não exigência). */
  env_var: string | null;
  exists: boolean;
  /** null = não foi possível determinar (raiz exótica). */
  writable: boolean | null;
  /** Ancestral existente mais próximo sondado pelo accessSync. */
  checked: string | null;
  /** Alternativa concreta gravável quando o alvo resolvido nega escrita. */
  fallback: string | null;
  denied: PathRefusal | null;
}

/** Overrides explícitos — o tier mais alto ("flag"). */
export interface PathExplicit {
  home?: string;
  binDir?: string;
  forgesDir?: string;
  workspaceDir?: string;
}

export interface PathDeps {
  env?: NodeJS.ProcessEnv;
  /** Home da conta do SO (os.homedir real) — injetável em teste. */
  osHome?: string;
  /** cwd para resolver o workspace default — injetável em teste. */
  cwd?: string;
  tmpDir?: string;
  exists?: (target: string) => boolean;
  /** Predicado de escrita — o real usa accessSync(W_OK). */
  writable?: (dir: string) => boolean;
  explicit?: PathExplicit;
}

interface ResolvedPathDeps {
  env: NodeJS.ProcessEnv;
  osHome: string;
  cwd: string;
  tmpDir: string;
  exists: (target: string) => boolean;
  writable: (dir: string) => boolean;
}

function resolveDeps(deps: PathDeps): ResolvedPathDeps {
  return {
    env: deps.env ?? process.env,
    osHome: deps.osHome ?? os.homedir(),
    cwd: deps.cwd ?? process.cwd(),
    tmpDir: deps.tmpDir ?? os.tmpdir(),
    exists: deps.exists ?? existsSync,
    writable:
      deps.writable ??
      ((dir: string): boolean => {
        try {
          accessSync(dir, constants.W_OK);
          return true;
        } catch {
          return false;
        }
      }),
  };
}

interface Tier {
  path: string;
  source: PathSource;
  envVar: string | null;
}

/** Diretório existente mais próximo — alvo honesto do probe de escrita. */
function nearestExisting(dir: string, exists: (target: string) => boolean): string {
  let cur = dir;
  while (!exists(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return dir;
    cur = parent;
  }
  return cur;
}

/** Home por tiers: FORGE_CLI_HOME > HOME/USERPROFILE (env do usuário) > os.homedir. */
function homeTiers(d: ResolvedPathDeps, explicitHome?: string): Tier[] {
  const tiers: Tier[] = [];
  if (explicitHome) tiers.push({ path: explicitHome, source: 'explicit', envVar: null });
  if (d.env.FORGE_CLI_HOME)
    tiers.push({ path: d.env.FORGE_CLI_HOME, source: 'env', envVar: 'FORGE_CLI_HOME' });
  const userHome = d.env.HOME ?? d.env.USERPROFILE;
  if (userHome) {
    tiers.push({
      path: userHome,
      source: 'user',
      envVar: d.env.HOME ? 'HOME' : 'USERPROFILE',
    });
  }
  tiers.push({ path: d.osHome, source: 'system', envVar: null });
  return tiers;
}

/** Resolve um alvo: primeiro tier definido vence; negação gera recusa + fallback. */
function resolveTarget(
  d: ResolvedPathDeps,
  name: WriteTarget['name'],
  tiers: Tier[],
  envHint: string,
): WriteTarget {
  const defined = tiers.filter((tier) => tier.path.length > 0);
  const chosen = defined[0];
  const checked = nearestExisting(chosen.path, d.exists);
  let writable: boolean | null;
  try {
    writable = d.writable(checked);
  } catch {
    writable = null;
  }
  let fallback: string | null = null;
  let denied: PathRefusal | null = null;
  if (writable === false) {
    const alternative = defined.slice(1).find((tier) => {
      const ancestor = nearestExisting(tier.path, d.exists);
      try {
        return d.writable(ancestor);
      } catch {
        return false;
      }
    });
    fallback = alternative?.path ?? path.join(d.tmpDir, 'forge-cli');
    denied = {
      code: 'FORGE-INSTALL-PERMISSION-DENIED',
      cause: `alvo '${name}' sem permissão de escrita: ${chosen.path} (origem ${chosen.source})`,
      remedy: alternative
        ? `use a alternativa gravável ${alternative.path} (origem ${alternative.source}) ou ajuste as permissões de ${checked}`
        : `nenhum tier gravável — defina ${envHint}=${fallback} ou ajuste as permissões de ${checked}`,
    };
  }
  return {
    name,
    path: chosen.path,
    source: chosen.source,
    env_var: chosen.envVar,
    exists: d.exists(chosen.path),
    writable,
    checked,
    fallback,
    denied,
  };
}

/** Desce os tiers de home aplicando um sufixo (`.forge-cli/bin` etc.). */
function underHome(tiers: Tier[], ...segments: string[]): Tier[] {
  return tiers.map((tier) => ({
    path: path.join(tier.path, ...segments),
    source: tier.source,
    envVar: tier.envVar,
  }));
}

/**
 * Resolve os seis alvos de escrita na ordem fixa do contrato.
 * `workspace` já chega resolvido (resolveTargetDir do chamador — flag --dir).
 */
export function resolveWriteTargets(deps: PathDeps = {}): WriteTarget[] {
  const d = resolveDeps(deps);
  const homes = homeTiers(d, deps.explicit?.home);
  const forgeHomeHint = 'FORGE_CLI_HOME';
  const home = resolveTarget(d, 'home', homes, forgeHomeHint);

  const binTiers: Tier[] = [
    ...(deps.explicit?.binDir
      ? [{ path: deps.explicit.binDir, source: 'explicit' as const, envVar: null }]
      : []),
    ...underHome(homes, '.forge-cli', 'bin'),
  ];
  const bin = resolveTarget(d, 'bin', binTiers, forgeHomeHint);

  const forgesTiers: Tier[] = [
    ...(deps.explicit?.forgesDir
      ? [{ path: deps.explicit.forgesDir, source: 'explicit' as const, envVar: null }]
      : []),
    ...underHome(homes, '.forge-cli', 'forges'),
  ];
  const venvs = resolveTarget(d, 'venvs', forgesTiers, forgeHomeHint);
  const receipts = resolveTarget(d, 'receipts', forgesTiers, forgeHomeHint);

  const workspaceTiers: Tier[] = [
    ...(deps.explicit?.workspaceDir
      ? [{ path: deps.explicit.workspaceDir, source: 'explicit' as const, envVar: null }]
      : []),
    { path: path.resolve(d.cwd, DEFAULT_WORKSPACE), source: 'user' as const, envVar: null },
  ];
  const workspaceState = resolveTarget(
    d,
    'workspace_state',
    workspaceTiers.map((tier) => ({
      path: path.join(tier.path, '.forge-cli'),
      source: tier.source,
      envVar: null,
    })),
    '--dir',
  );
  const envFiles = resolveTarget(d, 'env_files', workspaceTiers, '--dir');

  return [home, bin, venvs, receipts, workspaceState, envFiles];
}
