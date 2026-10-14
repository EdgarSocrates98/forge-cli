/**
 * Self-healing flow (spec C5/§5.2) — the mandatory eight steps:
 *
 *   Diagnose → Identify Fix → Plan → Assess Risk → Confirm → Apply → Verify → Receipt
 *
 * Nothing is applied silently: every receipt entry carries evidence, and
 * risk classes gate apply — UNSUPPORTED is refused, MANUAL_ONLY is only
 * diagnosed + planned, REVIEW_REQUIRED needs interactive confirmation or
 * `--yes` plus an explicit review allowance, SAFE_AUTOMATIC applies unless
 * confirmation was refused outright ('never').
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { artifactsRoot } from '../artifacts.js';
import type { DoctorCheck } from '../doctor2/model.js';
import { redactSecrets, writeFileAtomic } from '../safety.js';
import type { HealContext } from './fixes.js';
import { classifyFindings } from './registry.js';
import type { PlannedRepair, RepairPlan, RepairReceipt, RepairReceiptEntry } from './types.js';

export interface HealFlowOptions {
  /** Workspace/repo root the diagnosis ran against. */
  root: string;
  /** Plan only — never applies, never asks. */
  dryRun?: boolean;
  /** How application was confirmed: interactive user, --yes flag, or never. */
  confirmed: 'user' | 'flag' | 'never';
  /**
   * Flag-mode opt-in required on top of `confirmed: 'flag'` before any
   * REVIEW_REQUIRED repair may apply — a bare --yes never auto-applies
   * reviewable repairs.
   */
  allowReviewRequired?: boolean;
  /** Interactive review: receives the full plan; true approves REVIEW_REQUIRED items. */
  confirmCallback?: (plan: RepairPlan) => Promise<boolean>;
  /** Injected clock for generatedAt/receipt naming (defaults to ISO now). */
  now?: () => string;
  /** Root-relative backup file selected during review (installation.backup.restore). */
  backup?: string;
}

/** Where the receipt for a run lands: <root>/.forge-cli/receipts/heal-<ts>.json. */
export function healReceiptPath(root: string, generatedAt: string): string {
  const stamp = generatedAt.replace(/[:.]/g, '-');
  return path.join(artifactsRoot(root), 'receipts', `heal-${stamp}.json`);
}

export interface PlannedItem {
  repair: PlannedRepair;
  /** Set when action.plan() threw — the flow records it as 'failed'. */
  planError?: string;
}

/**
 * Steps 1–4 of the flow: classify every finding, then compute concrete
 * steps for the checks that have a registered repair. Deterministic —
 * items are sorted by check id.
 */
