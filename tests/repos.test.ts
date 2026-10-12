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
];

describe('FORGE_REPOS catalog', () => {
  it('contains exactly the 8 Forge repositories', () => {
    expect(FORGE_REPOS).toHaveLength(8);
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
});
