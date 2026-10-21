/**
 * Doctor 2.0 — the five §5.1 domains.
 *
 * Every check carries real evidence (paths probed, values seen). Anything
 * that cannot be proven is 'unverified' or 'skip' — never fabricated.
 * Check ids are stable and pinned: the heal registry (src/heal/) keys on
 * them, so ids must not be renamed without a registry migration.
 */

import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifactsRoot, stateFileFor } from '../artifacts.js';
import { inspectEnv } from '../envintel/inspect.js';
import { deriveSchema } from '../envintel/schema.js';
import type { HostDetection } from '../hosts/types.js';
import { checkEnvLock, interruptedRuns, type EnvLock } from '../maintenance.js';
import { classifyIntegrationsSync } from '../integrations.js';
import { loadForgeState, type LocalInstallReceipt } from '../registry/install.js';
import { resolveInside } from '../safety.js';
import { hasGitRepo } from '../utils/system.js';
import { boundEntries, errMsg, listDir, mkCheck, readJson, type DoctorCtx } from './context.js';
import type { CheckResult, DoctorCheck, Severity } from './model.js';

// ---------------------------------------------------------------------------
// 1. system — runtime, platform, workspace access, required dirs, offline note
// ---------------------------------------------------------------------------

export function systemChecks(ctx: DoctorCtx): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  const raw = process.version;
  const major = Number.parseInt(raw.replace(/^v/, '').split('.')[0] ?? '', 10);
  if (!Number.isFinite(major)) {
    checks.push(
      mkCheck(ctx.now, {
        id: 'system.runtime.node',
        domain: 'system',
        result: 'unverified',
        severity: 'info',
        diagnosis: 'versão do Node.js não pôde ser interpretada',
        evidence: [`process.version=${raw}`, 'mínimo exigido=18'],
        reversible: null,
      }),
    );
  } else {
    const ok = major >= 18;
    checks.push(
      mkCheck(ctx.now, {
        id: 'system.runtime.node',
        domain: 'system',
        result: ok ? 'pass' : 'fail',
        severity: ok ? 'info' : 'high',
        diagnosis: ok
          ? `Node.js ${raw} atende ao mínimo exigido (>=18)`
          : `Node.js ${raw} está abaixo do mínimo exigido (>=18)`,
        evidence: [`process.version=${raw}`, 'mínimo exigido=18'],
        ...(ok ? {} : { correctiveAction: 'upgrade node.js to >=18' }),
        reversible: ok ? null : false,
      }),
    );
  }

  checks.push(
    mkCheck(ctx.now, {
      id: 'system.platform.detected',
      domain: 'system',
      result: 'pass',
      severity: 'info',
      diagnosis: 'plataforma detectada',
      evidence: [`platform=${process.platform}`, `arch=${os.arch()}`, `release=${os.release()}`],
      reversible: null,
    }),
  );

  // Real fs probe: read the workspace, then write+remove a probe file inside it.
  const dir = ctx.root;
  let readable = false;
  let writable = false;
  let readEvidence: string;
  let writeEvidence = 'write=não sondado (leitura falhou)';
  try {
    readdirSync(dir);
    readable = true;
    readEvidence = 'read=ok';
  } catch (error) {
    readEvidence = `read=falha (${errMsg(error)})`;
  }
  if (readable) {
    const probe = path.join(dir, `.forge-doctor2-probe-${process.pid}`);
    try {
      writeFileSync(probe, 'probe\n', 'utf8');
      rmSync(probe, { force: true });
      writable = true;
      writeEvidence = 'write=ok';
    } catch (error) {
      writeEvidence = `write=falha (${errMsg(error)})`;
      try {
        rmSync(probe, { force: true });
      } catch {
        /* melhor esforço — sonda nunca fica para trás */
      }
    }
  }
  const accessResult: CheckResult = !readable ? 'fail' : !writable ? 'warn' : 'pass';
  const accessSeverity: Severity = accessResult === 'pass' ? 'info' : 'high';
  checks.push(
    mkCheck(ctx.now, {
      id: 'system.workspace.access',
      domain: 'system',
      result: accessResult,
      severity: accessSeverity,
      diagnosis:
        accessResult === 'pass'
          ? 'workspace legível e gravável'
          : accessResult === 'warn'
            ? 'workspace legível mas não gravável — instalações não são possíveis'
            : 'workspace inexistente ou ilegível',
      evidence: [`path=${dir}`, readEvidence, writeEvidence],
      ...(accessResult === 'pass' ? {} : { correctiveAction: 'fix workspace path or permissions' }),
      reversible: accessResult === 'pass' ? null : false,
    }),
  );

  // Required dirs: home (state/backups) and tmpdir (logs/reports) must be readable.
  const required = [
    { label: 'home', dir: ctx.home },
    { label: 'tmpdir', dir: os.tmpdir() },
  ];
  const dirEvidence: string[] = [];
  let dirFailed = 0;
  for (const { label, dir: d } of required) {
    if (!existsSync(d)) {
      dirFailed += 1;
      dirEvidence.push(`${label}=${d}: ausente`);
      continue;
    }
    const names = listDir(d);
    if (names === null) {
      dirFailed += 1;
      dirEvidence.push(`${label}=${d}: ilegível`);
    } else {
      dirEvidence.push(`${label}=${d}: ok`);
    }
  }
  checks.push(
    mkCheck(ctx.now, {
      id: 'system.dirs.required',
      domain: 'system',
      result: dirFailed ? 'warn' : 'pass',
      severity: dirFailed ? 'high' : 'info',
      diagnosis: dirFailed
        ? `${dirFailed} diretório(s) exigido(s) inacessível(is)`
        : 'diretórios exigidos acessíveis (home, tmpdir)',
      evidence: dirEvidence,
      ...(dirFailed ? { correctiveAction: 'restore access to home/tmp dirs' } : {}),
      reversible: dirFailed ? false : null,
    }),
  );

  checks.push(
    mkCheck(ctx.now, {
      id: 'system.offline.capable',
      domain: 'system',
      result: 'pass',
      severity: 'info',
      diagnosis: 'diagnóstico opera offline — nenhum acesso à rede realizado',
      evidence: [
        'nenhuma chamada de rede nesta varredura',
        'probes são leituras de disco e detecção local de CLIs',
      ],
      reversible: null,
    }),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// 2. installation — .forge-cli, forge.json, lockfile, ledger, checkouts, backups
// ---------------------------------------------------------------------------

function backupScan(ctx: DoctorCtx): { restorable: string[]; scanned: string[] } {
  const restorable: string[] = [];
  const scanned: string[] = [];
  let over = false;
  const dirHasFiles = (full: string): boolean => (listDir(full)?.length ?? 0) > 0;
  const scan = (dir: string, kind: string, restorableIf: (full: string) => boolean): void => {
    const names = listDir(dir);
    if (names === null) {
      scanned.push(`${dir} (ausente/ilegível)`);
      return;
    }
    scanned.push(`${dir} (${names.length} entradas)`);
    for (const name of names) {
      if (restorable.length >= ctx.maxEntries) {
        over = true;
        break;
      }
      const full = path.join(dir, name);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (restorableIf(full)) restorable.push(`${kind}: ${full}`);
    }
  };
  scan(path.join(artifactsRoot(ctx.root), 'backups'), 'workspace-backup', dirHasFiles);
  scan(path.join(ctx.home, '.forge-cli', 'backups'), 'host-backup', (full) =>
    existsSync(path.join(full, 'manifest.json')),
  );
  for (const repo of ctx.catalog) {
    const dir = resolveInside(ctx.root, repo.name);
    if (!dir || over) continue;
    scan(path.join(dir, '.forge-cli', 'backups'), `env-backup(${repo.name})`, dirHasFiles);
  }
  if (over) ctx.truncated.value = true;
  return { restorable, scanned };
}

export function installationChecks(ctx: DoctorCtx): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const forgeDir = artifactsRoot(ctx.root);
  const forgeDirPresent = existsSync(forgeDir);
  const stateFile = stateFileFor(ctx.root);

  checks.push(
    mkCheck(
      ctx.now,
      forgeDirPresent
        ? {
            id: 'installation.forge-dir.absent',
            domain: 'installation',
            result: 'pass',
            severity: 'info',
            diagnosis: 'diretório de estado .forge-cli presente',
            evidence: [
              `${forgeDir} presente`,
              existsSync(stateFile) ? 'state.json presente' : 'state.json ausente',
            ],
            reversible: null,
          }
        : {
            id: 'installation.forge-dir.absent',
            domain: 'installation',
            result: 'fail',
            severity: 'low',
            diagnosis:
              'diretório de estado .forge-cli ausente — nenhuma instalação registrada neste workspace',
            evidence: [`${forgeDir} ausente`],
            correctiveAction: 'create .forge-cli state dir',
            reversible: true,
          },
    ),
  );

  const forgeJson = path.join(ctx.root, 'forge.json');
  if (!existsSync(forgeJson)) {
    checks.push(
      mkCheck(ctx.now, {
        id: 'installation.forge-json.present',
        domain: 'installation',
        result: 'skip',
        severity: 'info',
        diagnosis: 'sem forge.json na raiz do workspace (manifesto opcional)',
        evidence: [`${forgeJson} ausente`],
        reversible: null,
      }),
    );
  } else {
    const parsed = readJson(forgeJson);
    const isObject =
      parsed.ok &&
      parsed.value !== null &&
      typeof parsed.value === 'object' &&
      !Array.isArray(parsed.value);
    if (!parsed.ok || !isObject) {
      checks.push(
        mkCheck(ctx.now, {
          id: 'installation.forge-json.present',
          domain: 'installation',
          result: 'warn',
          severity: 'medium',
          diagnosis: 'forge.json presente mas inválido (não é um objeto JSON)',
          evidence: [
            `${forgeJson} presente`,
            parsed.ok ? 'conteúdo não é objeto JSON' : `JSON inválido (${parsed.error})`,
          ],
          correctiveAction: 'fix or regenerate forge.json',
          reversible: true,
        }),
      );
    } else {
      const obj = parsed.value as Record<string, unknown>;
      checks.push(
        mkCheck(ctx.now, {
          id: 'installation.forge-json.present',
          domain: 'installation',
          result: 'pass',
          severity: 'info',
          diagnosis: 'forge.json presente e parseável',
          evidence: [
            `${forgeJson} parseado`,
            `forge_id=${typeof obj.forge_id === 'string' ? obj.forge_id : 'não declarado'}`,
          ],
          reversible: null,
        }),
      );
    }
  }

  const lockFile = path.join(forgeDir, 'env.lock.json');
  const lockParsed = existsSync(lockFile) ? readJson(lockFile) : null;
  const lockObj =
    lockParsed?.ok && lockParsed.value !== null && typeof lockParsed.value === 'object'
      ? (lockParsed.value as EnvLock)
      : null;

  if (!forgeDirPresent || !existsSync(lockFile)) {
    checks.push(
      mkCheck(ctx.now, {
        id: 'installation.lockfile.present',
        domain: 'installation',
        result: 'skip',
        severity: 'info',
        diagnosis: 'nenhum lockfile de ambiente registrado',
        evidence: [forgeDirPresent ? `${lockFile} ausente` : '.forge-cli ausente — sem lockfile'],
        reversible: null,
      }),
    );
  } else if (!lockParsed?.ok || !lockObj || lockObj.schema !== 'forge-cli/EnvLock/v1') {
    checks.push(
      mkCheck(ctx.now, {
        id: 'installation.lockfile.present',
        domain: 'installation',
        result: 'warn',
        severity: 'medium',
        diagnosis: 'lockfile de ambiente presente mas inválido',
        evidence: [
          `${lockFile} presente`,
          lockParsed?.ok
            ? `schema=${typeof lockObj?.schema === 'string' ? lockObj.schema : 'indefinido'} (esperado forge-cli/EnvLock/v1)`
            : `JSON inválido (${lockParsed?.error ?? 'erro'})`,
        ],
        correctiveAction: 'regenerate lockfile',
        reversible: true,
      }),
    );
  } else {
    checks.push(
      mkCheck(ctx.now, {
        id: 'installation.lockfile.present',
        domain: 'installation',
        result: 'pass',
        severity: 'info',
        diagnosis: 'lockfile de ambiente válido',
        evidence: [
          'schema=forge-cli/EnvLock/v1',
          `forges registradas=${Object.keys(lockObj.forges ?? {}).length}`,
        ],
        reversible: null,
      }),
    );
  }

  // Drift (pinned): unverified when nothing can be recomputed.
  const trackedForges = lockObj ? Object.keys(lockObj.forges ?? {}) : [];
  if (!existsSync(lockFile) || !lockObj || !trackedForges.length) {
    checks.push(
      mkCheck(ctx.now, {
        id: 'installation.lockfile.drift',
        domain: 'installation',
        result: 'unverified',
        severity: 'info',
        diagnosis: 'deriva do lockfile não verificável',
        evidence: [
          !existsSync(lockFile)
            ? 'sem lockfile para recomputar (.forge-cli/env.lock.json ausente)'
            : !lockObj
              ? 'lockfile ilegível — digest não pode ser recomputado'
              : 'lockfile não cobre nenhuma Forja — nada para recomputar',
        ],
        reversible: null,
      }),
    );
  } else {
    const results = checkEnvLock(ctx.root, ctx.catalog);
    const drifted = results.filter((r) => r.state === 'drifted').map((r) => r.forge);
    const evidence = results.map((r) => `${r.forge}=${r.state}`);
    checks.push(
      mkCheck(ctx.now, {
        id: 'installation.lockfile.drift',
        domain: 'installation',
        result: drifted.length ? 'warn' : 'pass',
        severity: drifted.length ? 'medium' : 'info',
        diagnosis: drifted.length
          ? `ambiente diverge do lockfile em ${drifted.length} Forja(s)`
          : 'ambiente confere com o lockfile',
        evidence: boundEntries(ctx, evidence).shown,
        ...(drifted.length ? { correctiveAction: 'regenerate lockfile' } : {}),
        reversible: drifted.length ? true : null,
      }),
    );
  }

  const ledgerDir = path.join(ctx.home, '.forge', 'installations');
  const ledgerNames = listDir(ledgerDir);
  if (ledgerNames === null) {
    checks.push(
      mkCheck(ctx.now, {
        id: 'installation.ledger.readable',
        domain: 'installation',
        result: existsSync(ledgerDir) ? 'warn' : 'skip',
        severity: existsSync(ledgerDir) ? 'medium' : 'info',
        diagnosis: existsSync(ledgerDir)
          ? 'ledger de instalações existe mas não pôde ser lido'
          : 'sem ledger de instalações (~/.forge/installations ausente)',
        evidence: [`${ledgerDir} ${existsSync(ledgerDir) ? 'ilegível' : 'ausente'}`],
        reversible: null,
      }),
    );
  } else {
    const bounded = boundEntries(ctx, ledgerNames);
    checks.push(
      mkCheck(ctx.now, {
        id: 'installation.ledger.readable',
        domain: 'installation',
        result: 'pass',
        severity: 'info',
        diagnosis: 'ledger de instalações legível',
        evidence: [
          `${ledgerDir} legível`,
          `entradas=${bounded.total}${bounded.total > bounded.shown.length ? ` (cap ${ctx.maxEntries})` : ''}`,
        ],
        reversible: null,
      }),
    );
  }

  const checkoutLines: string[] = [];
  const recordedMissing: string[] = [];
  let checkouts = 0;
  for (const repo of [...ctx.catalog].sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = resolveInside(ctx.root, repo.name);
    const git = !!dir && hasGitRepo(dir);
    if (git) checkouts += 1;
    const rec = ctx.state?.repos[repo.name];
    const recorded = rec && (rec.phase ? rec.phase !== 'not-installed' : true) ? rec : null;
    if (recorded && !git) recordedMissing.push(repo.name);
    checkoutLines.push(
      `${repo.name}: ${git ? 'checkout git' : 'sem checkout'}${recorded ? ` (registry=${recorded.phase ?? recorded.status})` : ''}`,
    );
  }
  if (!ctx.catalog.length || (!checkouts && !recordedMissing.length && !ctx.state)) {
    checks.push(
      mkCheck(ctx.now, {
        id: 'installation.checkouts.present',
        domain: 'installation',
        result: 'skip',
        severity: 'info',
        diagnosis: 'nenhum checkout para verificar',
        evidence: ctx.catalog.length
          ? [`checkouts=0/${ctx.catalog.length} — nada instalado neste workspace`]
          : ['catálogo vazio — nada declarado'],
        reversible: null,
      }),
    );
  } else {
    checks.push(
      mkCheck(ctx.now, {
        id: 'installation.checkouts.present',
        domain: 'installation',
        result: recordedMissing.length ? 'warn' : 'pass',
        severity: recordedMissing.length ? 'medium' : 'info',
        diagnosis: recordedMissing.length
          ? `${recordedMissing.length} Forja(s) registrada(s) sem checkout`
          : `checkouts git consistentes com o registro`,
        evidence: boundEntries(ctx, [
          `checkouts=${checkouts}/${ctx.catalog.length}`,
          ...checkoutLines,
        ]).shown,
        ...(recordedMissing.length
          ? { correctiveAction: 'reinstall or remove stale registry entries' }
          : {}),
        reversible: recordedMissing.length ? false : null,
      }),
    );
  }

  // Fontes locais (`install <dir>`): receipts method:'local' — uma fonte
  // sem `.git` é instalação saudável por definição; só a ausência do
  // source_dir registrado é problema real (drift, não "não-git").
  const localEntries = Object.entries(loadForgeState(ctx.home).forges).filter(
    (e): e is [string, LocalInstallReceipt] => e[1]?.method === 'local',
  );
  if (!localEntries.length) {
    checks.push(
      mkCheck(ctx.now, {
        id: 'installation.local-sources.present',
        domain: 'installation',
        result: 'skip',
        severity: 'info',
        diagnosis: 'nenhuma fonte local registrada (install <dir>)',
        evidence: ['receipts method=local: 0'],
        reversible: null,
      }),
    );
  } else {
    const lines = localEntries.map(([name, r]) => {
      const src = typeof r.source_dir === 'string' ? r.source_dir : '?';
      const srcOk = typeof r.source_dir === 'string' && existsSync(r.source_dir);
      return (
        `${name}: is_git=${r.is_git === true} trust=${r.source_trust ?? '?'} ` +
        `manifest_valid=${r.manifest_valid === true} integrity=${r.integrity ?? '?'} ` +
        `env=${r.execution_environment?.platform ?? '?'} dir=${src}${srcOk ? '' : ' (AUSENTE)'}`
      );
    });
    const missing = localEntries.filter(
      ([, r]) => typeof r.source_dir !== 'string' || !existsSync(r.source_dir),
    );
    checks.push(
      mkCheck(ctx.now, {
        id: 'installation.local-sources.present',
        domain: 'installation',
        result: missing.length ? 'warn' : 'pass',
        severity: missing.length ? 'medium' : 'info',
        diagnosis: missing.length
          ? `${missing.length} fonte(s) local(is) com diretório ausente`
          : `${localEntries.length} fonte(s) local(is) íntegra(s)`,
        evidence: boundEntries(ctx, lines).shown,
        ...(missing.length
          ? {
              correctiveAction:
                'reinstall <forja> com a fonte de volta ou uninstall <forja> para remover o registro',
            }
          : {}),
        reversible: missing.length ? false : null,
      }),
    );
  }

  const withCheckout = ctx.catalog.filter((r) => {
    const dir = resolveInside(ctx.root, r.name);
    return !!dir && hasGitRepo(dir);
  });
  const noVerify = withCheckout.filter((r) => !r.verify?.length).map((r) => r.name);
  checks.push(
    mkCheck(
      ctx.now,
      !withCheckout.length
        ? {
            id: 'installation.verify.declared',
            domain: 'installation',
            result: 'skip',
            severity: 'info',
            diagnosis: 'nenhum checkout para verificar scripts de verify',
            evidence: ['nenhum checkout git presente'],
            reversible: null,
          }
        : {
            id: 'installation.verify.declared',
            domain: 'installation',
            result: noVerify.length ? 'warn' : 'pass',
            severity: noVerify.length ? 'low' : 'info',
            diagnosis: noVerify.length
              ? `${noVerify.length} checkout(s) sem comando de verify declarado`
              : 'todo checkout tem comando de verify declarado',
            evidence: noVerify.length
              ? boundEntries(
                  ctx,
                  noVerify.map((n) => `${n}: verify ausente`),
                ).shown
              : boundEntries(
                  ctx,
                  withCheckout.map((r) => `${r.name}: verify=${r.verify?.join(' ') ?? '—'}`),
                ).shown,
            ...(noVerify.length
              ? { correctiveAction: 'declare a verify command for the repo' }
              : {}),
            reversible: noVerify.length ? false : null,
          },
    ),
  );

  const backups = backupScan(ctx);
  checks.push(
    mkCheck(
      ctx.now,
      backups.restorable.length
        ? {
            id: 'installation.backup.present',
            domain: 'installation',
            result: 'pass',
            severity: 'info',
            diagnosis: `${backups.restorable.length} backup(s) restaurável(is) encontrado(s)`,
            evidence: boundEntries(ctx, backups.restorable).shown,
            reversible: null,
          }
        : {
            id: 'installation.backup.present',
            domain: 'installation',
            result: 'skip',
            severity: 'info',
            diagnosis: 'nenhum backup restaurável — nada foi alterado ainda',
            evidence: ['nenhum backup encontrado', ...backups.scanned],
            reversible: null,
          },
    ),
  );

  // lf-0031: integrações opcionais por consumidor instalado — um check por
  // Forja instalada cobrindo install/capability/version/executable-health/
  // contract/delegation-adapter de cada especialista declarado. Ausência é
  // opcional por construção: 'skip'/info — nunca falha a Forja principal.
  const forgeState = loadForgeState(ctx.home).forges;
  for (const repo of [...ctx.catalog].sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = resolveInside(ctx.root, repo.name);
    const consumerPresent = (!!dir && hasGitRepo(dir)) || !!forgeState[repo.name];
    if (!consumerPresent) continue;
    const statuses = classifyIntegrationsSync(repo.name, { root: ctx.root, home: ctx.home });
    if (!statuses.length) continue;
    const lines = statuses.map((s) => {
      const sdir = resolveInside(ctx.root, s.integration.name);
      let contract = 'contract=não sondado';
      if (sdir && existsSync(sdir)) {
        const manifest = path.join(sdir, 'forge.json');
        contract = !existsSync(manifest)
          ? 'contract=sem forge.json'
          : readJson(manifest).ok
            ? 'contract=forge.json válido'
            : 'contract=forge.json inválido';
      } else if (s.state === 'verified' || s.state === 'installed') {
        contract = 'contract=manifesto dentro da venv (não sondado)';
      }
      return (
        `${s.integration.name}: state=${s.state} ` +
        `capability=${s.integration.adapter ? 'derivável (adapter declarado)' : 'não declarada'} ` +
        `adapter=${s.integration.adapter ? 'the-forge' : 'ausente'} ${contract}` +
        ` [${s.evidence.join(' · ')}]`
      );
    });
    const degraded = statuses.filter((s) => s.state === 'degraded').length;
    const present = statuses.filter((s) => s.state !== 'absent').length;
    // `adapter=ausente` fica em evidência mas não vira warn: especialistas
    // não-adaptados (data-sentinel-forge) são gap documentado — a informação
    // é reportada, não transformada em pendência de reparo.
    checks.push(
      mkCheck(
        ctx.now,
        degraded
          ? {
              id: `installation.integrations.${repo.name}`,
              domain: 'installation',
              result: 'warn',
              severity: 'low',
              diagnosis: `${degraded} integração(ões) opcional(is) degradada(s)`,
              evidence: boundEntries(ctx, lines).shown,
              correctiveAction: 'reinstall or verify degraded optional specialists',
              reversible: true,
            }
          : present
            ? {
                id: `installation.integrations.${repo.name}`,
                domain: 'installation',
                result: 'pass',
                severity: 'info',
                diagnosis: `${present} integração(ões) opcional(is) presente(s) e saudável(is)`,
                evidence: boundEntries(ctx, lines).shown,
                reversible: null,
              }
            : {
                id: `installation.integrations.${repo.name}`,
                domain: 'installation',
                result: 'skip',
                severity: 'info',
                diagnosis:
                  'integrações opcionais ausentes — nada exigido, nunca falha a Forja principal',
                evidence: boundEntries(ctx, lines).shown,
                reversible: null,
              },
      ),
    );
  }

  return checks;
}