export async function planRepairs(
  checks: readonly DoctorCheck[],
  opts: { root: string; dryRun?: boolean; backup?: string; now?: () => string },
): Promise<{ plan: RepairPlan; items: PlannedItem[] }> {
  const classified = classifyFindings(checks);
  const items: PlannedItem[] = [];
  for (const repair of classified) {
    if (!repair.action) {
      items.push({ repair });
      continue;
    }
    const ctx: HealContext = {
      root: opts.root,
      dryRun: opts.dryRun === true,
      check: repair.check,
      ...(opts.backup ? { backup: opts.backup } : {}),
    };
    try {
      const steps = await repair.action.plan(ctx);
      items.push({ repair: { ...repair, steps } });
    } catch (error) {
      items.push({
        repair,
        planError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const plan: RepairPlan = {
    schema: 'forge/RepairPlan/v1',
    generatedAt: (opts.now ?? (() => new Date().toISOString()))(),
    root: opts.root,
    items: items.map((i) => i.repair),
  };
  return { plan, items };
}

const entry = (
  item: PlannedItem,
  status: RepairReceiptEntry['status'],
  evidence: string,
  verified: boolean | null,
): RepairReceiptEntry => ({
  actionId: item.repair.action?.id ?? `unsupported:${item.repair.check.id}`,
  checkId: item.repair.check.id,
  riskClass: item.repair.riskClass,
  status,
  evidence,
  verified,
});

/**
 * The full eight-step heal flow. Diagnosis arrives as `checks`; the flow
 * identifies fixes, plans them, gates by risk class + confirmation mode,
 * applies, verifies and finally persists + returns a RepairReceipt.
 */
export async function runHealFlow(
  checks: readonly DoctorCheck[],
  opts: HealFlowOptions,
): Promise<RepairReceipt> {
  const now = opts.now ?? (() => new Date().toISOString());
  const dryRun = opts.dryRun === true;

  // Steps 1–4: Diagnose → Identify Fix → Plan → Assess Risk.
  const { plan, items } = await planRepairs(checks, {
    root: opts.root,
    dryRun,
    now,
    ...(opts.backup ? { backup: opts.backup } : {}),
  });

  // Step 5: Confirm — a single interactive review gates every
  // REVIEW_REQUIRED item; 'flag' needs the explicit review allowance.
  const needsReview = items.some(
    (i) =>
      i.repair.riskClass === 'REVIEW_REQUIRED' && i.repair.check.result !== 'pass' && !i.planError,
  );
  let reviewApproved = false;
  if (!dryRun && needsReview && opts.confirmed === 'user' && opts.confirmCallback) {
    reviewApproved = await opts.confirmCallback(plan);
  }

  // Steps 6–7: Apply + Verify, in deterministic (sorted) order.
  const entries: RepairReceiptEntry[] = [];
  for (const item of items) {
    const { repair } = item;
    const { check, action, riskClass } = repair;

    if (check.result === 'pass') {
      entries.push(entry(item, 'skipped', 'already passing', true));
      continue;
    }
    if (!action || riskClass === 'UNSUPPORTED') {
      entries.push(entry(item, 'refused', 'no supported repair', null));
      continue;
    }
    if (item.planError) {
      entries.push(entry(item, 'failed', `plan failed: ${item.planError}`, false));
      continue;
    }
    if (riskClass === 'MANUAL_ONLY') {
      entries.push(entry(item, 'skipped', 'manual-only fix', null));
      continue;
    }
    if (dryRun) {
      entries.push(entry(item, 'skipped', 'dry-run — plan only', null));
      continue;
    }
    if (riskClass === 'REVIEW_REQUIRED') {
      const approved =
        opts.confirmed === 'user'
          ? reviewApproved
          : opts.confirmed === 'flag' && opts.allowReviewRequired === true;
      if (!approved) {
        entries.push(entry(item, 'skipped', 'awaiting confirmation', null));
        continue;
      }
    }
    if (riskClass === 'SAFE_AUTOMATIC' && opts.confirmed === 'never') {
      entries.push(entry(item, 'skipped', 'not confirmed (mode: never)', null));
      continue;
    }

    const ctx: HealContext = {
      root: opts.root,
      dryRun: false,
      check,
      now,
      ...(opts.backup ? { backup: opts.backup } : {}),
    };
    let summary: string;
    try {
      summary = await action.apply(ctx);
    } catch (error) {
      entries.push(
        entry(
          item,
          'failed',
          `apply failed: ${error instanceof Error ? error.message : String(error)}`,
          false,
        ),
      );
      continue;
    }
    let verified: boolean;
    try {
      verified = await action.verify(ctx);
    } catch {
      verified = false;
    }
    entries.push(
      verified
        ? entry(item, 'verified', `${summary} · verify ok`, true)
        : entry(item, 'failed', `${summary} · verify failed`, false),
    );
  }

  // Step 8: Receipt — persisted atomically under .forge-cli/receipts/ and returned.
  const generatedAt = now();
  const receipt: RepairReceipt = {
    schema: 'forge/RepairReceipt/v1',
    generatedAt,
    root: opts.root,
    confirmedBy: opts.confirmed,
    entries,
    verifiedAll: entries.every((e) => e.verified === true),
  };
  const file = healReceiptPath(opts.root, generatedAt);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, redactSecrets(JSON.stringify(receipt, null, 2)));
  return receipt;
}
