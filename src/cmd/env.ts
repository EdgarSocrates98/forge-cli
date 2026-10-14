import { log, note } from '@clack/prompts';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { catalogFor } from './shared.js';
import type { CliOptions } from '../cli-args.js';
import { envDoctor } from '../envintel/doctor.js';
import { inspectEnv } from '../envintel/inspect.js';
import {
  applyMigration,
  latestEnvBackup,
  planMigration,
  rollbackEnv,
  type EnvPlan,
} from '../envintel/migrate.js';
import type { Finding } from '../envintel/model.js';
import { deriveSchema } from '../envintel/schema.js';
import { validateEnv } from '../envintel/validate.js';
import { resolveInside } from '../safety.js';
import { S } from '../ui/strings.js';
import { icons, theme } from '../ui/theme.js';
import { resolveTargetDir } from '../utils/system.js';

const VERBS = new Set(['inspect', 'plan', 'init', 'validate', 'migrate', 'doctor']);

/** Diretórios sob `dir` que contêm .env ou .env.example. */
function envCandidates(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => {
        const r = resolveInside(dir, name);
        return (
          r !== null &&
          (existsSync(path.join(r, '.env')) || existsSync(path.join(r, '.env.example')))
        );
      })
      .sort();
  } catch {
    return [];
  }
}

/** Plano mascarado para exibição/JSON — `to` de segredos nunca aparece. */
function maskedActions(plan: EnvPlan, secretKeys: ReadonlySet<string>) {
  return plan.actions.map((a) => ({
    kind: a.kind,
    key: a.key,
    ...(a.to !== undefined
      ? { to: secretKeys.has(a.key) && a.to !== '' ? S.envSecretHidden : a.to }
      : {}),
    reason: a.reason,
  }));
}

function planLines(plan: EnvPlan, secretKeys: ReadonlySet<string>): string[] {
  return maskedActions(plan, secretKeys).map(
    (a) =>
      `${a.kind === 'add' ? '+' : a.kind === 'remove-requested' ? '-' : '·'} ${a.key}` +
      (a.to !== undefined ? ` → ${a.to}` : '') +
      ` ${theme.dim(`(${a.reason})`)}`,
  );
}

function findingLines(findings: Finding[]): string[] {
  return findings.map((f) => `${f.key} — ${f.detail}`);
}