// ---------------------------------------------------------------------------
// 3. environment — .env presence, missing keys vs schema, port conflicts
// ---------------------------------------------------------------------------

interface EnvTarget {
  label: string;
  dir: string;
  envKeys?: readonly string[];
}

export function environmentChecks(ctx: DoctorCtx): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const targets: EnvTarget[] = [{ label: '<workspace>', dir: ctx.root }];
  for (const repo of ctx.catalog) {
    const dir = resolveInside(ctx.root, repo.name);
    if (dir && existsSync(dir)) targets.push({ label: repo.name, dir, envKeys: repo.envKeys });
  }
  const inspected = targets.map((t) => ({
    ...t,
    schema: deriveSchema(t.dir, t.envKeys),
    inspect: inspectEnv(t.dir, t.envKeys),
  }));

  const declaredMissing = inspected.filter(
    (t) => t.inspect.state === 'absent' && t.schema.vars.length > 0,
  );
  checks.push(
    mkCheck(ctx.now, {
      id: 'environment.env.present',
      domain: 'environment',
      result: declaredMissing.length ? 'warn' : 'pass',
      severity: declaredMissing.length ? 'low' : 'info',
      diagnosis: declaredMissing.length
        ? `${declaredMissing.length} diretório(s) com schema declarado sem .env`
        : '.env presente onde exigido (ou nada exigido)',
      evidence: boundEntries(
        ctx,
        inspected.map(
          (t) =>
            `${t.label}: .env ${t.inspect.state === 'absent' ? 'ausente' : 'presente'}${t.schema.vars.length ? ' (schema declarado)' : ''}`,
        ),
      ).shown,
      ...(declaredMissing.length ? { correctiveAction: 'create .env from .env.example' } : {}),
      reversible: declaredMissing.length ? true : null,
    }),
  );

  const withSchema = inspected.filter((t) => t.schema.vars.length > 0);
  if (!withSchema.length) {
    checks.push(
      mkCheck(ctx.now, {
        id: 'environment.env.missing-key',
        domain: 'environment',
        result: 'unverified',
        severity: 'info',
        diagnosis: 'chaves de ambiente não verificáveis — sem schema para comparar',
        evidence: [
          'nenhum schema de ambiente (forge.env.schema.json/.env.example/envKeys) encontrado',
        ],
        reversible: null,
      }),
    );
  } else {
    const missing = withSchema.flatMap((t) =>
      t.inspect.findings.filter((f) => f.kind === 'missing').map((f) => `${t.label}: ${f.key}`),
    );
    checks.push(
      mkCheck(ctx.now, {
        id: 'environment.env.missing-key',
        domain: 'environment',
        result: missing.length ? 'warn' : 'pass',
        severity: missing.length ? 'medium' : 'info',
        diagnosis: missing.length
          ? `${missing.length} chave(s) declarada(s) ausente(s) no .env`
          : 'nenhuma chave exigida ausente',
        evidence: missing.length
          ? boundEntries(ctx, missing).shown
          : [`${withSchema.length} schema(s) verificado(s)`],
        ...(missing.length ? { correctiveAction: 'restore missing keys' } : {}),
        reversible: missing.length ? true : null,
      }),
    );
  }

  const withEnv = inspected.filter((t) => t.inspect.state !== 'absent');
  if (!withEnv.length) {
    checks.push(
      mkCheck(ctx.now, {
        id: 'environment.env.hygiene',
        domain: 'environment',
        result: 'skip',
        severity: 'info',
        diagnosis: 'sem .env para analisar',
        evidence: ['nenhum arquivo .env encontrado nos diretórios inspecionados'],
        reversible: null,
      }),
    );
    checks.push(
      mkCheck(ctx.now, {
        id: 'environment.ports.conflict',
        domain: 'environment',
        result: 'skip',
        severity: 'info',
        diagnosis: 'conflitos de porta não verificáveis sem .env',
        evidence: [
          'sem .env — conflito de porta só é detectável por análise estática',
          'nenhum probing de socket realizado',
        ],
        reversible: null,
      }),
    );
  } else {
    const issues = withEnv.flatMap((t) => {
      const kindByKey = new Map(t.inspect.vars.map((v) => [v.key, v.kind] as const));
      return t.inspect.findings
        .filter(
          (f) =>
            f.kind === 'invalid' ||
            f.kind === 'insecure' ||
            f.kind === 'duplicate' ||
            (f.kind === 'conflict' && kindByKey.get(f.key) !== 'port'),
        )
        .map((f) => `${t.label}: ${f.key} (${f.kind})`);
    });
    checks.push(
      mkCheck(ctx.now, {
        id: 'environment.env.hygiene',
        domain: 'environment',
        result: issues.length ? 'warn' : 'pass',
        severity: issues.length ? 'low' : 'info',
        diagnosis: issues.length
          ? `${issues.length} entrada(s) inválida(s)/insegura(s)/duplicada(s) em .env`
          : 'arquivos .env sem problemas de higiene',
        evidence: issues.length
          ? boundEntries(ctx, issues).shown
          : [`${withEnv.length} arquivo(s) .env analisado(s)`],
        ...(issues.length ? { correctiveAction: 'fix flagged .env entries' } : {}),
        reversible: issues.length ? true : null,
      }),
    );

    const conflicts = withEnv.flatMap((t) => {
      const kindByKey = new Map(t.inspect.vars.map((v) => [v.key, v.kind] as const));
      return t.inspect.findings
        .filter((f) => f.kind === 'conflict' && kindByKey.get(f.key) === 'port')
        .map((f) => `${t.label}: ${f.key} (${f.detail})`);
    });
    checks.push(
      mkCheck(ctx.now, {
        id: 'environment.ports.conflict',
        domain: 'environment',
        result: conflicts.length ? 'warn' : 'pass',
        severity: conflicts.length ? 'medium' : 'info',
        diagnosis: conflicts.length
          ? `${conflicts.length} conflito(s) de porta declarado(s) em .env`
          : 'nenhum conflito de porta declarado em .env',
        evidence: conflicts.length
          ? boundEntries(ctx, conflicts).shown
          : ['análise estática de .env — sem probing de socket'],
        ...(conflicts.length ? { correctiveAction: 'assign distinct ports' } : {}),
        reversible: conflicts.length ? true : null,
      }),
    );
  }

  return checks;
}

