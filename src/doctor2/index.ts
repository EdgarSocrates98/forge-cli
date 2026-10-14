/**
 * Doctor 2.0 — orchestration entry point (spec C5/§5.1).
 *
 * `runDoctor2(root, opts)` produces a `forge/DoctorReport/v1`: five domains
 * of evidence-backed checks, deterministic ordering (sorted by check id),
 * a health score gated on sufficiency, and honest `unverified`/`skip`
 * results wherever nothing can be proven. No network, no hidden wall-clock
 * (timestamps come from opts.now), every file walk is bounded.
 */

import os from 'node:os';
import path from 'node:path';
import { loadCustomRepos, loadState, mergeCatalog } from '../artifacts.js';
import { FORGE_REPOS } from '../constants/repos.js';
import { hostAdapters } from '../hosts/index.js';
import type { ForgeRepo } from '../types.js';
import {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_RECEIPTS,
  errMsg,
  mkCheck,
  type Doctor2Options,
  type DoctorCtx,
} from './context.js';
import {
  environmentChecks,
  hostsChecks,
  installationChecks,
  operationsChecks,
  systemChecks,
} from './domains.js';
import {
  computeHealthScore,
  type DoctorCheck,
  type DoctorDomain,
  type DoctorReport,
} from './model.js';

export type { Doctor2Options } from './context.js';
export { renderDoctorReport, strings } from './render.js';
export * from './model.js';

function defaultCatalog(root: string): ForgeRepo[] {
  const custom = loadCustomRepos(root);
  return custom && 'repos' in custom ? mergeCatalog(FORGE_REPOS, custom.repos) : [...FORGE_REPOS];
}

export async function runDoctor2(root: string, opts: Doctor2Options = {}): Promise<DoctorReport> {
  const now = opts.now ?? (() => new Date().toISOString());
  const resolved = path.resolve(root);
  const ctx: DoctorCtx = {
    root: resolved,
    home: opts.home ?? os.homedir(),
    now,
    catalog: opts.catalog ?? defaultCatalog(resolved),
    adapters: opts.adapters ?? hostAdapters(),
    maxReceipts: opts.maxReceipts ?? DEFAULT_MAX_RECEIPTS,
    maxEntries: opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
    state: loadState(resolved),
    truncated: { value: false },
  };

  const checks: DoctorCheck[] = [];
  const collect = (domain: DoctorDomain, produce: () => DoctorCheck[]): void => {
    try {
      checks.push(...produce());
    } catch (error) {
      checks.push(
        mkCheck(now, {
          id: `${domain}.unhandled`,
          domain,
          result: 'unverified',
          severity: 'info',
          diagnosis: 'verificação não pôde ser executada',
          evidence: [`erro interno: ${errMsg(error)}`],
          reversible: null,
        }),
      );
    }
  };

  collect('system', () => systemChecks(ctx));
  collect('installation', () => installationChecks(ctx));
  collect('environment', () => environmentChecks(ctx));
  try {
    checks.push(...(await hostsChecks(ctx)));
  } catch (error) {
    checks.push(
      mkCheck(now, {
        id: 'hosts.unhandled',
        domain: 'hosts',
        result: 'unverified',
        severity: 'info',
        diagnosis: 'verificação de hosts não pôde ser executada',
        evidence: [`erro interno: ${errMsg(error)}`],
        reversible: null,
      }),
    );
  }
  collect('operations', () => operationsChecks(ctx));

  checks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schema: 'forge/DoctorReport/v1',
    generatedAt: now(),
    checks,
    score: computeHealthScore(checks),
    truncated: ctx.truncated.value,
  };
}
