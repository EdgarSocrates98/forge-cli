/**
 * Comandos de fonte local (`install <dir>`, `update <dir>`,
 * `uninstall|reinstall <nome>` de receipt `method:'local'`).
 *
 * Camada fina sobre src/source/install.ts: resolve deps reais
 * (execaRun, home, interpretador), apresenta o plano/refusas PT-BR e
 * honra o contrato de saída (`--json` puro no stdout; `--report` grava).
 * Códigos FORGE-* aparecem no texto do erro e no JSON — nunca mudos.
 */
import { confirm, isCancel, log, note, outro, spinner } from '@clack/prompts';
import path from 'node:path';
import type { CliOptions } from '../cli-args.js';
import { exitCancelled } from '../prompts.js';
import { execaRun, loadForgeState } from '../registry/install.js';
import { redactSecrets, writeFileAtomic } from '../safety.js';
import { detectSource, type SourceDetection } from '../source/detect.js';
import {
  localInstall,
  localRepair,
  localUninstall,
  localUpdate,
  type LocalDeps,
  type LocalOutcome,
} from '../source/install.js';
import { windowsSetupShells } from '../env/shells.js';
import { icons, theme } from '../ui/theme.js';
import { cliHome, resolvePython } from '../utils/system.js';
import { emitJson } from './shared.js';
import { mkdirSync } from 'node:fs';

function quiet(cli: CliOptions): boolean {
  return cli.jsonReport && cli.reportPath === undefined;
}

function reportTo(cli: CliOptions, doc: unknown): void {
  if (cli.reportPath === undefined) return;
  const file = path.resolve(cli.reportPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, redactSecrets(JSON.stringify(doc, null, 2)));
}

async function depsFor(cli: CliOptions, home: string): Promise<LocalDeps> {
  return {
    home,
    run: execaRun,
    yes: cli.yes,
    timeoutMs: cli.timeoutSecs * 1000,
    // Rota de shell verificada (win32) — powershell/pwsh/Git Bash; o
    // probe é no-op fora do Windows (POSIX nem spawna).
    ...(process.platform === 'win32' ? { winShells: await windowsSetupShells() } : {}),
    // Fonte parcial só pergunta em TTY real — pipes/--json nunca travam
    // (mesmo contrato dos fluxos git/registry).
    confirm:
      !cli.yes && process.stdout.isTTY && process.stdin.isTTY
        ? async () => {
            const answer = await confirm({
              message:
                'Fonte parcial (estrutura incompleta — integridade parcial). Instalar mesmo assim?',
            });
            if (isCancel(answer)) exitCancelled();
            return answer === true;
          }
        : undefined,
  };
}

/** Linha do erro: código FORGE-* primeiro quando presente — estável p/ scripts. */
function describeFailure(f: { code?: string; cause: string }): string {
  return f.code ? `${f.code}: ${f.cause}` : f.cause;
}

function summarizeDetection(det: SourceDetection): Record<string, unknown> {
  return {
    path: det.path,
    state: det.state,
    is_git: det.is_git,
    manifest_valid: det.manifest_valid,
    forge_id: det.forge_id ?? null,
    identity: det.identity,
    source_trust: det.source_trust,
    integrity: det.integrity,
    setup_scripts: det.structure.setup_scripts,
    project_markers: det.structure.project_markers,
    reasons: det.reasons,
    refusal: det.refusal ?? null,
  };
}

/** --plan/--check: classifica e mostra o veredito — ZERO escrita. */
function planDetections(cli: CliOptions, dirs: string[], verb: string): void {
  const detections = dirs.map((d) => detectSource(d));
  const doc = {
    method: 'local',
    plan: true,
    verb,
    sources: detections.map(summarizeDetection),
  };
  reportTo(cli, doc);
  if (quiet(cli)) emitJson(doc, detections.every((d) => !d.refusal) ? 0 : 1);
  note(
    detections
      .map(
        (d) =>
          `${d.refusal ? icons.err : icons.ok} ${d.path}\n  state=${d.state} · is_git=${d.is_git} · identidade=${d.identity} · integridade=${d.integrity}` +
          (d.forge_id ? ` · forge_id=${d.forge_id}` : '') +
          (d.refusal ? `\n  ${d.refusal.code}: ${d.refusal.cause}` : ''),
      )
      .join('\n'),
    `Detecção de fonte local (${verb})`,
  );
  log.info('Plano — nada foi escrito');
  if (detections.some((d) => d.refusal)) process.exit(1);
  process.exit(0);
}

/**
 * `--method git` pediu explicitamente o fluxo git: fonte sem `.git`
 * não pode clonar/fazer pull — recusa nomeada antes de instalar
 * (GIT_REPOSITORY/GIT_WORKTREE seguem com bootstrap no lugar).
 */