export async function runEnvCommand(cli: CliOptions, args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  const flags = new Set(rest.filter((a) => a.startsWith('-')));
  const names = rest.filter((a) => !a.startsWith('-'));
  const json = cli.jsonReport;
  const yes = cli.yes || flags.has('--yes');
  const dryRun = cli.plan || flags.has('--dry-run');
  const rollback = cli.rollback || flags.has('--rollback');

  if (!verb || !VERBS.has(verb)) {
    log.error(`${S.errUnknownCommand}: env ${verb ?? ''}`.trim());
    return 2;
  }

  const targetDir = resolveTargetDir(cli.dir);
  let repoDir: string | null = null;
  let envKeys: readonly string[] | undefined;
  const name = names[0];
  if (name) {
    repoDir = resolveInside(targetDir, name);
    if (!repoDir) {
      log.error(`${S.errUnknownRepos}: ${name}`);
      return 2;
    }
    envKeys = catalogFor(targetDir).find((r) => r.name === name)?.envKeys;
  } else {
    const cwd = process.cwd();
    if (existsSync(path.join(cwd, '.env')) || existsSync(path.join(cwd, '.env.example'))) {
      repoDir = cwd;
    }
  }
  if (!repoDir) {
    const found = envCandidates(targetDir);
    log.error(S.errNeedsOneName);
    if (found.length) note(found.join('\n'), S.envTitle);
    return 2;
  }
  const repo = name ?? path.basename(repoDir);

  if (verb === 'inspect') {
    const res = inspectEnv(repoDir, envKeys);
    if (json) {
      console.log(JSON.stringify({ command: 'env inspect', repo, ...res }));
      return 0;
    }
    const lines = res.vars.map(
      (v) =>
        `${v.key} ${theme.dim(`(${v.kind}${v.secret && v.kind !== 'secret' ? ` · ${S.envVarSecret}` : ''})`)} — ` +
        (v.present
          ? v.valid === false
            ? theme.err(S.envValidateFail)
            : v.secret
              ? theme.dim(S.envSecretHidden)
              : icons.ok
          : theme.warn(S.envVarMissing)),
    );
    lines.push('', ...findingLines(res.findings));
    note(lines.join('\n'), `${S.envInspectTitle} — ${repo}`);
    log.info(theme.dim(S.envValueNeverShown));
    return 0;
  }

  if (verb === 'validate') {
    const res = validateEnv(repoDir, envKeys);
    if (json) {
      console.log(JSON.stringify({ command: 'env validate', repo, ...res }));
      return res.ok ? 0 : 1;
    }
    if (res.ok) {
      log.success(`${icons.ok} ${S.envValidateOk} ${theme.dim(`(${repo})`)}`);
    } else {
      log.error(`${S.envValidateFail} ${theme.dim(`(${repo})`)}`);
      note(findingLines(res.findings).join('\n'), S.envTitle);
    }
    log.info(theme.dim(S.envValueNeverShown));
    return res.ok ? 0 : 1;
  }

  if (verb === 'doctor') {
    const res = envDoctor(repoDir, envKeys);
    if (json) {
      console.log(JSON.stringify({ command: 'env doctor', repo, ...res }));
      return res.checks.some((c) => c.result === 'fail') ? 1 : 0;
    }
    const lines = res.checks.map(
      (c) =>
        `${c.result === 'pass' ? icons.ok : c.result === 'warn' ? icons.warn : icons.err} ` +
        `${c.id} ${theme.dim(`(${c.detail})`)}`,
    );
    note(lines.join('\n'), `${S.envDoctorTitle} — ${repo}`);
    return res.checks.some((c) => c.result === 'fail') ? 1 : 0;
  }

  // verbos que escrevem exigem diretório existente
  if (!existsSync(repoDir)) {
    log.error(`${repo}: ${S.statusNotInstalled}`);
    return 2;
  }
  const schema = deriveSchema(repoDir, envKeys);
  const secretKeys = new Set(schema.vars.filter((v) => v.secret).map((v) => v.key));
  const envPath = path.join(repoDir, '.env');

  if (verb === 'plan') {
    const plan = planMigration(repoDir, schema);
    const shown = maskedActions(plan, secretKeys);
    if (json) {
      console.log(
        JSON.stringify({
          command: 'env plan',
          repo,
          removesRequireApproval: plan.removesRequireApproval,
          actions: shown,
        }),
      );
      return 0;
    }
    const actionable = shown.filter((a) => a.kind !== 'keep');
    note(
      actionable.length ? planLines(plan, secretKeys).join('\n') : S.envPlanNone,
      `${S.envPlanTitle} — ${repo}`,
    );
    return 0;
  }

  if (verb === 'init') {
    if (existsSync(envPath)) {
      if (json) console.log(JSON.stringify({ command: 'env init', repo, created: false }));
      else log.info(S.envInitExists);
      return 0;
    }
    const res = applyMigration(repoDir, planMigration(repoDir, schema), {});
    if (json) console.log(JSON.stringify({ command: 'env init', repo, created: true, ...res }));
    else log.success(`${icons.ok} ${S.envInitDone} ${theme.dim(`(${res.applied.length})`)}`);
    return 0;
  }

  // migrate
  if (rollback) {
    const backup = latestEnvBackup(repoDir);
    const ok = backup ? rollbackEnv(repoDir, backup) : false;
    if (json) {
      console.log(
        JSON.stringify({ command: 'env migrate --rollback', repo, ok, backup: backup ?? null }),
      );
    } else if (ok) {
      log.success(`${icons.ok} ${S.envRollbackDone}`);
      log.info(`${S.envBackupAt}: ${theme.dim(backup!)}`);
    } else {
      log.error(S.envRollbackNone);
    }
    return ok ? 0 : 1;
  }

  const plan = planMigration(repoDir, schema);
  const removes = plan.actions.filter((a) => a.kind === 'remove-requested');
  if (!plan.actions.some((a) => a.kind !== 'keep')) {
    if (json) console.log(JSON.stringify({ command: 'env migrate', repo, actions: [] }));
    else log.info(S.envPlanNone);
    return 0;
  }
  if (dryRun) {
    if (json) {
      console.log(
        JSON.stringify({
          command: 'env migrate',
          repo,
          dryRun: true,
          actions: maskedActions(plan, secretKeys),
        }),
      );
      return 0;
    }
    note(planLines(plan, secretKeys).join('\n'), `${S.envPlanTitle} — ${repo}`);
    log.info(S.envMigrateDryRun);
    return 0;
  }
  const res = applyMigration(repoDir, plan, { authorizeRemoves: yes });
  if (json) {
    console.log(
      JSON.stringify({
        command: 'env migrate',
        repo,
        ...(removes.length && !yes ? { needsYes: true } : {}),
        ...res,
      }),
    );
    return 0;
  }
  if (!res.applied.length && res.skipped.length) {
    note(planLines(plan, secretKeys).join('\n'), `${S.envPlanTitle} — ${repo}`);
    log.warn(S.envMigrateNeedsYes);
    return 0;
  }
  if (res.backup) log.info(`${S.envBackupAt}: ${theme.dim(res.backup)}`);
  log.success(`${icons.ok} ${S.envMigrateDone} ${theme.dim(`(${res.applied.length})`)}`);
  if (res.skipped.length) {
    log.warn(`${S.envMigrateNeedsYes} ${theme.dim(`(${res.skipped.join(', ')})`)}`);
  }
  return 0;
}
