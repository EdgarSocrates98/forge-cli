/**
 * Self-healing model (spec C5/§5.2).
 *
 * Risk classes gate everything: an unmapped check id is UNSUPPORTED and
 * can only ever be diagnosed — the eight-step flow refuses to plan it.
 */

import type { DoctorCheck } from '../doctor2/model.js';

export type RiskClass = 'SAFE_AUTOMATIC' | 'REVIEW_REQUIRED' | 'MANUAL_ONLY' | 'UNSUPPORTED';

export type RepairStatus = 'pending' | 'applied' | 'verified' | 'failed' | 'skipped' | 'refused';

export interface RepairStep {
  /** Human-readable step, e.g. "restore .env missing keys from backup". */
  description: string;
  /** File paths the step touches — shown in review before apply. */
  touches: string[];
}

export interface RepairAction {
  id: string;
  /** The DoctorCheck.id this repair answers. */
  checkId: string;
  description: string;
  riskClass: Exclude<RiskClass, 'UNSUPPORTED'>;
  reversible: boolean;
  /** Concrete steps — produced at plan time, reviewed before apply. */
  plan(ctx: RepairContext): RepairStep[] | Promise<RepairStep[]>;
  /** Apply the planned steps. Throws on failure; must be idempotent. */
  apply(ctx: RepairContext): Promise<string>; // returns evidence summary
  /** Post-apply verification — re-runs the check or equivalent probe. */
  verify(ctx: RepairContext): Promise<boolean>;
}

export interface RepairContext {
  /** Repo/workspace root the diagnosis ran against. */
  root: string;
  /** Dry-run flag — plan() may compute steps without side effects. */
  dryRun: boolean;
}

export interface PlannedRepair {
  check: DoctorCheck;
  action: RepairAction | null; // null → UNSUPPORTED, diagnose-only
  riskClass: RiskClass;
  steps: RepairStep[]; // empty for UNSUPPORTED
}

export interface RepairPlan {
  schema: 'forge/RepairPlan/v1';
  generatedAt: string;
  root: string;
  items: PlannedRepair[];
}

export interface RepairReceiptEntry {
  actionId: string;
  checkId: string;
  riskClass: RiskClass;
  status: RepairStatus;
  evidence: string;
  verified: boolean | null;
}

export interface RepairReceipt {
  schema: 'forge/RepairReceipt/v1';
  generatedAt: string;
  root: string;
  confirmedBy: 'user' | 'flag' | 'never';
  entries: RepairReceiptEntry[];
  verifiedAll: boolean;
}
