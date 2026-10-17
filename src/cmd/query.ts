import { log, note } from '@clack/prompts';
import { loadState, openRunLog } from '../artifacts.js';
import { type CliOptions } from '../cli-args.js';
import { reposNeedingFix, runDoctor } from '../doctor.js';
import { pathStatus } from '../install.js';
import { collectStatus } from '../status.js';
import { listLine, renderReport } from '../report.js';
import type { RepoResult } from '../types.js';
import { S } from '../ui/strings.js';
import { icons, kindIcon, theme } from '../ui/theme.js';
import { cliHome, currentHead, hasGitRepo, resolveTargetDir } from '../utils/system.js';
import { localTags, remoteTags, updateCheck } from '../git-revs.js';
import { resolveInside } from '../safety.js';
import { existsSync } from 'node:fs';
import { loadForgeState, type RegistryInstallReceipt } from '../registry/install.js';
import { emitJson, catalogFor, reposByNames } from './shared.js';
import { processBatch } from './batch.js';
import {
  compatVerdict,
  defaultManifestPath,
  loadCompatManifest,
  readDeclaredVersion,
} from '../compat.js';

export async function runDoctorCommand(cli: CliOptions, names: string[] = []): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const picked = reposByNames(catalogFor(targetDir), names);
  if ('error' in picked) {
    log.error(picked.error);
    process.exit(2);
  }
  const results = await runDoctor(picked, targetDir);
  if ((await pathStatus()) === 'missing') log.warn(S.doctorPathMissing);
  const body = results
    .map((r) => {
      const badge =
        r.status === 'ok'
          ? `${icons.ok} ${theme.ok(S.labelOk)}`
          : r.status === 'fail'
            ? `${icons.err} ${theme.err(S.labelErr)}`
            : `${icons.warn} ${theme.warn('skip')}`;
      const prereqPart = r.prereqFails?.length
        ? ` ${theme.err(`· ${S.doctorPrereqsFail}: ${r.prereqFails.join(', ')}`)}`
        : '';
      return `${badge} ${kindIcon[r.repo.kind]} ${r.repo.name} — ${theme.dim(r.detail)}${prereqPart}`;
    })
    .join('\n');
  if (cli.jsonReport) {
    emitJson(
      results.map((r) => ({
        name: r.repo.name,
        status: r.status,
        detail: r.detail,
        prereqFails: r.prereqFails ?? [],
      })),
      results.some((r) => r.status === 'fail') ? 1 : 0,
    );
  }
  note(body, S.doctorTitle);

  if (!cli.fix) {
    process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
    return;
  }

  const fixing = reposNeedingFix(results);
  const skipped = results.filter((r) => r.status === 'skipped');
  if (!fixing.length && !skipped.length) {
    log.success(S.doctorAllOk);
    process.exit(0);
    return;
  }
  if (skipped.length) {
    log.warn(`${S.doctorNeedsInstall}: ${skipped.map((r) => r.repo.name).join(', ')}`);
  }
  let fixResults: RepoResult[] = [];
  if (fixing.length) {
    log.step(`${S.doctorFixing} ${fixing.map((r) => r.name).join(', ')}`);
    const runLog = openRunLog(targetDir);
    fixResults = await processBatch(fixing, targetDir, {}, runLog.write);
    log.info(`${S.logSaved} ${theme.dim(runLog.file)}`);
    renderReport(fixResults);
  }
  const healed = fixing.length === fixResults.filter((r) => r.status === 'ok').length;
  process.exit(healed && !skipped.length ? 0 : 1);
}

export async function runListCommand(cli: CliOptions): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const state = loadState(targetDir);
  const registry = loadForgeState(cliHome()).forges;
  const body = catalogFor(targetDir)
    .map((repo) => {
      const line = listLine(repo, state?.repos[repo.name]);
      const reg = registry[repo.name];
      return reg ? `${line} ${theme.dim(`+ pypi ${reg.dist}==${reg.version}`)}` : line;
    })
    .join('\n');
  if (cli.jsonReport) {
    emitJson(
      catalogFor(targetDir).map((repo) => ({
        name: repo.name,
        url: repo.url,
        description: repo.description,
        last: state?.repos[repo.name] ?? null,
        registry: registry[repo.name]
          ? { dist: registry[repo.name].dist, version: registry[repo.name].version }
          : null,
      })),
    );
  }
  note(body, S.listTitle);
  process.exit(0);
}

/**
 * Mescla o estado registry no status git. Receipt com bin ausente é
 * drift (venv apagada depois da instalação), não "installed" — o mesmo
 * existsSync que `forge-cli registry` usa, para os dois comandos
 * concordarem.
 */
export function mergeRegistryPhase(
  infos: { name: string; phase: string; describe?: string }[],
  registry: Record<string, RegistryInstallReceipt>,
): void {
  for (const i of infos) {
    // Registry é dado não confiável (state.json pode estar malformado):
    // own-property + campos checados — 'constructor' não casa e um
    // receipt sem `verify`/`bin` não derruba o status.
    const reg = Object.hasOwn(registry, i.name) ? registry[i.name] : undefined;
    if (!reg || typeof reg !== 'object') continue;
    const tag = `pypi ${reg.dist ?? '?'}==${reg.version ?? '?'}`;
    const binMissing = typeof reg.bin !== 'string' || !existsSync(reg.bin);
    if (binMissing) {
      if (i.phase === 'not-installed' || i.phase === 'installed') i.phase = 'drifted';
      i.describe = [i.describe, `${tag} (bin ausente)`].filter(Boolean).join(' + ');
    } else if (i.phase === 'not-installed') {
      i.phase = 'installed';
      i.describe = `${tag}${reg.verify?.ok ? '' : ' (verify falhou)'}`;
    } else {
      i.describe = [i.describe, tag].filter(Boolean).join(' + ');
    }
  }
}

