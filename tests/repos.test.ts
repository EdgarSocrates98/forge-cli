import { describe, expect, it } from 'vitest';
import { FORGE_REPOS } from '../src/constants/repos.js';

const EXPECTED_NAMES = [
  'the-forge',
  'spark-forge-aws',
  'spark-forge-azure',
  'platform-forge',
  'api-forge',
  'forge-doctor-api',
  'forge-doctor-data',
  'forge-portal',
  'data-sentinel-forge',
  'forge-lens',
  'code-atlas-forge',
  'product-forge',
  'forge-agent-bridge',
];

describe('FORGE_REPOS catalog', () => {
  it('contains the complete 13-repository Forge catalog', () => {
    expect(FORGE_REPOS).toHaveLength(13);
    expect(FORGE_REPOS.map((r) => r.name)).toEqual(EXPECTED_NAMES);
  });

  it('uses the EdgarSocrates98 GitHub org URL for every repo', () => {
    for (const repo of FORGE_REPOS) {
      expect(repo.url).toBe(`https://github.com/EdgarSocrates98/${repo.name}`);
    }
  });

  it('has a non-empty description for every repo', () => {
    for (const repo of FORGE_REPOS) {
      expect(repo.description.length).toBeGreaterThan(0);
    }
  });

  it('defines a verify command for every repo', () => {
    for (const repo of FORGE_REPOS) {
      expect(repo.verify?.length, repo.name).toBeGreaterThan(0);
    }
  });

  it('uses npx --no-install ng version for the Angular portal', () => {
    const portal = FORGE_REPOS.find((r) => r.name === 'forge-portal');
    expect(portal?.verify).toEqual(['npx', '--no-install', 'ng', 'version']);
  });

  it('defines nextSteps for every repo', () => {
    for (const repo of FORGE_REPOS) {
      expect(repo.nextSteps?.length, repo.name).toBeGreaterThan(0);
    }
  });

  it('marks repo kinds — 12 python + 1 node', () => {
    const kinds = FORGE_REPOS.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'python')).toHaveLength(12);
    expect(kinds.filter((k) => k === 'node')).toHaveLength(1);
    expect(FORGE_REPOS.find((r) => r.kind === 'node')?.name).toBe('forge-portal');
  });

  it('catalogs the new ecosystem projects with source install routes', () => {
    const sentinel = FORGE_REPOS.find((r) => r.name === 'data-sentinel-forge');
    expect(sentinel).toBeDefined();
    expect(sentinel?.kind).toBe('python');
    expect(sentinel?.nativeInstall?.command).toEqual(['data-sentinel', 'install']);
    expect(FORGE_REPOS.find((r) => r.name === 'forge-lens')?.nativeInstall?.command).toEqual([
      'forge-lens',
      'install',
    ]);
    expect(FORGE_REPOS.find((r) => r.name === 'product-forge')?.nativeInstall?.command).toEqual([
      'productforge',
      'install',
    ]);
    expect(
      FORGE_REPOS.find((r) => r.name === 'forge-agent-bridge')?.nativeInstall?.command,
    ).toEqual(['forge-bridge', 'install']);
    expect(FORGE_REPOS.find((r) => r.name === 'code-atlas-forge')?.verify).toEqual([
      'code-atlas',
      '--help',
    ]);
  });

  it('defines documented envKeys only for api-forge', () => {
    const api = FORGE_REPOS.find((r) => r.name === 'api-forge');
    expect(api?.envKeys).toEqual(['APIFORGE_HOME', 'APIFORGE_CONFIG', 'APIFORGE_CACHE']);
    for (const repo of FORGE_REPOS.filter((r) => r.name !== 'api-forge')) {
      expect(repo.envKeys, repo.name).toBeUndefined();
    }
  });
});
