import type { ForgeRepo, NativeFlag } from './types.js';

export const PROFILES = ['minimal', 'recommended', 'full'] as const;
export const SCOPES = ['project', 'workspace', 'user'] as const;
export const HOSTS = ['claude', 'devin', 'codex', 'copilot', 'all'] as const;
export const GATEWAY_PROFILES = ['economy', 'balanced', 'deep'] as const;
const COMPONENTS = /^[a-z][a-z0-9-]*(,[a-z][a-z0-9-]*)*$/;

export interface NativeInstallOptions {
  profile?: string;
  scope?: string;
  components?: string;
  host?: string;
  gatewayProfile?: string;
  /**
   * `--root <dir>` — alvo explícito do instalador nativo (wave-14). É
   * repassado pelo runtime (cwd do workspace/alvo), nunca inferido pelo
   * instalador — mas só entra no argv quando a Forja o declara.
   */
  root?: string;
  /** Aprovação explícita para escrever; sem ela o instalador nativo roda com --dry-run. */
  approve?: boolean;
}

/** Opções das operações nativas de ciclo de vida (update/uninstall). */
export interface NativeOpOptions {
  /** `--root <dir>` — alvo explícito (mesma regra do install). */
  root?: string;
  /** `--to <versão>` — pin de versão no update nativo. */
  to?: string;
  /** `--repo <url|dir>` — fonte alternativa no update nativo. */
  repo?: string;
  /** `--purge` — remoção profunda no uninstall nativo. */
  purge?: boolean;
}

export function hasNativeRequest(opts?: NativeInstallOptions): boolean {
  return Boolean(
    opts && (opts.profile || opts.scope || opts.components || opts.host || opts.gatewayProfile),
  );
}

export function validateNativeOptions(opts: NativeInstallOptions & NativeOpOptions): string | null {
  if (opts.profile && !(PROFILES as readonly string[]).includes(opts.profile)) {
    return `--profile inválido: ${opts.profile} (use ${PROFILES.join('|')})`;
  }
  if (opts.scope && !(SCOPES as readonly string[]).includes(opts.scope)) {
    return `--scope inválido: ${opts.scope} (use ${SCOPES.join('|')})`;
  }
  if (opts.components && !COMPONENTS.test(opts.components)) {
    return `--components inválido: ${opts.components} (lista separada por vírgula, ex.: skills,agents)`;
  }
  if (opts.host && !(HOSTS as readonly string[]).includes(opts.host)) {
    return `--host inválido: ${opts.host} (use ${HOSTS.join('|')})`;
  }
  if (
    opts.gatewayProfile &&
    !(GATEWAY_PROFILES as readonly string[]).includes(opts.gatewayProfile)
  ) {
    return `--gateway-profile inválido: ${opts.gatewayProfile} (use ${GATEWAY_PROFILES.join('|')})`;
  }
  if (opts.root !== undefined && !opts.root.trim()) {
    return '--root inválido: caminho vazio';
  }
  if (opts.to !== undefined && !opts.to.trim()) {
    return '--to inválido: valor vazio';
  }
  if (opts.repo !== undefined && !opts.repo.trim()) {
    return '--repo inválido: valor vazio';
  }
  return null;
}

/**
 * Monta o comando do instalador nativo da Forja a partir do que ela documenta suportar.
 * Retorna `null` quando a Forja não declara instalador nativo (não simula suporte).
 */
export function buildNativeInstall(
  repo: ForgeRepo,
  opts: NativeInstallOptions,
): { argv: string[]; dryRun: boolean; ignored: string[] } | null {
  const native = repo.nativeInstall;
  if (!native) return null;
  const argv = [...native.command];
  const ignored: string[] = [];
  const add = (flag: NativeFlag, value?: string) => {
    if (!value) return;
    if (native.flags.includes(flag)) argv.push(`--${flag}`, value);
    else ignored.push(flag);
  };
  add('scope', opts.scope);
  add('profile', opts.profile);
  add('components', opts.components);
  add('host', opts.host);
  add('gateway-profile', opts.gatewayProfile);
  // `--root` é repassado sempre que declarado — alvo explícito, jamais
  // substituído por um ascendente inferido pelo instalador.
  add('root', opts.root);
  const dryRun = !opts.approve;
  argv.push(dryRun ? '--dry-run' : '--yes');
  return { argv, dryRun, ignored };
}

/** Linhas legíveis com o que cada Forja realmente documenta suportar. */
export function componentsLines(repos: readonly ForgeRepo[]): string[] {
  return repos.map((repo) => {
    if (!repo.nativeInstall) return `${repo.name} — sem instalador nativo documentado`;
    const flags = repo.nativeInstall.flags.map((f) => `--${f}`).join(' ');
    return `${repo.name} — ${repo.nativeInstall.command.join(' ')} [${flags}]`;
  });
}

/**
 * Operação nativa de ciclo de vida: aplica só com aprovação; caso
 * contrário `--dry-run`. `--root` entra quando declarado; `to`/`repo`
 * são flags de update e `purge` de uninstall — fora disso caem em
 * `ignored` (honest) em vez de vazar para a Forja.
 */
export function buildNativeOp(
  repo: ForgeRepo,
  op: 'update' | 'uninstall',
  approve: boolean,
  opts: NativeOpOptions = {},
): { argv: string[]; dryRun: boolean; ignored: string[] } | null {
  const native = repo.nativeInstall;
  const base = native?.ops?.[op];
  if (!native || !base) return null;
  const argv = [...base];
  const ignored: string[] = [];
  const add = (flag: NativeFlag, value?: string) => {
    if (!value) return;
    if (native.flags.includes(flag)) argv.push(`--${flag}`, value);
    else ignored.push(flag);
  };
  const addSwitch = (flag: NativeFlag, on?: boolean) => {
    if (!on) return;
    if (native.flags.includes(flag)) argv.push(`--${flag}`);
    else ignored.push(flag);
  };
  add('root', opts.root);
  if (op === 'update') {
    add('to', opts.to);
    add('repo', opts.repo);
  }
  if (op === 'uninstall') addSwitch('purge', opts.purge);
  if (!approve) argv.push('--dry-run');
  return { argv, dryRun: !approve, ignored };
}