// ---------------------------------------------------------------------------
// 4. hosts — adapter detection; auth unknown is honestly 'unverified'
// ---------------------------------------------------------------------------

export async function hostsChecks(ctx: DoctorCtx): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const sorted = [...ctx.adapters].sort((a, b) => a.id.localeCompare(b.id));
  for (const adapter of sorted) {
    const id = `hosts.${adapter.id}.detected`;
    let d: HostDetection | null = null;
    let probeErr: string | null = null;
    try {
      d = await adapter.detect(ctx.home);
    } catch (error) {
      probeErr = errMsg(error);
    }
    if (probeErr || !d) {
      checks.push(
        mkCheck(ctx.now, {
          id,
          domain: 'hosts',
          result: 'unverified',
          severity: 'info',
          diagnosis: `detecção do host ${adapter.id} falhou`,
          evidence: [`probe de detecção falhou: ${probeErr ?? 'sem resultado'}`],
          reversible: null,
        }),
      );
      continue;
    }
    if (!d.found) {
      checks.push(
        mkCheck(ctx.now, {
          id,
          domain: 'hosts',
          result: 'skip',
          severity: 'info',
          diagnosis: `host ${adapter.id} não detectado`,
          evidence: ['state=absent', d.detail ?? 'nenhum binário ou config encontrado'],
          reversible: null,
        }),
      );
      continue;
    }
    const evidence = [
      `state=${d.state}`,
      `version=${d.version ?? 'desconhecida'}`,
      ...(d.detail ? [`probe=${d.detail}`] : []),
      ...d.configPaths.map((p) => `config=${p}`),
    ];
    if (d.auth === 'verified') {
      checks.push(
        mkCheck(ctx.now, {
          id,
          domain: 'hosts',
          result: 'pass',
          severity: 'info',
          diagnosis: `host ${adapter.id} detectado e autenticado`,
          evidence: [...evidence, 'auth=verified'],
          reversible: null,
        }),
      );
    } else if (d.auth === 'absent') {
      checks.push(
        mkCheck(ctx.now, {
          id,
          domain: 'hosts',
          result: 'warn',
          severity: 'low',
          diagnosis: `host ${adapter.id} detectado sem autenticação`,
          evidence: [...evidence, 'probe documentado de auth: absent'],
          correctiveAction: 'authenticate the host CLI',
          reversible: false,
        }),
      );
    } else {
      checks.push(
        mkCheck(ctx.now, {
          id,
          domain: 'hosts',
          result: 'unverified',
          severity: 'info',
          diagnosis: `host ${adapter.id} detectado — autenticação não verificável`,
          evidence: [...evidence, 'no auth probe'],
          reversible: null,
        }),
      );
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// 5. operations — receipts, recurring failures, interrupted recovery
// ---------------------------------------------------------------------------

interface ParsedReport {
  results?: { repo?: { name?: unknown }; status?: unknown }[];
}

export function operationsChecks(ctx: DoctorCtx): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const reportsDir = path.join(artifactsRoot(ctx.root), 'reports');
  const allReports = (listDir(reportsDir) ?? []).filter((n) => n.endsWith('.json'));
  const capped = allReports.length > ctx.maxReceipts;
  if (capped) ctx.truncated.value = true;
  const scannedNames = [...allReports].sort().reverse().slice(0, ctx.maxReceipts);
  const parsedReports = scannedNames
    .map((n) => readJson(path.join(reportsDir, n)))
    .filter((r): r is { ok: true; value: unknown } => r.ok)
    .map((r) => r.value as ParsedReport);

  checks.push(
    mkCheck(
      ctx.now,
      !existsSync(reportsDir)
        ? {
            id: 'operations.receipts.recent',
            domain: 'operations',
            result: 'skip',
            severity: 'info',
            diagnosis: 'sem diretório de relatórios — nenhum recibo registrado',
            evidence: [`${reportsDir} ausente`],
            reversible: null,
          }
        : {
            id: 'operations.receipts.recent',
            domain: 'operations',
            result: 'pass',
            severity: 'info',
            diagnosis: `${allReports.length} relatório(s) encontrado(s); ${scannedNames.length} analisado(s)`,
            evidence: [
              `dir=${reportsDir}`,
              `relatórios=${allReports.length}`,
              `analisados=${scannedNames.length} (últimos ${ctx.maxReceipts})`,
              ...(capped ? ['varredura limitada — relatórios antigos não lidos'] : []),
            ],
            reversible: null,
          },
    ),
  );

  const failures = new Map<string, number>();
  for (const report of parsedReports) {
    for (const r of report?.results ?? []) {
      if (r?.status === 'error' && typeof r?.repo?.name === 'string') {
        failures.set(r.repo.name, (failures.get(r.repo.name) ?? 0) + 1);
      }
    }
  }
  for (const [name, entry] of Object.entries(ctx.state?.repos ?? {})) {
    if (entry.status === 'error') failures.set(name, (failures.get(name) ?? 0) + 1);
  }
  const recurring = [...failures.entries()].filter(([, n]) => n >= 2);
  const scannedAnything = existsSync(reportsDir) || ctx.state !== null;
  if (!scannedAnything) {
    checks.push(
      mkCheck(ctx.now, {
        id: 'operations.failures.recurring',
        domain: 'operations',
        result: 'skip',
        severity: 'info',
        diagnosis: 'sem relatórios ou estado para analisar falhas',
        evidence: ['sem .forge-cli/reports e sem state.json'],
        reversible: null,
      }),
    );
  } else {
    checks.push(
      mkCheck(ctx.now, {
        id: 'operations.failures.recurring',
        domain: 'operations',
        result: recurring.length ? 'warn' : 'pass',
        severity: recurring.length ? 'medium' : 'info',
        diagnosis: recurring.length
          ? `${recurring.length} Forja(s) com falhas recorrentes (≥2 registros)`
          : 'nenhuma falha recorrente registrada',
        evidence: failures.size
          ? boundEntries(
              ctx,
              [...failures.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([n, c]) => `${n}: ${c} falha(s)`),
            ).shown
          : [`${parsedReports.length} relatório(s) e state.json analisados — 0 falhas`],
        ...(recurring.length
          ? { correctiveAction: 're-run forge-cli install for affected repos' }
          : {}),
        reversible: recurring.length ? true : null,
      }),
    );
  }

  const interrupted = interruptedRuns(ctx.state);
  const allRecFiles = (listDir(artifactsRoot(ctx.root)) ?? []).filter((n) =>
    /^recovery.*\.json$/i.test(n),
  );
  const recFiles = boundEntries(ctx, allRecFiles).shown;
  const recEvidence = recFiles.map((f) => {
    const parsed = readJson(path.join(artifactsRoot(ctx.root), f));
    return `recovery file: ${f}${parsed.ok ? '' : ' (ilegível)'}`;
  });
  checks.push(
    mkCheck(
      ctx.now,
      interrupted.length || recFiles.length
        ? {
            id: 'operations.recovery.interrupted',
            domain: 'operations',
            result: 'warn',
            severity: 'medium',
            diagnosis: `${interrupted.length + allRecFiles.length} execução(ões) interrompida(s) registrada(s)`,
            evidence: boundEntries(ctx, [
              ...interrupted.map((i) => `${i.forge}: ${i.phase} → ${i.suggestion}`),
              ...recEvidence,
            ]).shown,
            correctiveAction: 'run forge-cli recover to review interrupted runs',
            reversible: true,
          }
        : {
            id: 'operations.recovery.interrupted',
            domain: 'operations',
            result: 'pass',
            severity: 'info',
            diagnosis: 'nenhuma execução interrompida registrada',
            evidence: [
              ctx.state ? 'state.json sem entradas interrompidas' : 'state.json ausente',
              'sem recovery*.json',
            ],
            reversible: null,
          },
    ),
  );

  return checks;
}
