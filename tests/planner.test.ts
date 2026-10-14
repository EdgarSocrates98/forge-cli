import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  canonicalJson,
  filterSteps,
  planHash,
  predictedChanges,
  SELECTABLE_STEPS,
  verifyPlan,
  type PlanForge,
} from '../src/planner.js';
import { contractValidator } from '../src/contracts/index.js';

const forge: PlanForge = {
  forge_id: 'the-forge',
  repo: 'the-forge',
  target_dir: '/ws/the-forge',
  actions: [
    {
      kind: 'clone',
      label: 'git clone the-forge',
      argv: ['git', 'clone', 'url'],
      reversible: true,
    },
    { kind: 'env', label: 'provision .env', paths: ['the-forge/.env'], reversible: false },
    {
      kind: 'native',
      label: 'theforge install apply',
      argv: ['theforge', 'install', 'apply'],
      reversible: false,
      non_reversible_effects: ['host configs'],
    },
  ],
};

describe('canonical plan hashing', () => {
  it('canonical JSON sorts keys deterministically', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('buildPlan emits a valid ForgeOperationPlan/v1 document', () => {
    const plan = buildPlan({ forges: [forge], now: new Date('2026-10-14T10:00:00Z') });
    const errors = contractValidator().validate('forge/ForgeOperationPlan/v1', plan);
    expect(errors).toEqual([]);
    expect(plan.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash is stable across key ordering', () => {
    const doc = {
      schema: 'forge/ForgeOperationPlan/v1' as const,
      plan_id: 'p',
      created_at: '2026-10-14T10:00:00Z',
      expires_at: '2026-10-14T10:15:00Z',
      source: 'cli' as const,
      forges: [forge],
    };
    const reordered = {
      forges: doc.forges,
      source: doc.source,
      expires_at: doc.expires_at,
      created_at: doc.created_at,
      plan_id: doc.plan_id,
      schema: doc.schema,
    };
    expect(planHash(doc)).toBe(planHash(reordered));
  });
});

describe('verifyPlan — approval integrity (§2.6, §8)', () => {
  const now = new Date('2026-10-14T10:00:00Z');

  it('accepts a fresh unmodified plan', () => {
    const plan = buildPlan({ forges: [forge], now });
    expect(verifyPlan(plan, new Date('2026-10-14T10:05:00Z'))).toEqual({ ok: true });
  });

  it('refuses a mutated plan (hash mismatch)', () => {
    const plan = buildPlan({ forges: [forge], now });
    plan.forges[0].actions.push({ kind: 'script', label: 'evil', reversible: false });
    expect(verifyPlan(plan)).toEqual({ ok: false, reason: 'hash-mismatch' });
  });

  it('refuses an expired plan', () => {
    const plan = buildPlan({ forges: [forge], now });
    expect(verifyPlan(plan, new Date('2026-10-14T10:20:00Z'))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses malformed plans without throwing', () => {
    expect(verifyPlan({} as never).ok).toBe(false);
    expect(verifyPlan(null as never).ok).toBe(false);
  });
});

describe('selectable steps (§2.6)', () => {
  it('exposes exactly the six spec step kinds', () => {
    expect(SELECTABLE_STEPS).toEqual([
      'clone',
      'binary',
      'skills',
      'agents',
      'mcp',
      'host-integration',
    ]);
  });

  it('filterSteps keeps non-selectable actions, drops unselected selectable ones', () => {
    const filtered = filterSteps(forge.actions, ['clone']);
    // 'env' and 'verify' are not selectable — they stay; 'native' isn't in
    // SELECTABLE_STEPS either (it maps to components) so it also stays.
    expect(filtered.length).toBe(forge.actions.length);
    const noClone = filterSteps(forge.actions, ['binary']);
    expect(noClone.some((a) => a.kind === 'clone')).toBe(false);
  });
});

describe('predictedChanges', () => {
  it('summarizes files, commands and reversibility honestly', () => {
    const changes = predictedChanges(forge);
    expect(changes.files).toEqual(['the-forge/.env']);
    expect(changes.commands).toContain('git clone url');
    expect(changes.reversible).toBe(false); // has non-reversible actions
  });
});
