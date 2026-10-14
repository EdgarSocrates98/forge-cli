/**
 * Repair registry (spec C5/§5.2) — maps DoctorCheck.id → RepairAction.
 *
 * Every finding gets a PlannedRepair row, including unknown check ids:
 * those classify as UNSUPPORTED with `action: null` — diagnosed only,
 * never default-applied.
 */

import type { DoctorCheck } from '../doctor2/model.js';
import { REPAIR_ACTIONS } from './fixes.js';
import type { PlannedRepair, RepairAction } from './types.js';

/** RepairAction lookup keyed by the DoctorCheck.id it answers. */
export const REPAIR_REGISTRY: Map<string, RepairAction> = new Map(
  REPAIR_ACTIONS.map((action) => [action.checkId, action]),
);

/**
 * Classify findings into planned repairs. Output is deterministic —
 * sorted by check id — and lossless: every input check produces a row.
 * Steps are computed later by the flow (plan() needs a RepairContext).
 */
export function classifyFindings(checks: readonly DoctorCheck[]): PlannedRepair[] {
  return [...checks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((check) => {
      const action = REPAIR_REGISTRY.get(check.id) ?? null;
      return {
        check,
        action,
        riskClass: action?.riskClass ?? 'UNSUPPORTED',
        steps: [],
      };
    });
}
