import { parseArgs } from 'node:util';
import { FORGE_REPOS } from './constants/repos.js';
import { isValidRef } from './git-revs.js';
import { validateNativeOptions } from './native-install.js';
import type { ForgeRepo } from './types.js';
import { S } from './ui/strings.js';

export const DEFAULT_TIMEOUT_SECS = 900;
export const MAX_JOBS = 8;

export interface CliOptions {
  dir?: string;
  all: boolean;
  only?: string[];
  yes: boolean;
  plan: boolean;
  skipScripts: boolean;
  skipVerify: boolean;
  timeoutSecs: number;
  help: boolean;
  jsonReport: boolean;
  reportPath?: string;
  retryFailed: boolean;
  fix: boolean;
  timeoutSet: boolean;
  jsonSet: boolean;
  jobs: number;
  jobsSet: boolean;
  onlyChanged: boolean;
  shallow: boolean;
  check: boolean;
  native: boolean;
  rollback: boolean;
  verify: boolean;
  host?: string;
  gatewayProfile?: string;
  verbose: boolean;
  offline: boolean;
  /** `--lock <file>` — lock offline (registry install --offline). */
  lockFile?: string;
  /** `--no-color` — desliga ANSI mesmo em TTY (NO_COLOR também honrado). */
  noColor?: boolean;
  /** `forge-cli --version` sozinho → versão do CLI (não pin de Forja). */
  versionFlag?: boolean;
  /** `--out <path>` — destino do `registry lock` (arquivo ou dir). */
  out?: string;
  /** `--python <exe>` — interpretador explícito (FORGE_PYTHON também vale). */
  python?: string;
  profile?: string;
  scope?: string;
  components?: string;
  clean: boolean;
  ref?: string;
  method?: 'git' | 'registry';
  trustCustom: boolean;
  runAfterSyncFailure: boolean;
  positionals: string[];
}

export class CliError extends Error {}

