/**
 * Doctor 2.0 — shared model (spec C5/§5.1).
 *
 * Contract for both the check engine (src/doctor2/) and self-healing
 * (src/heal/): heal consumes `DoctorCheck` findings and classifies fixes
 * by check id — never invents repairs for unknown checks.
 */

export type DoctorDomain = 'system' | 'installation' | 'environment' | 'hosts' | 'operations';

export type CheckResult = 'pass' | 'warn' | 'fail' | 'skip' | 'unverified';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface DoctorCheck {
  /** Stable id, e.g. `system.runtime.node` — heal registry keys on this. */
  id: string;
  domain: DoctorDomain;
  result: CheckResult;
  severity: Severity;
  /** What was found, in plain language. */
  diagnosis: string;
  /** What was observed — real evidence only, never fabricated. */
  evidence: string[];
  /** Suggested fix description (diagnostic hint, not an executed action). */
  correctiveAction?: string;
  /** Whether the suggested correction is reversible; null when N/A. */
  reversible: boolean | null;
  /** ISO timestamp — injected clock, never hidden wall-clock. */
  timestamp: string;
}

/**
 * Health score (§5.1): exists only under a transparent model — weights
 * documented, sufficiency gate enforced. When fewer than `required`
 * evidence-backed checks ran, `value` is null → render UNVERIFIED,
 * never a partial observation dressed as 100%.
 */
export interface HealthScore {
  /** 0–100, or null when observation is insufficient. */
  value: number | null;
  /** Model identifier — bumps when weights change. */
  model: 'forge-health/v1';
  weights: Record<DoctorDomain, number>;
  sufficiency: { required: number; observed: number; sufficient: boolean };
  /** Which domains contributed to the score. */
  domains: Record<DoctorDomain, { checks: number; failed: number; warned: number }>;
}

export interface DoctorReport {
  schema: 'forge/DoctorReport/v1';
  generatedAt: string;
  checks: DoctorCheck[];
  score: HealthScore;
  /** true when the scan was bounded (not exhaustive). */
  truncated: boolean;
}

/** Deterministic score — documented in docs/roadmap/HEALTH_MODEL.md. */
export const HEALTH_WEIGHTS: Record<DoctorDomain, number> = {
  system: 15,
  installation: 25,
  environment: 20,
  hosts: 15,
  operations: 25,
};

const SEVERITY_DEDUCTION: Record<Severity, number> = {
  info: 0,
  low: 3,
  medium: 8,
  high: 15,
  critical: 30,
};

/** Minimum evidence-backed checks before a score may be emitted. */
export const HEALTH_MIN_CHECKS = 8;

export function computeHealthScore(checks: readonly DoctorCheck[]): HealthScore {
  const observed = checks.filter((c) => c.evidence.length > 0 && c.result !== 'unverified').length;
  const sufficient = observed >= HEALTH_MIN_CHECKS;
  const zero = () => ({ checks: 0, failed: 0, warned: 0 });
  const domains: Record<DoctorDomain, { checks: number; failed: number; warned: number }> = {
    system: zero(),
    installation: zero(),
    environment: zero(),
    hosts: zero(),
    operations: zero(),
  };
  let deduction = 0;
  for (const c of checks) {
    const d = (domains[c.domain] ??= { checks: 0, failed: 0, warned: 0 });
    d.checks += 1;
    if (c.result === 'fail') {
      d.failed += 1;
      deduction += SEVERITY_DEDUCTION[c.severity] * (HEALTH_WEIGHTS[c.domain] / 25);
    } else if (c.result === 'warn') {
      d.warned += 1;
      deduction += (SEVERITY_DEDUCTION[c.severity] / 2) * (HEALTH_WEIGHTS[c.domain] / 25);
    }
  }
  return {
    value: sufficient ? Math.max(0, Math.round(100 - deduction)) : null,
    model: 'forge-health/v1',
    weights: { ...HEALTH_WEIGHTS },
    sufficiency: { required: HEALTH_MIN_CHECKS, observed, sufficient },
    domains,
  };
}
