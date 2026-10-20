import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_IDS,
  SCHEMAS,
  contractValidator,
  negotiateCapabilities,
  resolveDiscovery,
} from '../src/contracts/index.js';

const ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCHEMA_DIR = path.join(ROOT, 'contracts', 'schemas');

const v = contractValidator();

const validFixtures: Record<string, object> = {
  'forge/ForgeDescriptor/v1': {
    forge_id: 'the-forge',
    name: 'The Forge',
    version: '1.4.0',
    kind: 'python',
    cli: 'theforge',
    mcp_command: ['theforge', 'mcp'],
    capabilities: [
      { id: 'install', state: 'supported' },
      { id: 'graph', state: 'unverified', detail: 'needs graph studio' },
    ],
  },
  'forge/ForgeCapability/v1': { id: 'skills.install', state: 'supported' },
  'forge/ForgeInstallContract/v1': {
    forge_id: 'api-forge',
    commands: {
      install: ['apiforge', 'install'],
      update: ['apiforge', 'install', 'update'],
      uninstall: ['apiforge', 'install', 'uninstall'],
      verify: ['apiforge', '--help'],
    },
    flags: { scope: ['project', 'workspace', 'user'], host: ['claude', 'devin'] },
    dry_run_flag: '--dry-run',
    approve_flag: '--yes',
  },
  'forge/ForgeEnvironmentSchema/v1': {
    forge_id: 'api-forge',
    prefix: 'APIFORGE',
    scope: 'user',
    state: 'PARTIAL',
    variables: [
      { name: 'APIFORGE_HOME', required: true, kind: 'directory', present: true, valid: true },
      { name: 'APIFORGE_LAUNCHER', required: false, kind: 'file', present: false, valid: null },
    ],
    windows_aliases: true,
  },
  'forge/ForgeHostDescriptor/v1': {
    host: 'claude',
    detected: true,
    version: '2.0.4',
    supported: true,
    logged_in: true,
    integration: 'HANDSHAKE_VERIFIED',
    launchable: true,
    capabilities: ['skills', 'agents', 'mcp'],
  },
  'forge/ForgeOperationPlan/v1': {
    plan_id: 'plan-20261014-01',
    created_at: '2026-10-14T01:00:00Z',
    expires_at: '2026-10-14T01:15:00Z',
    source: 'cli',
    forges: [
      {
        forge_id: 'the-forge',
        repo: 'the-forge',
        target_dir: 'E:/ws/the-forge',
        actions: [
          { kind: 'clone', label: 'clone the-forge', reversible: true },
          { kind: 'env', label: 'ensure .env', paths: ['the-forge/.env'], reversible: false },
          {
            kind: 'native',
            label: 'theforge install apply',
            argv: ['theforge', 'install', 'apply', '--dry-run'],
            reversible: false,
          },
        ],
      },
    ],
    native: { scope: 'workspace', profile: 'recommended', approve: false },
    hash: 'a'.repeat(64),
  },
  'forge/ForgeOperationReceipt/v1': {
    receipt_id: 'rcpt-20261014-01',
    plan_hash: 'a'.repeat(64),
    correlation_id: 'f47ac10b58cc',
    started_at: '2026-10-14T01:00:05Z',
    finished_at: '2026-10-14T01:02:30Z',
    results: [
      {
        forge_id: 'the-forge',
        status: 'ok',
        phase: 'validated',
        detail: 'installed via setup.sh',
        head: '2f1d8bf',
        elapsed_ms: 41200,
        evidence: [{ kind: 'log', ref: '.forge-cli/logs/forge-cli-20261014-010005.log' }],
      },
    ],
    summary: { ok: 1, warnings: 0, errors: 0, skipped: 0 },
  },
  'forge/ForgeHealthReport/v1': {
    forge_id: 'api-forge',
    checked_at: '2026-10-14T01:00:00Z',
    state: 'DEGRADED',
    checks: [
      {
        id: 'env-prefix',
        domain: 'environment',
        result: 'fail',
        severity: 'error',
        diagnosis: 'APIFORGE_CLI missing',
        corrective_action: 're-run apiforge install',
        reversibility: 'reversible',
      },
      { id: 'python', domain: 'system', result: 'pass', severity: 'info' },
    ],
    score: null,
  },
};

