/**
 * Doctor 2.0 — shared context & low-level helpers (spec C5/§5.1).
 * Everything injectable lives here: clock, home, host adapters, catalog and
 * scan bounds — so tests stay hermetic and timestamps stay honest.
 */

import { readdirSync, readFileSync } from 'node:fs';
import type { CliState } from '../artifacts.js';
import type { HostAdapter } from '../hosts/types.js';
import type { ForgeRepo } from '../types.js';
import type { DoctorCheck } from './model.js';

export interface Doctor2Options {
  /** Injected clock — every check timestamp comes from it (default: real ISO now). */
  now?: () => string;
  /** Home dir for host detection, ledger and backups (default: os.homedir()). */
  home?: string;
  /** Host adapters — tests inject hostAdapters(fakeProbe) (default: real set). */
  adapters?: readonly HostAdapter[];
  /** Declared repos (default: FORGE_REPOS merged with forge-cli.repos.json). */
  catalog?: readonly ForgeRepo[];
  /** Max report receipts scanned (default 20 — hit sets report.truncated). */
  maxReceipts?: number;
  /** Max entries per bounded listing (default 50 — hit sets report.truncated). */
  maxEntries?: number;
}

export const DEFAULT_MAX_RECEIPTS = 20;
export const DEFAULT_MAX_ENTRIES = 50;

export type Clock = () => string;

export interface DoctorCtx {
  /** Absolute workspace root under diagnosis. */
  root: string;
  home: string;
  now: Clock;
  catalog: readonly ForgeRepo[];
  adapters: readonly HostAdapter[];
  maxReceipts: number;
  maxEntries: number;
  /** .forge-cli/state.json loaded once — never assumed present. */
  state: CliState | null;
  /** Mutable flag — any bounded scan that hits its cap sets it. */
  truncated: { value: boolean };
}

/** Assemble a DoctorCheck stamping the injected clock. */
export function mkCheck(now: Clock, check: Omit<DoctorCheck, 'timestamp'>): DoctorCheck {
  return { ...check, timestamp: now() };
}

/** Sorted listing; null when the dir is absent or unreadable (never throws). */
export function listDir(dir: string): string[] | null {
  try {
    return readdirSync(dir).sort();
  } catch {
    return null;
  }
}

export function readJson(
  file: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    return { ok: false, error: errMsg(error) };
  }
}

/**
 * Bounded view over a listing — caps what reaches evidence and marks the
 * report truncated when content was left out.
 */
export function boundEntries(
  ctx: DoctorCtx,
  entries: readonly string[],
): { shown: string[]; total: number } {
  if (entries.length <= ctx.maxEntries) return { shown: [...entries], total: entries.length };
  ctx.truncated.value = true;
  return { shown: entries.slice(0, ctx.maxEntries), total: entries.length };
}

export function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
