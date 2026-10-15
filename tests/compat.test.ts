import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  compatVerdict,
  contractSupported,
  defaultManifestPath,
  loadCompatManifest,
  manifestProblems,
  readDeclaredVersion,
} from '../src/compat.js';

const DOC = {
  schema: 'forge/EcosystemCompatibility/v1',
  release: '2026.10',
  created_at: '2026-10-15',
  producer: { id: 'the-forge', version: '0.5.0' },
  components: [
    { component: 'the-forge', version: '0.5.0', scheme: 'semver', source: 'pyproject.toml' },
    { component: 'api-forge', version: '0.1.0', scheme: 'semver', source: 'pyproject.toml' },
  ],
  contracts: [
    { family: 'specialist_manifest', contract: 'theforge/ForgeManifest', min_major: 1, max_major: 1 },
    { family: 'portal_api', contract: 'forge/PortalApi', min_major: 1, max_major: 1 },
    { family: 'unversioned_thing', contract: null },
  ],
};

function ws(withManifest = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'compat-'));
  if (withManifest) {
    const tf = path.join(dir, 'the-forge');
    mkdirSync(tf, { recursive: true });
    writeFileSync(path.join(tf, 'ecosystem-compatibility.json'), JSON.stringify(DOC));
  }
  return dir;
}

describe('loadCompatManifest', () => {
  it('loads a conforming manifest and records sha256 + path', () => {
    const m = loadCompatManifest(defaultManifestPath(ws()));
    expect(m).not.toBeNull();
    expect(m?.release).toBe('2026.10');
    expect(m?.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('returns null when the file is absent', () => {
    expect(loadCompatManifest(defaultManifestPath(ws(false)))).toBeNull();
  });
  it('returns null on a wrong schema id', () => {
    const dir = ws();
    const p = defaultManifestPath(dir);
    writeFileSync(p, JSON.stringify({ ...DOC, schema: 'forge/EcosystemCompatibility/v2' }));
    expect(loadCompatManifest(p)).toBeNull();
  });
});

describe('compatVerdict / contractSupported', () => {
  const m = loadCompatManifest(defaultManifestPath(ws()))!;
  it('certified / incompatible / unknown', () => {
    expect(compatVerdict(m, 'the-forge', '0.5.0')).toBe('certified');
    expect(compatVerdict(m, 'the-forge', '9.9.9')).toBe('incompatible');
    expect(compatVerdict(m, 'nope', '0.5.0')).toBe('unknown');
  });
  it('contract windows; unversioned families never supported', () => {
    expect(contractSupported(m, 'portal_api', 1)).toBe(true);
    expect(contractSupported(m, 'portal_api', 2)).toBe(false);
    expect(contractSupported(m, 'unversioned_thing', 1)).toBe(false);
    expect(contractSupported(m, 'absent', 1)).toBe(false);
  });
});

describe('readDeclaredVersion', () => {
  it('reads package.json then pyproject', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'decl-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    expect(readDeclaredVersion(dir)).toBe('1.2.3');
  });
  it('falls back to pyproject version', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'decl-'));
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nversion = "0.4.2"\n');
    expect(readDeclaredVersion(dir)).toBe('0.4.2');
  });
  it('reads only the [project] table — earlier [tool.*] versions do not shadow', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'decl-'));
    writeFileSync(
      path.join(dir, 'pyproject.toml'),
      '[build-system]\nversion = "9.9.9"\n\n[tool.other]\nversion = "8.8.8"\n\n' +
        '[project]\nname = "x"\ndependencies = [\n  "a",\n]\nversion = "1.2.3"\n\n[tool.tail]\nz = 1\n',
    );
    expect(readDeclaredVersion(dir)).toBe('1.2.3');
  });
  it('null when neither exists', () => {
    expect(readDeclaredVersion(mkdtempSync(path.join(tmpdir(), 'decl-')))).toBeNull();
  });
});

describe('manifestProblems — strict parity with Python load_manifest', () => {
  const ok = (over: object = {}) => ({ ...DOC, ...over });

  it('accepts the conforming document', () => {
    expect(manifestProblems(ok())).toEqual([]);
  });
  it('rejects bad release ids and non-ISO created_at', () => {
    expect(manifestProblems(ok({ release: 'latest' }))).toContain('release must be YYYY.MM');
    expect(manifestProblems(ok({ release: '2026.13' }))).toContain(
      'release must be YYYY.MM',
    );
    expect(manifestProblems(ok({ created_at: 'Oct 15' }))).toContain(
      'created_at must be ISO date',
    );
  });
  it('rejects "latest"/empty component versions and missing source', () => {
    const bad = ok({
      components: [
        { component: 'the-forge', version: 'latest', source: 'pyproject.toml' },
        { component: 'api-forge', version: '0.1.0', source: '' },
      ],
    });
    expect(manifestProblems(bad).join(' ')).toContain('pinned');
    expect(manifestProblems(bad).join(' ')).toContain('source');
  });
  it('rejects ranges on unversioned families and bad windows', () => {
    const bad = ok({
      contracts: [
        { family: 'unversioned_thing', contract: null, min_major: 1 },
        // max_major alone is also a range Python rejects (compatibility.py)
        { family: 'unversioned_max', contract: null, max_major: 2 },
        { family: 'portal_api', contract: 'forge/PortalApi', min_major: 3, max_major: 1 },
      ],
    });
    const msgs = manifestProblems(bad).join(' ');
    expect(msgs.match(/must not carry ranges/g)).toHaveLength(2);
    expect(msgs).toContain('invalid major window');
  });
  it('rejects non-strict SemVer that parse_semver rejects', () => {
    const comp = (version: string) =>
      ok({ components: [{ component: 'the-forge', version, source: 'pyproject.toml' }] });
    for (const v of ['1.0.0-01', '1.0.0-a..b', '1.0.0-', '01.2.3', '1.0.0+a..b']) {
      expect(manifestProblems(comp(v)).join(' ')).toContain('not semver-shaped');
    }
    for (const v of ['1.0.0-0a', '1.0.0-alpha.1', '1.0.0+build-01', '1.0.0-rc.1+meta']) {
      expect(manifestProblems(comp(v))).toEqual([]);
    }
  });
  it('rejects a scheme outside the semver|pep440 Literal', () => {
    const bad = ok({
      components: [
        { component: 'the-forge', version: '0.5.0', scheme: 'calver', source: 'pyproject.toml' },
      ],
    });
    expect(manifestProblems(bad).join(' ')).toContain('bad scheme');
  });
  it('rejects a manifest Python would reject (wrong schema)', () => {
    expect(loadCompatManifest(defaultManifestPath(ws()))).not.toBeNull();
    const dir = ws();
    writeFileSync(
      defaultManifestPath(dir),
      JSON.stringify(ok({ release: 'rolling' })),
    );
    expect(loadCompatManifest(defaultManifestPath(dir))).toBeNull();
  });
});