export async function runStatusCommand(cli: CliOptions, names: string[]): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const catalog = catalogFor(targetDir);
  const wanted = names.length ? catalog.filter((r) => names.includes(r.name)) : catalog;
  const infos = await collectStatus(wanted, targetDir, loadState(targetDir));
  mergeRegistryPhase(infos, loadForgeState(cliHome()).forges);
  const label: Record<string, string> = {
    'not-installed': S.statusNotInstalled,
    cloned: S.statusCloned,
    prepared: S.statusPrepared,
    installed: S.statusInstalled,
    validated: S.statusValidated,
    partial: S.statusPartial,
    failed: S.statusFailed,
    drifted: S.statusDrifted,
  };
  const body = infos
    .map((i) => {
      const ver = i.describe ?? i.head;
      const extra = [ver, i.dirty ? S.warnDirtyTree : undefined].filter(Boolean).join(' · ');
      return `${i.name} — ${label[i.phase]}${extra ? theme.dim(` (${extra})`) : ''}`;
    })
    .join('\n');
  if (cli.jsonReport) emitJson(infos);
  note(body, S.statusTitle);
  process.exit(0);
}

export async function runUpdateCheckCommand(cli: CliOptions, names: string[]): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const picked = reposByNames(catalogFor(targetDir), names);
  if ('error' in picked) {
    log.error(picked.error);
    process.exit(2);
  }
  const lines: string[] = [];
  const rows: {
    name: string;
    state: string;
    behind: number;
    ahead: number;
    failure?: string;
    installed_compat?: string;
  }[] = [];
  const manifest = loadCompatManifest(defaultManifestPath(targetDir));
  const compatOf = (repoName: string, repoDir: string): string | undefined => {
    if (!manifest) return undefined;
    const version = readDeclaredVersion(repoDir);
    return version === null ? 'unknown' : compatVerdict(manifest, repoName, version);
  };
  lines.push(
    manifest
      ? `compat manifest: ${manifest.release} (sha256:${manifest.fileSha256.slice(0, 12)})`
      : `compat manifest: unavailable — ${defaultManifestPath(targetDir)} not found`,
  );
  let pending = 0;
  for (const repo of picked) {
    const dir = resolveInside(targetDir, repo.name);
    if (!dir || !hasGitRepo(dir)) {
      lines.push(`${repo.name} — ${S.statusNotInstalled}`);
      rows.push({ name: repo.name, state: 'not-installed', behind: 0, ahead: 0 });
      continue;
    }
    const compat = compatOf(repo.name, dir);
    const check = await updateCheck(dir);
    if (check.failure) {
      const label =
        check.failure === 'no-upstream'
          ? S.updateNoUpstream
          : `${S.updateCheckFailed} (${check.failure})`;
      lines.push(`${repo.name} — ${theme.warn(label)}`);
      rows.push({ name: repo.name, state: 'unknown', behind: 0, ahead: 0, failure: check.failure });
    } else if (check.behind > 0) {
      pending++;
      lines.push(
        `${repo.name} — ${theme.accent(`${check.behind} ${S.updateCommitsBehind}`)}${compat ? ` · installed-compat:${compat}` : ''}`,
      );
      rows.push({
        name: repo.name,
        state: 'behind',
        behind: check.behind,
        ahead: check.ahead,
        ...(compat ? { installed_compat: compat } : {}),
      });
    } else {
      lines.push(
        `${repo.name} — ${theme.ok(S.updateUpToDate)}${compat ? ` · installed-compat:${compat}` : ''}`,
      );
      rows.push({
        name: repo.name,
        state: 'up-to-date',
        behind: 0,
        ahead: check.ahead,
        ...(compat ? { installed_compat: compat } : {}),
      });
    }
  }
  if (cli.jsonReport) {
    emitJson(
      {
        manifest: manifest
          ? { release: manifest.release, sha256: manifest.fileSha256, path: manifest.path }
          : null,
        repos: rows,
      },
      pending > 0 ? 1 : 0,
    );
  }
  note(lines.join('\n'), S.updateCheckTitle);
  process.exit(pending > 0 ? 1 : 0);
}

export async function runVersionsCommand(cli: CliOptions, names: string[]): Promise<void> {
  const targetDir = resolveTargetDir(cli.dir);
  const picked = reposByNames(catalogFor(targetDir), names);
  if ('error' in picked) {
    log.error(picked.error);
    process.exit(2);
  }
  const lines: string[] = [];
  const rows: { name: string; source: string; revision?: string; tags: string[] | null }[] = [];
  for (const repo of picked) {
    const dir = resolveInside(targetDir, repo.name);
    if (dir && hasGitRepo(dir)) {
      const head = (await currentHead(dir))?.slice(0, 7) ?? '?';
      const tags = await localTags(dir);
      rows.push({ name: repo.name, source: 'local', revision: head, tags });
      lines.push(
        `${theme.accent(repo.name)} — ${S.versionsRevision} ${head} · ${S.versionsTags}: ${tags.length ? tags.join(', ') : S.planNone}`,
      );
    } else {
      const tags = await remoteTags(repo.url);
      rows.push({ name: repo.name, source: tags === null ? 'unavailable' : 'remote', tags });
      lines.push(
        `${theme.accent(repo.name)} — ${S.statusNotInstalled} · ${S.versionsTags}: ${tags === null ? S.versionsUnavailable : tags.length ? tags.join(', ') : S.planNone}`,
      );
    }
  }
  if (cli.jsonReport) emitJson(rows);
  note(lines.join('\n'), S.versionsTitle);
  process.exit(0);
}
