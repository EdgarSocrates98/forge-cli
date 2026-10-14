import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DoctorCheck } from '../src/doctor2/model.js';
import {
  backupRestoreRepair,
  lockfileDriftRepair,
  missingEnvKeys,
  restoreTargetFor,
} from '../src/heal/fixes.js';
import type { HealContext } from '../src/heal/fixes.js';
import { healReceiptPath, planRepairs, runHealFlow } from '../src/heal/flow.js';
import { classifyFindings, REPAIR_REGISTRY } from '../src/heal/registry.js';
import type { RepairAction } from '../src/heal/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-heal-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = '2026-01-02T03:04:05.000Z';
const now = () => NOW;

function check(id: string, over: Partial<DoctorCheck> = {}): DoctorCheck {
  return {
    id,
    domain: 'installation',
    result: 'fail',
    severity: 'high',
    diagnosis: `diagnosis for ${id}`,
    evidence: [`evidence for ${id}`],
    reversible: null,
    timestamp: NOW,
    ...over,
  };
}

function envCheck(over: Partial<DoctorCheck> = {}): DoctorCheck {
  return check('environment.env.missing-key', { domain: 'environment', ...over });
}

function receiptFileFor(d: string): string {
  return healReceiptPath(d, NOW);
}

describe('REPAIR_REGISTRY + classifyFindings', () => {
  it('registers exactly the four documented check ids', () => {
    expect([...REPAIR_REGISTRY.keys()].sort()).toEqual(
      [
        'environment.env.missing-key',
        'installation.backup.restore',
        'installation.forge-dir.absent',
        'installation.lockfile.drift',
      ].sort(),
    );
  });

  it('classifies unknown check ids as UNSUPPORTED with action null', () => {
    const [row] = classifyFindings([check('system.runtime.node')]);
    expect(row.action).toBeNull();
    expect(row.riskClass).toBe('UNSUPPORTED');
    expect(row.steps).toEqual([]);
  });

  it('maps each known check id to its documented risk class', () => {
    const rows = classifyFindings([
      check('installation.forge-dir.absent'),
      envCheck(),
      check('installation.lockfile.drift'),
      check('installation.backup.restore'),
    ]);
    const byId = new Map(rows.map((r) => [r.check.id, r.riskClass]));
    expect(byId.get('installation.forge-dir.absent')).toBe('SAFE_AUTOMATIC');
    expect(byId.get('environment.env.missing-key')).toBe('REVIEW_REQUIRED');
    expect(byId.get('installation.lockfile.drift')).toBe('MANUAL_ONLY');
    expect(byId.get('installation.backup.restore')).toBe('REVIEW_REQUIRED');
  });

  it('returns one row per finding, sorted by check id', () => {
    const rows = classifyFindings([envCheck(), check('aaa.unknown'), envCheck()]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.check.id)).toEqual([...rows.map((r) => r.check.id)].sort());
  });
});