export function parseCliArgs(argv: string[]): CliOptions {
  // `--version` é string (pin de Forja, alias de --ref); sozinho, sem valor,
  // é a versão do próprio CLI — disambiguação antes do parseArgs estrito.
  const versionFlag = argv.length === 1 && argv[0] === '--version';
  const parseArgv = versionFlag ? [] : argv;
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: parseArgv,
      options: {
        dir: { type: 'string' },
        all: { type: 'boolean' },
        only: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        plan: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'skip-scripts': { type: 'boolean' },
        'skip-verify': { type: 'boolean' },
        timeout: { type: 'string' },
        json: { type: 'boolean' },
        report: { type: 'string' },
        'retry-failed': { type: 'boolean' },
        fix: { type: 'boolean' },
        jobs: { type: 'string' },
        'only-changed': { type: 'boolean' },
        shallow: { type: 'boolean' },
        check: { type: 'boolean' },
        native: { type: 'boolean' },
        host: { type: 'string' },
        'gateway-profile': { type: 'string' },
        verbose: { type: 'boolean' },
        offline: { type: 'boolean' },
        profile: { type: 'string' },
        scope: { type: 'string' },
        components: { type: 'string' },
        clean: { type: 'boolean' },
        ref: { type: 'string' },
        version: { type: 'string' },
        method: { type: 'string' },
        'trust-custom': { type: 'boolean' },
        'run-after-sync-failure': { type: 'boolean' },
        rollback: { type: 'boolean' },
        verify: { type: 'boolean' },
        lock: { type: 'string' },
        'no-color': { type: 'boolean' },
        out: { type: 'string' },
        python: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  const timeoutSecs = Number.parseInt(values.timeout ?? '', 10);
  if (values.timeout !== undefined && (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0)) {
    throw new CliError(S.errTimeoutInvalid);
  }
  const jobs = Number(values.jobs ?? '');
  if (values.jobs !== undefined && (!Number.isInteger(jobs) || jobs < 1 || jobs > MAX_JOBS)) {
    throw new CliError(S.errJobsInvalid);
  }

  if (values.ref !== undefined && values.version !== undefined) {
    throw new CliError(S.errRefExclusive);
  }
  const nativeError = validateNativeOptions({
    profile: values.profile,
    scope: values.scope,
    components: values.components,
    host: values.host,
    gatewayProfile: values['gateway-profile'],
  });
  if (nativeError) throw new CliError(nativeError);
  const ref = values.ref ?? values.version;
  if (ref !== undefined && !isValidRef(ref)) {
    throw new CliError(`${S.errRefInvalid}: ${ref}`);
  }
  if (values.method !== undefined && !['git', 'registry'].includes(values.method)) {
    throw new CliError(`--method inválido: ${values.method} (use git|registry)`);
  }

  return {
    dir: values.dir,
    all: values.all ?? false,
    only: values.only
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    yes: values.yes ?? false,
    plan: values.plan ?? values['dry-run'] ?? false,
    skipScripts: values['skip-scripts'] ?? false,
    skipVerify: values['skip-verify'] ?? false,
    timeoutSecs: values.timeout === undefined ? DEFAULT_TIMEOUT_SECS : timeoutSecs,
    help: values.help ?? false,
    jsonReport: (values.json ?? false) || values.report !== undefined,
    reportPath: values.report,
    retryFailed: values['retry-failed'] ?? false,
    fix: values.fix ?? false,
    timeoutSet: values.timeout !== undefined,
    jsonSet: values.json !== undefined || values.report !== undefined,
    jobs: values.jobs === undefined ? 1 : jobs,
    jobsSet: values.jobs !== undefined,
    onlyChanged: values['only-changed'] ?? false,
    shallow: values.shallow ?? false,
    check: values.check ?? false,
    native: values.native ?? false,
    rollback: values.rollback ?? false,
    verify: values.verify ?? false,
    lockFile: values.lock,
    noColor: values['no-color'] ?? false,
    versionFlag,
    out: values.out,
    python: values.python,
    host: values.host,
    gatewayProfile: values['gateway-profile'],
    verbose: values.verbose ?? false,
    offline: values.offline ?? false,
    profile: values.profile,
    scope: values.scope,
    components: values.components,
    clean: values.clean ?? false,
    ref,
    method: values.method as 'git' | 'registry' | undefined,
    trustCustom: values['trust-custom'] ?? false,
    runAfterSyncFailure: values['run-after-sync-failure'] ?? false,
    positionals,
  };
}

export function isNonInteractive(cli: CliOptions): boolean {
  return cli.all || (cli.only?.length ?? 0) > 0 || cli.retryFailed;
}

/** Bloco contextual por comando — `forge-cli <cmd> --help` / `help <cmd>`. */
const COMMAND_USAGE: Record<string, string> = {
  install:
    '\ninstall <forjas|<dir>> — PyPI+venv (default) ou git clone + setup (--method git).\n' +
    '  <dir> existente = fonte local (detecção forge/LocalForgeSourceDetection/v1;\n' +
    '  sem git/clone/rede no caminho gitless). --plan só mostra; --ref fixa UMA Forja.',
  update:
    '\nupdate [forjas|<dir>] — pull + setup. --check só verifica; --method registry usa o receipt.\n' +
    '  <dir> é a fonte mais nova de uma fonte local (substituição de arquivos).\n' +
    '  Sem nomes no interativo: oferece as Forjas presentes; --yes exige seleção.',
  registry:
    '\nregistry [list|install|lock] — catálogo PyPI + receipts.\n' +
    '  registry install <f> --offline --lock <arquivo>: instalação travada (--no-index).\n' +
    '  registry lock <f> [--out <arq|dir>]: gera <forja>.offline-lock.json (online, pip>=23).\n' +
    '  --python <exe>: interpretador explícito (FORGE_PYTHON vale igual; explícito\n' +
    '  inválido recusa com FORGE-PYTHON-* e nunca cai para a descoberta automática).',
  mcp:
    '\nmcp [forja…] — argv MCP por Forja (clone ou venv registry).\n' +
    '  --verify: handshake real — níveis INSTALLED→EXECUTABLE→INITIALIZED→\n' +
    '  TOOLS_DISCOVERED→SAFE_TOOL_CALLED→HOST_VERIFIED. tools/call só na allowlist do catálogo.',
  hosts: '\nhosts [list|plan|register|validate|rollback] — integração claude/devin/codex/copilot.',
  env:
    '\nenv <verbo> [forja] — inspect|plan|init|validate|migrate|wizard|doctor|discover|paths.\n' +
    '  discover = relatório forge/EnvironmentDiscovery/v1 (shells verificadas, rota Windows, alvos);\n' +
    '  paths = matriz de alvos de escrita (flag > env > usuário > sistema); wizard é interativo;\n' +
    '  demais honram --json/--yes.',
  doctor: '\ndoctor [--fix] — diagnóstico do ambiente; --fix repara o que falhar.',
  wizard: '\nwizard — assistente guiado: descobrir → recomendar → instalar (interativo).',
  versions: '\nversions [forjas] — tags/versões do remote e revisão atual.',
  status: '\nstatus [forjas] — clones presentes, versões e alterações locais.',
  uninstall:
    '\nuninstall <forjas> — remove clones limpos com backup (exige --yes).\n' +
    '  --method registry remove venv + receipt + wheel cache.',
  self: '\nself install|uninstall|update — registra/remove/atualiza o próprio forge-cli.',
};

/** Ajuda contextual: posicionais vazios → global; com comando → global + bloco. */
export function usageFor(positionals: string[]): string {
  const head = positionals[0] === 'help' ? positionals[1] : positionals[0];
  const extra = head === undefined ? undefined : COMMAND_USAGE[head];
  return extra ? `${S.usage}${extra}` : S.usage;
}

export type Selection = { repos: ForgeRepo[] } | { error: string };

export function resolveSelection(
  cli: CliOptions,
  catalog: readonly ForgeRepo[] = FORGE_REPOS,
): Selection {
  if (cli.all) return { repos: [...catalog] };
  if (!cli.only?.length) return { repos: [] };
  const byName = new Map(catalog.map((r) => [r.name, r]));
  const missing = cli.only.filter((name) => !byName.has(name));
  if (missing.length) {
    return {
      error: `${S.errUnknownRepos}: ${missing.join(', ')} — ${S.validAre}: ${catalog
        .map((r) => r.name)
        .join(', ')}`,
    };
  }
  return { repos: cli.only.map((name) => byName.get(name)!) };
}

export function usage(): string {
  return S.usage;
}
