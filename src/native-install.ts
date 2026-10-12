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
  /** Aprovação explícita para escrever; sem ela o instalador nativo roda com --dry-run. */
  approve?: boolean;
}

export function hasNativeRequest(opts?: NativeInstallOptions): boolean {
  return Boolean(
    opts && (opts.profile || opts.scope || opts.components || opts.host || opts.gatewayProfile),
  );
}

export function validateNativeOptions(opts: NativeInstallOptions): string | null {
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

/** Operação nativa de ciclo de vida: aplica só com aprovação; caso contrário `--dry-run`. */
export function buildNativeOp(
  repo: ForgeRepo,
  op: 'update' | 'uninstall',
  approve: boolean,
): { argv: string[]; dryRun: boolean } | null {
  const argv = repo.nativeInstall?.ops?.[op];
  if (!argv) return null;
  return { argv: approve ? [...argv] : [...argv, '--dry-run'], dryRun: !approve };
}