describe('runHealFlow — gating', () => {
  it('refuses unsupported checks with evidence, still writes receipt', async () => {
    const receipt = await runHealFlow([check('operations.weird.thing')], {
      root: dir,
      confirmed: 'flag',
      now,
    });
    const entry = receipt.entries[0];
    expect(entry.status).toBe('refused');
    expect(entry.evidence).toContain('no supported repair');
    expect(entry.verified).toBeNull();
    expect(entry.riskClass).toBe('UNSUPPORTED');
    expect(receipt.verifiedAll).toBe(false);
    const file = receiptFileFor(dir);
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.schema).toBe('forge/RepairReceipt/v1');
    expect(saved.confirmedBy).toBe('flag');
    expect(saved.entries).toHaveLength(1);
  });

  it('applies SAFE_AUTOMATIC under flag confirmation and verifies', async () => {
    const receipt = await runHealFlow([check('installation.forge-dir.absent')], {
      root: dir,
      confirmed: 'flag',
      now,
    });
    const entry = receipt.entries[0];
    expect(entry.status).toBe('verified');
    expect(entry.verified).toBe(true);
    expect(receipt.verifiedAll).toBe(true);
    for (const sub of ['', 'logs', 'reports', 'backups', 'receipts']) {
      expect(existsSync(path.join(dir, '.forge-cli', sub))).toBe(true);
    }
  });

  it('never applies when confirmed is "never" — even SAFE_AUTOMATIC', async () => {
    const receipt = await runHealFlow([check('installation.forge-dir.absent')], {
      root: dir,
      confirmed: 'never',
      now,
    });
    expect(receipt.entries[0].status).toBe('skipped');
    expect(existsSync(path.join(dir, '.forge-cli', 'logs'))).toBe(false);
    expect(receipt.confirmedBy).toBe('never');
  });

  it('marks manual-only fixes skipped and their apply() throws with reason', async () => {
    const receipt = await runHealFlow([check('installation.lockfile.drift')], {
      root: dir,
      confirmed: 'flag',
      allowReviewRequired: true,
      confirmCallback: async () => true,
      now,
    });
    expect(receipt.entries[0].status).toBe('skipped');
    expect(receipt.entries[0].evidence).toContain('manual-only fix');
    await expect(lockfileDriftRepair.apply({ root: dir, dryRun: false })).rejects.toThrow(
      /manual-only/,
    );
    // plan still shows the regeneration command for the user
    const { plan } = await planRepairs([check('installation.lockfile.drift')], { root: dir });
    expect(plan.items[0].steps.map((s) => s.description).join(' ')).toContain('forge-cli lock');
  });

  it('skips REVIEW_REQUIRED without confirmation (flag without allowReviewRequired)', async () => {
    writeFileSync(path.join(dir, '.env.example'), 'API_KEY=\n');
    writeFileSync(path.join(dir, '.env'), 'OTHER=keep\n');
    const receipt = await runHealFlow([envCheck()], {
      root: dir,
      confirmed: 'flag',
      now,
    });
    expect(receipt.entries[0].status).toBe('skipped');
    expect(receipt.entries[0].evidence).toContain('awaiting confirmation');
    expect(readFileSync(path.join(dir, '.env'), 'utf8')).toBe('OTHER=keep\n');
  });

  it('skips REVIEW_REQUIRED when the interactive review is denied', async () => {
    writeFileSync(path.join(dir, '.env.example'), 'API_KEY=\n');
    const receipt = await runHealFlow([envCheck()], {
      root: dir,
      confirmed: 'user',
      confirmCallback: async () => false,
      now,
    });
    expect(receipt.entries[0].status).toBe('skipped');
    expect(receipt.entries[0].evidence).toContain('awaiting confirmation');
    expect(existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('dry-run never applies but still plans and receipts', async () => {
    const receipt = await runHealFlow([check('installation.forge-dir.absent'), envCheck()], {
      root: dir,
      dryRun: true,
      confirmed: 'flag',
      allowReviewRequired: true,
      now,
    });
    expect(receipt.entries.map((e) => e.status)).toEqual(['skipped', 'skipped']);
    expect(receipt.entries.every((e) => e.evidence.includes('dry-run'))).toBe(true);
    expect(existsSync(path.join(dir, '.forge-cli', 'logs'))).toBe(false);
    expect(existsSync(receiptFileFor(dir))).toBe(true);
  });
});

describe('environment.env.missing-key repair', () => {
  it('appends NAME= placeholders, preserves existing keys, writes backup', async () => {
    writeFileSync(path.join(dir, '.env.example'), 'API_KEY=\nPORT=8080\n');
    writeFileSync(path.join(dir, '.env'), 'PORT=8080\nEXISTING=keep\n');
    const receipt = await runHealFlow([envCheck()], {
      root: dir,
      confirmed: 'flag',
      allowReviewRequired: true,
      now,
    });
    expect(receipt.entries[0].status).toBe('verified');
    const env = readFileSync(path.join(dir, '.env'), 'utf8');
    expect(env).toContain('PORT=8080');
    expect(env).toContain('EXISTING=keep');
    expect(env).toContain('API_KEY=');
    // existing keys never overwritten — no duplicate lines
    expect(env.split('\n').filter((l) => l.startsWith('PORT='))).toHaveLength(1);
    // backup written before mutation, preserving the old content
    const backups = path.join(dir, '.forge-cli', 'backups', 'env-20260102-030405');
    expect(existsSync(path.join(backups, '.env'))).toBe(true);
    expect(readFileSync(path.join(backups, '.env'), 'utf8')).toBe('PORT=8080\nEXISTING=keep\n');
  });

  it('honors check-evidence key names plus re-derived schema keys', () => {
    writeFileSync(path.join(dir, '.env.example'), 'FROM_SCHEMA=\n');
    writeFileSync(path.join(dir, '.env'), 'PRESENT=1\n');
    const keys = missingEnvKeys(dir, envCheck({ evidence: ['missing var FROM_EVIDENCE here'] }));
    expect(keys).toEqual(['FROM_EVIDENCE', 'FROM_SCHEMA']);
  });

  it('re-run is idempotent — second heal finds nothing to append', async () => {
    writeFileSync(path.join(dir, '.env.example'), 'API_KEY=\n');
    writeFileSync(path.join(dir, '.env'), 'OTHER=keep\n');
    const opts = {
      root: dir,
      confirmed: 'flag' as const,
      allowReviewRequired: true,
      now,
    };
    const first = await runHealFlow([envCheck()], opts);
    expect(first.entries[0].status).toBe('verified');
    const second = await runHealFlow([envCheck()], opts);
    expect(second.entries[0].status).toBe('verified');
    const env = readFileSync(path.join(dir, '.env'), 'utf8');
    expect(env.split('\n').filter((l) => l.startsWith('API_KEY='))).toHaveLength(1);
  });

  it('shows the exact appended lines in the plan steps', async () => {
    writeFileSync(path.join(dir, '.env.example'), 'MISSING_ONE=\n');
    writeFileSync(path.join(dir, '.env'), 'OTHER=keep\n');
    const { plan } = await planRepairs([envCheck()], { root: dir, now });
    const steps = plan.items[0].steps;
    expect(steps.some((s) => s.description.includes('backup .env'))).toBe(true);
    expect(steps.some((s) => s.description.includes(`'MISSING_ONE='`))).toBe(true);
    expect(plan.schema).toBe('forge/RepairPlan/v1');
  });
});

describe('installation.backup.restore repair', () => {
  function seedBackup(): string {
    const bdir = path.join(dir, '.forge-cli', 'backups', 'env-20250101-000000');
    mkdirSync(bdir, { recursive: true });
    writeFileSync(path.join(bdir, '.env'), 'RESTORED=yes\n');
    return path.join('.forge-cli', 'backups', 'env-20250101-000000', '.env');
  }

  it('restoreTargetFor maps backup dirs to destinations', () => {
    expect(restoreTargetFor('env-20250101-000000', '.env')).toBe('.env');
    expect(restoreTargetFor('the-forge-1760000000000', '.env')).toBe('the-forge/.env');
    expect(restoreTargetFor('odd', 'x.cfg')).toBe('x.cfg');
  });

  it('restores the selected backup file (root-relative) on apply', async () => {
    const backupRel = seedBackup();
    const receipt = await runHealFlow([check('installation.backup.restore')], {
      root: dir,
      confirmed: 'flag',
      allowReviewRequired: true,
      backup: backupRel,
      now,
    });
    expect(receipt.entries[0].status).toBe('verified');
    expect(readFileSync(path.join(dir, '.env'), 'utf8')).toBe('RESTORED=yes\n');
  });

  it('fails honestly when no backup exists', async () => {
    const receipt = await runHealFlow([check('installation.backup.restore')], {
      root: dir,
      confirmed: 'flag',
      allowReviewRequired: true,
      now,
    });
    expect(receipt.entries[0].status).toBe('failed');
    expect(receipt.entries[0].evidence).toContain('no backups');
    expect(receipt.verifiedAll).toBe(false);
  });

  it('refuses backup selections escaping .forge-cli/backups', async () => {
    writeFileSync(path.join(dir, 'outside.env'), 'X=1\n');
    const ctx: HealContext = { root: dir, dryRun: false, backup: 'outside.env' };
    await expect(backupRestoreRepair.apply(ctx)).rejects.toThrow(/escapes/);
  });
});

describe('runHealFlow — verification + ordering', () => {
  it('marks entries failed when verify() returns false after apply', async () => {
    const fake: RepairAction = {
      id: 'heal.test.fake',
      checkId: 'test.fake.check',
      description: 'applies but never verifies',
      riskClass: 'SAFE_AUTOMATIC',
      reversible: true,
      plan: () => [{ description: 'noop', touches: [] }],
      apply: async () => 'did the thing',
      verify: async () => false,
    };
    REPAIR_REGISTRY.set('test.fake.check', fake);
    try {
      const receipt = await runHealFlow([check('test.fake.check')], {
        root: dir,
        confirmed: 'flag',
        now,
      });
      const entry = receipt.entries[0];
      expect(entry.status).toBe('failed');
      expect(entry.evidence).toContain('did the thing');
      expect(entry.evidence).toContain('verify failed');
      expect(entry.verified).toBe(false);
    } finally {
      REPAIR_REGISTRY.delete('test.fake.check');
    }
  });

  it('receipt entries are sorted by checkId and every finding has a row', async () => {
    const checks = [envCheck(), check('installation.forge-dir.absent'), check('zzz.unsupported')];
    const receipt = await runHealFlow(checks, {
      root: dir,
      confirmed: 'flag',
      allowReviewRequired: true,
      now,
    });
    expect(receipt.entries.map((e) => e.checkId)).toEqual([...checks.map((c) => c.id)].sort());
    expect(receipt.entries).toHaveLength(3);
  });

  it('already-passing checks are skipped, not re-applied', async () => {
    const receipt = await runHealFlow(
      [check('installation.forge-dir.absent', { result: 'pass' })],
      { root: dir, confirmed: 'flag', now },
    );
    expect(receipt.entries[0].status).toBe('skipped');
    expect(receipt.entries[0].evidence).toContain('already passing');
    expect(receipt.verifiedAll).toBe(true);
  });
});
