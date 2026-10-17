import { isCancel, select } from '@clack/prompts';
import type { CliOptions } from './cli-args.js';
import { isNonInteractive } from './cli-args.js';
import { exitCancelled } from './prompts.js';
import { S } from './ui/strings.js';

export type MenuAction =
  | 'install'
  | 'installed'
  | 'wizard'
  | 'update'
  | 'reinstall'
  | 'repair'
  | 'versions'
  | 'status'
  | 'uninstall'
  | 'doctor'
  | 'hosts'
  | 'mcp'
  | 'skills'
  | 'env'
  | 'advanced'
  | 'mcp-verify'
  | 'exit';

/**
 * Menu guiado registry-first: install/installed/update primeiro, depois as
 * superfícies de integração (hosts/MCP/skills), diagnóstico e o submenu
 * 'advanced' (env, MCP --verify).
 */
export const MENU_ITEMS: { value: MenuAction; label: string; hint?: string }[] = [
  { value: 'install', label: S.menuInstall, hint: S.menuInstallHint },
  { value: 'installed', label: S.menuInstalled, hint: S.menuInstalledHint },
  { value: 'update', label: S.menuUpdate },
  { value: 'hosts', label: S.menuHosts, hint: S.menuHostsHint },
  { value: 'mcp', label: S.menuMcp, hint: S.menuMcpHint },
  { value: 'skills', label: S.menuSkills, hint: S.menuSkillsHint },
  { value: 'wizard', label: S.menuWizard, hint: S.menuWizardHint },
  { value: 'reinstall', label: S.menuReinstall, hint: S.menuReinstallHint },
  { value: 'repair', label: S.menuRepair, hint: S.menuRepairHint },
  { value: 'versions', label: S.menuVersions },
  { value: 'status', label: S.menuStatus },
  { value: 'uninstall', label: S.menuUninstall, hint: S.menuUninstallHint },
  { value: 'doctor', label: S.menuDoctor },
  { value: 'advanced', label: S.menuAdvanced, hint: S.menuAdvancedHint },
  { value: 'exit', label: S.menuExit },
];

/** Submenu 'advanced': superfícies de baixo nível — env wizard e MCP --verify. */
export const ADVANCED_MENU_ITEMS: { value: MenuAction; label: string; hint?: string }[] = [
  { value: 'env', label: S.menuEnv, hint: S.menuEnvHint },
  { value: 'mcp-verify', label: S.menuMcpVerify, hint: S.menuMcpVerifyHint },
];

/**
 * `--method registry` tem fluxo guiado próprio: só os verbos que o
 * engine registry suporta (clone/versions/git-only ficam fora).
 * 'status'/'installed' mapeiam para `forge-cli registry` (lista de receipts).
 */
export const REGISTRY_MENU_ACTIONS: MenuAction[] = [
  'install',
  'installed',
  'update',
  'reinstall',
  'uninstall',
  'status',
  'exit',
];

export function menuItemsFor(cli: Pick<CliOptions, 'method'>): typeof MENU_ITEMS {
  if (cli.method !== 'registry') return MENU_ITEMS;
  return MENU_ITEMS.filter((i) => REGISTRY_MENU_ACTIONS.includes(i.value));
}

/** O menu só aparece no modo totalmente interativo: sem comando, flags de seleção, --yes ou plano. */
export function shouldShowMenu(
  cli: Pick<
    CliOptions,
    'positionals' | 'all' | 'only' | 'retryFailed' | 'plan' | 'help' | 'method' | 'yes'
  >,
  tty: boolean,
): boolean {
  return (
    tty &&
    cli.positionals.length === 0 &&
    !cli.help &&
    !cli.plan &&
    !cli.yes &&
    !isNonInteractive(cli as CliOptions)
  );
}

export function actionNeedsRepos(action: MenuAction): boolean {
  return (
    action === 'update' || action === 'reinstall' || action === 'versions' || action === 'uninstall'
  );
}

/** Traduz a escolha do menu em posicionais do CLI; `install` segue o fluxo interativo padrão. */
export function actionToPositionals(action: MenuAction, names: string[]): string[] {
  switch (action) {
    case 'install':
    case 'exit':
    case 'advanced':
      return [];
    case 'installed':
      return ['registry'];
    case 'wizard':
      return ['wizard'];
    case 'repair':
    case 'doctor':
      return ['doctor'];
    case 'hosts':
      return ['hosts'];
    case 'mcp':
      return ['mcp'];
    case 'skills':
      return ['components'];
    case 'env':
      return ['env', 'doctor'];
    case 'mcp-verify':
      return ['mcp'];
    default:
      return [action, ...names];
  }
}

export interface PromptIo {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function askMenu(
  io: PromptIo = {},
  items: typeof MENU_ITEMS = MENU_ITEMS,
  title = S.menuTitle,
): Promise<MenuAction> {
  const choice = await select({
    ...(io.input ? { input: io.input as NodeJS.ReadStream } : {}),
    ...(io.output ? { output: io.output as NodeJS.WriteStream } : {}),
    message: title,
    options: items.map((item) => ({
      value: item.value,
      label: item.label,
      hint: item.hint,
    })),
    initialValue: items[0].value as MenuAction,
  });
  if (isCancel(choice)) exitCancelled();
  return choice;
}

export interface MenuDeps {
  ask(): Promise<MenuAction>;
  workspace(): Promise<string>;
  resolveDir(dir: string): string;
  pickRepos(dir: string): Promise<string[]>;
  /** Registry: escolha no catálogo PyPI (install) ou no state local (lifecycle). */
  pickRegistryCatalog?(): Promise<string[]>;
  pickRegistryInstalled?(): Promise<string[]>;
  /** Submenu 'advanced' — sem dep, a ação degrada para `doctor`. */
  askAdvanced?(): Promise<MenuAction>;
}

/**
 * Traduz a escolha do menu em opções do CLI. Retorna `null` quando o usuário escolhe sair.
 * Sem efeitos colaterais além das perguntas, o que permite testar o fluxo sem TTY.
 */
export async function applyMenu(cli: CliOptions, deps: MenuDeps): Promise<CliOptions | null> {
  let action = await deps.ask();
  if (action === 'advanced') {
    action = deps.askAdvanced ? await deps.askAdvanced() : 'doctor';
  }
  if (action === 'exit') return null;
  // Fluxo guiado registry: catálogo PyPI para install, state para lifecycle.
  if (cli.method === 'registry') {
    if (action === 'status' || action === 'installed') return { ...cli, positionals: ['registry'] };
    if (action === 'install') {
      const names = deps.pickRegistryCatalog ? await deps.pickRegistryCatalog() : [];
      return { ...cli, positionals: ['install', ...names] };
    }
    const names = deps.pickRegistryInstalled ? await deps.pickRegistryInstalled() : [];
    return { ...cli, positionals: [action, ...names] };
  }
  if (action === 'install') return cli;
  // --verify é flag, não posicional — mcp-verify funde a flag no cli.
  if (action === 'mcp-verify') return { ...cli, positionals: ['mcp'], verify: true };
  const dir = cli.dir ? deps.resolveDir(cli.dir) : await deps.workspace();
  const names = actionNeedsRepos(action) ? await deps.pickRepos(dir) : [];
  return {
    ...cli,
    dir,
    positionals: actionToPositionals(action, names),
    fix: action === 'repair',
  };
}