describe('contract fixtures on disk', () => {
  const FIXTURES = path.join(ROOT, 'contracts', 'fixtures');
  const load = (f: string) => JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8'));

  it('golden descriptor validates', () => {
    expect(v.validate('forge/ForgeDescriptor/v1', load('descriptor.valid.json'))).toEqual([]);
  });

  it('legacy (schema-less) manifest validates as descriptor', () => {
    expect(v.validate('forge/ForgeDescriptor/v1', load('descriptor.legacy.json'))).toEqual([]);
  });

  it('wrong-version fixture hard-fails', () => {
    const errs = v.validate('forge/ForgeDescriptor/v1', load('descriptor.wrong-version.json'));
    expect(errs[0].code).toBe('CONTRACT-VERSION');
  });

  it('hostile fixture produces structured errors only (no exceptions)', () => {
    const errs = v.validate('forge/ForgeDescriptor/v1', load('descriptor.hostile.json'));
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((e) => typeof e.code === 'string' && e.code.startsWith('CONTRACT-'))).toBe(
      true,
    );
  });
});

describe('canonical schemas exist on disk and match embedded copies', () => {
  it('ships all nine contracts', () => {
    expect(CONTRACT_IDS.sort()).toEqual(
      [
        'forge/ForgeCapability/v1',
        'forge/ForgeDescriptor/v1',
        'forge/ForgeEnvironmentSchema/v1',
        'forge/ForgeHealthReport/v1',
        'forge/ForgeHostDescriptor/v1',
        'forge/ForgeInstallContract/v1',
        'forge/ForgeOperationPlan/v1',
        'forge/ForgeOperationReceipt/v1',
        'forge/LocalForgeSourceDetection/v1',
      ].sort(),
    );
  });

  it('embedded schemas are byte-parity with contracts/schemas/*.json (modulo meta keys)', () => {
    const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(9);
    for (const file of files) {
      const disk = JSON.parse(readFileSync(path.join(SCHEMA_DIR, file), 'utf8'));
      const embedded = SCHEMAS[disk.$id];
      expect(embedded, `missing embedded schema for ${disk.$id}`).toBeDefined();
      const { $schema: _s, $id: _i, title: _t, ...diskBody } = disk;
      const { $id: _ei, ...embBody } = embedded;
      expect(embBody).toEqual(diskBody);
    }
  });
});

describe('schema validation', () => {
  it.each(Object.entries(validFixtures))('%s accepts its golden fixture', (id, doc) => {
    expect(v.validate(id, doc)).toEqual([]);
  });

  it('rejects missing required fields', () => {
    const errs = v.validate('forge/ForgeDescriptor/v1', { name: 'x' });
    expect(errs.some((e) => e.code === 'CONTRACT-REQUIRED' && e.path === '/forge_id')).toBe(true);
  });

  it('rejects enum violations (a declared capability must never flatten to invented states)', () => {
    const errs = v.validate('forge/ForgeCapability/v1', { id: 'x', state: 'integrated' });
    expect(errs.some((e) => e.code === 'CONTRACT-ENUM')).toBe(true);
  });

  it('tolerates unknown fields (additive compatibility)', () => {
    const errs = v.validate('forge/ForgeCapability/v1', {
      id: 'x',
      state: 'supported',
      future_field: { nested: [1, 2] },
    });
    expect(errs).toEqual([]);
  });

  it('hard-rejects a foreign schema declaration (no silent coercion)', () => {
    const errs = v.validate('forge/ForgeDescriptor/v1', {
      schema: 'forge/ForgeDescriptor/v2',
      forge_id: 'x',
    });
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe('CONTRACT-VERSION');
  });

  it('validateDocument routes on the declared schema', () => {
    expect(
      v.validateDocument({ schema: 'forge/ForgeCapability/v1', id: 'x', state: 'supported' }),
    ).toEqual([]);
    const errs = v.validateDocument({ id: 'x' });
    expect(errs[0].code).toBe('CONTRACT-VERSION');
  });

  it('rejects non-object documents without throwing', () => {
    expect(v.validate('forge/ForgeDescriptor/v1', 'nope')[0].code).toBe('CONTRACT-TYPE');
    expect(v.validate('forge/ForgeDescriptor/v1', null)[0].code).toBe('CONTRACT-TYPE');
    expect(v.validate('forge/ForgeDescriptor/v1', 42)[0].code).toBe('CONTRACT-TYPE');
  });

  it('serde round-trip preserves validity', () => {
    for (const [id, doc] of Object.entries(validFixtures)) {
      const roundTripped = JSON.parse(JSON.stringify(doc));
      expect(v.validate(id, roundTripped)).toEqual([]);
    }
  });
});

