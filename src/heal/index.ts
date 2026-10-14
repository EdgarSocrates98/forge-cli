/** Self-healing surface (spec C5/§5.2): model + registry + catalog + flow. */
export type {
  PlannedRepair,
  RepairAction,
  RepairContext,
  RepairPlan,
  RepairReceipt,
  RepairReceiptEntry,
  RepairStatus,
  RepairStep,
  RiskClass,
} from './types.js';
export { REPAIR_REGISTRY, classifyFindings } from './registry.js';
export {
  REPAIR_ACTIONS,
  FORGE_DIR_SUBDIRS,
  LOCKFILE_CHECK_COMMAND,
  LOCKFILE_REGEN_COMMAND,
  backupRestoreRepair,
  envMissingKeyRepair,
  forgeDirRepair,
  listBackups,
  lockfileDriftRepair,
  missingEnvKeys,
  restoreTargetFor,
} from './fixes.js';
export type { BackupCandidate, HealContext } from './fixes.js';
export { healReceiptPath, planRepairs, runHealFlow } from './flow.js';
export type { HealFlowOptions, PlannedItem } from './flow.js';