function methodGitGate(
  cli: CliOptions,
  dirs: string[],
  verb: string,
): { dir: string; code: string; cause: string; remedy: string }[] {
  if (cli.method !== 'git') return [];
  return dirs
    .map((dir) => ({ dir, det: detectSource(dir) }))
    .filter((x) => !x.det.refusal && !x.det.is_git)
    .map((x) => ({
      dir: x.dir,
      code: 'FORGE-SOURCE-GITLESS',
      cause: `${x.dir}: fonte sem git (${x.det.state}) — \`${verb}\` com --method git não se aplica`,
      remedy: `remova --method para instalar da fonte local, ou clone no workspace para o fluxo git`,
    }));
}

export async function runLocalInstallCommand(cli: CliOptions, dirs: string[]): Promise<void> {
  const home = cliHome();
  if (cli.plan || cli.check) planDetections(cli, dirs, 'install');
  const deps = await depsFor(cli, home);
  deps.python = await resolvePython();
  const results: Record<string, unknown>[] = [];
  let refusals = 0;
  let failures = 0;
  const gates = methodGitGate(cli, dirs, 'install');
  for (const g of gates) {
    log.error(`${g.code}: ${g.cause}`);
    log.info(`→ ${g.remedy}`);
    refusals++;
    results.push({ dir: g.dir, ok: false, code: g.code, cause: g.cause, remedy: g.remedy });
  }
  const gated = new Set(gates.map((g) => g.dir));
  for (const dir of dirs.filter((d) => !gated.has(d))) {
    const spin = spinner();
    if (!quiet(cli)) spin.start(`${dir}: detectando fonte…`);
    const outcome = await localInstall(dir, deps);
    if (!outcome.ok) {
      if (!quiet(cli)) spin.stop(`${dir}: ${theme.err('recusado')}`);
      const msg = describeFailure(outcome.failure);
      log.error(`${dir}: ${msg}`);
      if (outcome.failure.remedy) log.info(`→ ${outcome.failure.remedy}`);
      const isRefusal = outcome.failure.code !== undefined;
      if (isRefusal) refusals++;
      else failures++;
      results.push({
        dir,
        ok: false,
        code: outcome.failure.code ?? null,
        cause: outcome.failure.cause,
        remedy: outcome.failure.remedy ?? null,
        state: outcome.detection?.state ?? null,
      });
      continue;
    }
    const r = outcome.receipt;
    if (!quiet(cli)) {
      spin.stop(
        `${r.forge}: ${theme.ok('instalado')} ${theme.dim(`${r.version} — ${r.source_dir}`)}`,
      );
    }
    results.push({
      dir,
      forge: r.forge,
      ok: true,
      version: r.version,
      source_dir: r.source_dir,
      install_method: r.install_method,
      is_git: r.is_git,
      source_trust: r.source_trust,
      manifest_valid: r.manifest_valid,
      integrity: r.integrity,
      setup_script: r.setup_script,
      verify: r.verify,
      bin: r.bin ?? null,
      shim: r.shim ?? null,
    });
  }
  const doc = { method: 'local', results };
  reportTo(cli, doc);
  if (quiet(cli)) emitJson(doc, failures ? 1 : refusals ? 2 : 0);
  if (results.some((r) => r.ok)) {
    outro(`${icons.ok} instalação de fonte local concluída`);
  }
  if (failures) process.exit(1);
  if (refusals) process.exit(2);
}

export async function runLocalUpdateCommand(cli: CliOptions, dirs: string[]): Promise<void> {
  const home = cliHome();
  if (cli.plan || cli.check) planDetections(cli, dirs, 'update');
  const deps = await depsFor(cli, home);
  deps.python = await resolvePython();
  const results: Record<string, unknown>[] = [];
  let refusals = 0;
  let failures = 0;
  const gates = methodGitGate(cli, dirs, 'update');
  for (const g of gates) {
    log.error(`${g.code}: ${g.cause}`);
    log.info(`→ ${g.remedy}`);
    refusals++;
    results.push({ dir: g.dir, ok: false, code: g.code, cause: g.cause, remedy: g.remedy });
  }
  const gated = new Set(gates.map((g) => g.dir));
  for (const dir of dirs.filter((d) => !gated.has(d))) {
    const spin = spinner();
    if (!quiet(cli)) spin.start(`${dir}: atualizando por fonte…`);
    const outcome = await localUpdate(dir, deps);
    if (!outcome.ok) {
      if (!quiet(cli)) spin.stop(`${dir}: ${theme.err('recusado')}`);
      log.error(`${dir}: ${describeFailure(outcome.failure)}`);
      if (outcome.failure.remedy) log.info(`→ ${outcome.failure.remedy}`);
      const isRefusal = outcome.failure.code !== undefined;
      if (isRefusal) refusals++;
      else failures++;
      results.push({
        dir,
        ok: false,
        code: outcome.failure.code ?? null,
        cause: outcome.failure.cause,
        remedy: outcome.failure.remedy ?? null,
        state: outcome.detection?.state ?? null,
      });
      continue;
    }
    const r = outcome.receipt;
    if (!quiet(cli)) {
      spin.stop(`${r.forge}: ${theme.ok('atualizado')} ${theme.dim(r.version)}`);
    }
    results.push({
      dir,
      forge: r.forge,
      ok: true,
      version: r.version,
      source_dir: r.source_dir,
      verify: r.verify,
      integrity: r.integrity,
    });
  }
  const doc = { method: 'local', results };
  reportTo(cli, doc);
  if (quiet(cli)) emitJson(doc, failures ? 1 : refusals ? 2 : 0);
  if (failures) process.exit(1);
  if (refusals) process.exit(2);
}

