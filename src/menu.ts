import { isCancel, select } from '@clack/prompts';
import type { CliOptions } from './cli-args.js';
import { isNonInteractive } from './cli-args.js';
import { exitCancelled } from './prompts.js';
import { S } from './ui/strings.js';

export type MenuAction =
  | 'install'
  | 'wizard'
  | 'update'
  | 'reinstall'
  | 'repair'
  | 'versions'
  | 'status'
  | 'uninstall'
  | 'doctor'
  | 'exit';

export const MENU_ITEMS: { value: MenuAction; label: string; hint?: string }[] = [
  { value: 'install', label: S.menuInstall, hint: S.menuInstallHint },
  { value: 'wizard', label: S.menuWizard, hint: S.menuWizardHint },
  { value: 'update', label: S.menuUpdate },
  { value: 'reinstall', label: S.menuReinstall, hint: S.menuReinstallHint },
  { value: 'repair', label: S.menuRepair, hint: S.menuRepairHint },
  { value: 'versions', label: S.menuVersions },
  { value: 'status', label: S.menuStatus },
  { value: 'uninstall', label: S.menuUninstall, hint: S.menuUninstallHint },
  { value: 'doctor', label: S.menuDoctor },
  { value: 'exit', label: S.menuExit },
];

/** O menu só aparece no modo totalmente interativo: sem comando, flags de seleção ou plano. */
export function shouldShowMenu(
  cli: Pick<
    CliOptions,
    'positionals' | 'all' | 'only' | 'retryFailed' | 'plan' | 'help' | 'method'
  >,
  tty: boolean,
): boolean {
  return (
    tty &&
    cli.positionals.length === 0 &&
    !cli.help &&
    !cli.plan &&
    // `--method registry` ainda não tem fluxo guiado — sem menu, o
    // dispatcher recusa com errMethodUnsupported em vez de dead-end.
    cli.method !== 'registry' &&
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
      return [];
    case 'wizard':
      return ['wizard'];
    case 'repair':
    case 'doctor':
      return ['doctor'];
    default:
      return [action, ...names];
  }
}

export interface PromptIo {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function askMenu(io: PromptIo = {}): Promise<MenuAction> {
  const choice = await select({
    ...(io.input ? { input: io.input as NodeJS.ReadStream } : {}),
    ...(io.output ? { output: io.output as NodeJS.WriteStream } : {}),
    message: S.menuTitle,
    options: MENU_ITEMS.map((item) => ({
      value: item.value,
      label: item.label,
      hint: item.hint,
    })),
    initialValue: 'install' as MenuAction,
  });
  if (isCancel(choice)) exitCancelled();
  return choice;
}

export interface MenuDeps {
  ask(): Promise<MenuAction>;
  workspace(): Promise<string>;
  resolveDir(dir: string): string;
  pickRepos(dir: string): Promise<string[]>;
}

/**
 * Traduz a escolha do menu em opções do CLI. Retorna `null` quando o usuário escolhe sair.
 * Sem efeitos colaterais além das perguntas, o que permite testar o fluxo sem TTY.
 */
export async function applyMenu(cli: CliOptions, deps: MenuDeps): Promise<CliOptions | null> {
  const action = await deps.ask();
  if (action === 'exit') return null;
  if (action === 'install') return cli;
  const dir = cli.dir ? deps.resolveDir(cli.dir) : await deps.workspace();
  const names = actionNeedsRepos(action) ? await deps.pickRepos(dir) : [];
  return {
    ...cli,
    dir,
    positionals: actionToPositionals(action, names),
    fix: action === 'repair',
  };
}