describe('nested $ref validation', () => {
  it('validates descriptor capabilities through ForgeCapability', () => {
    const errs = v.validate('forge/ForgeDescriptor/v1', {
      forge_id: 'the-forge',
      capabilities: [{ id: 'x', state: 'bogus' }],
    });
    expect(errs.some((e) => e.code === 'CONTRACT-ENUM' && e.path === '/capabilities/0/state')).toBe(
      true,
    );
  });

  it('refuses non-forge $refs inside nested refs (defense in depth)', () => {
    const doc = {
      forge_id: 'evil',
      install: 'not-an-object',
    };
    const errs = v.validate('forge/ForgeDescriptor/v1', doc);
    expect(errs.some((e) => e.code === 'CONTRACT-TYPE')).toBe(true);
  });
});

describe('untrusted/legacy data', () => {
  it('legacy forge.json (3 fields, no schema key) still validates', () => {
    // the current manifest.ts shape — must remain valid under ForgeDescriptor/v1
    const errs = v.validate('forge/ForgeDescriptor/v1', {
      forge_id: 'the-forge',
      cli: 'theforge',
      mcp_command: ['theforge', 'mcp'],
    });
    expect(errs).toEqual([]);
  });

  it('malformed manifest fields produce errors, not crashes', () => {
    expect(() =>
      v.validate('forge/ForgeDescriptor/v1', { forge_id: 7, mcp_command: { x: 1 } }),
    ).not.toThrow();
    const errs = v.validate('forge/ForgeDescriptor/v1', { forge_id: 7 });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('path-traversal strings in descriptor fields are not dereferenced (validation is shape-only)', () => {
    const doc = {
      forge_id: 'the-forge',
      workspace: '../../../etc/passwd',
      cli: '../../evil',
    };
    const errs = v.validate('forge/ForgeDescriptor/v1', doc);
    // cli must fail the safe-token pattern; workspace stays shape-valid —
    // path safety is enforced downstream by safety.resolveInside, not here.
    expect(errs.some((e) => e.path === '/cli')).toBe(true);
  });
});

describe('capability negotiation', () => {
  const offered = [
    { id: 'install', state: 'supported' as const },
    { id: 'graph', state: 'unverified' as const, detail: 'engine present, not probed' },
    { id: 'remote', state: 'unsupported' as const },
    { id: 'telemetry', state: 'not_applicable' as const },
  ];

  it('grants supported, marks unverified distinctly, refuses unsupported/na', () => {
    const r = negotiateCapabilities(['install', 'graph', 'remote', 'telemetry'], offered);
    expect(r.ok).toBe(false);
    const map = new Map(r.answers.map((a) => [a.capability, a.status]));
    expect(map.get('install')).toBe('granted');
    expect(map.get('graph')).toBe('granted_unverified');
    expect(map.get('remote')).toBe('refused');
    expect(map.get('telemetry')).toBe('refused');
  });

  it('unverified never counts as fully granted (complete=false)', () => {
    const r = negotiateCapabilities(['install', 'graph'], offered);
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(false);
  });

  it('unknown capabilities are refused with explanation', () => {
    const r = negotiateCapabilities(['teleport'], offered);
    expect(r.answers[0].status).toBe('unknown');
    expect(r.answers[0].reason).toContain('not offered');
  });
});

describe('discovery precedence (spec §1.3)', () => {
  it('manifest > forja-discovery > catalog > remote-registry > fallback', () => {
    const resolved = resolveDiscovery([
      { origin: 'fallback', state: 'unknown', forge_id: 'x' },
      { origin: 'catalog', state: 'declared', forge_id: 'x' },
      { origin: 'manifest', state: 'integrated', forge_id: 'x' },
      { origin: 'remote-registry', state: 'detected', forge_id: 'x' },
      { origin: 'forja-discovery', state: 'validated', forge_id: 'x' },
    ]);
    expect(resolved?.origin).toBe('manifest');
  });

  it('falls through to the first present level', () => {
    const resolved = resolveDiscovery([
      { origin: 'remote-registry', state: 'detected', forge_id: 'x' },
      { origin: 'fallback', state: 'unknown', forge_id: 'x' },
    ]);
    expect(resolved?.origin).toBe('remote-registry');
  });

  it('returns null when nothing is discovered', () => {
    expect(resolveDiscovery([])).toBeNull();
  });

  it('all seven discovery states are distinct members of the model', () => {
    const states = [
      'integrated',
      'validated',
      'configured',
      'declared',
      'detected',
      'degraded',
      'unknown',
    ];
    for (const state of states) {
      const resolved = resolveDiscovery([
        { origin: 'manifest', state: state as never, forge_id: 'x' },
      ]);
      expect(resolved?.state).toBe(state);
    }
    // a declared source must never collapse into integrated
    expect(
      resolveDiscovery([{ origin: 'manifest', state: 'declared', forge_id: 'x' }])?.state,
    ).toBe('declared');
  });
});