/**
 * `uninstall|reinstall <nome>` para receipts `method:'local'` — os
 * nomes chegam pré-filtrados pelo roteamento do index.ts (receipt local
 * existe). Confirmação --yes/prompt segue o contrato do uninstall
 * registry; a fonte NUNCA é apagada — só artefatos gerenciados.
 */
export async function runLocalLifecycleCommand(
  cli: CliOptions,
  op: 'uninstall' | 'repair',
  names: string[],
): Promise<void> {
  const home = cliHome();
  const deps = await depsFor(cli, home);
  deps.python = await resolvePython();
  const state = loadForgeState(home).forges;

  if (cli.plan || cli.check) {
    const doc = {
      method: 'local',
      plan: true,
      verb: op,
      targets: names.map((n) => {
        const r = Object.hasOwn(state, n) ? state[n] : undefined;
        return {
          forge: n,
          local: r?.method === 'local',
          source_dir: r?.method === 'local' ? r.source_dir : null,
          managed_artifacts: r?.method === 'local' ? r.managed_artifacts : [],
        };
      }),
    };
    reportTo(cli, doc);
    if (quiet(cli)) emitJson(doc, 0);
    note(
      doc.targets
        .map(
          (t) =>
            `${t.forge}: ${t.source_dir ?? '?'} — ${t.managed_artifacts.length} artefato(s) gerenciado(s)${t.managed_artifacts.length ? ` (${t.managed_artifacts.join(', ')})` : ''}`,
        )
        .join('\n'),
      `Plano ${op} (fonte preservada)`,
    );
    log.info('Plano — nada foi escrito');
    process.exit(0);
  }

  if (op === 'uninstall' && !cli.yes) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      const doc = { error: 'uninstall de fonte local exige --yes (remove artefatos gerenciados)' };
      reportTo(cli, doc);
      if (quiet(cli)) emitJson(doc, 2);
      log.warn('Nada foi removido. Reexecute com --yes para confirmar.');
      process.exit(0);
    }
    const answer = await confirm({
      message: 'Remover os artefatos gerenciados (a fonte permanece)?',
    });
    if (isCancel(answer) || !answer) {
      if (isCancel(answer)) exitCancelled();
      log.warn('Nada foi removido.');
      process.exit(0);
    }
  }

  const results: Record<string, unknown>[] = [];
  let refusals = 0;
  let failures = 0;
  for (const name of names) {
    const spin = spinner();
    if (!quiet(cli))
      spin.start(`${name}: ${op === 'uninstall' ? 'removendo artefatos' : 'reparando'}…`);
    if (op === 'repair') {
      const outcome: LocalOutcome = await localRepair(name, deps);
      if (!outcome.ok) {
        if (!quiet(cli)) spin.stop(`${name}: ${theme.err('falhou')}`);
        log.error(`${name}: ${describeFailure(outcome.failure)}`);
        if (outcome.failure.remedy) log.info(`→ ${outcome.failure.remedy}`);
        const isRefusal = outcome.failure.code !== undefined;
        if (isRefusal) refusals++;
        else failures++;
        results.push({
          forge: name,
          ok: false,
          code: outcome.failure.code ?? null,
          cause: outcome.failure.cause,
          remedy: outcome.failure.remedy ?? null,
        });
        continue;
      }
      if (!quiet(cli)) spin.stop(`${name}: ${theme.ok('reparado')}`);
      results.push({ forge: name, ok: true, repaired: true, version: outcome.receipt.version });
      continue;
    }
    const outcome = await localUninstall(name, deps);
    if (!outcome.ok) {
      if (!quiet(cli)) spin.stop(`${name}: ${theme.err('falhou')}`);
      log.error(`${name}: ${describeFailure(outcome.failure)}`);
      if (outcome.failure.remedy) log.info(`→ ${outcome.failure.remedy}`);
      const isRefusal = outcome.failure.code !== undefined;
      if (isRefusal) refusals++;
      else failures++;
      results.push({
        forge: name,
        ok: false,
        code: outcome.failure.code ?? null,
        cause: outcome.failure.cause,
        remedy: outcome.failure.remedy ?? null,
      });
      continue;
    }
    if (!quiet(cli)) {
      spin.stop(
        `${name}: ${theme.ok('removido')} ${theme.dim(`${outcome.removed.length} artefato(s) — fonte preservada em ${outcome.sourceKept}`)}`,
      );
    }
    results.push({
      forge: name,
      ok: true,
      removed: outcome.removed,
      backup: outcome.backup ?? null,
      source_kept: outcome.sourceKept,
    });
  }
  const doc = { method: 'local', verb: op, results };
  reportTo(cli, doc);
  if (quiet(cli)) emitJson(doc, failures ? 1 : refusals ? 2 : 0);
  if (failures) process.exit(1);
  if (refusals) process.exit(2);
}
