import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ForgeRepo } from './types.js';
import { S } from './ui/strings.js';
import { hasGitRepo, runStreamed } from './utils/system.js';

export type DoctorStatus = 'ok' | 'fail' | 'skipped';

export interface DoctorResult {
  repo: ForgeRepo;
  status: DoctorStatus;
  detail: string;
}

export async function runDoctor(
  repos: readonly ForgeRepo[],
  targetDir: string,
): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  for (const repo of repos) {
    const repoDir = path.join(targetDir, repo.name);
    if (!existsSync(repoDir) || !hasGitRepo(repoDir)) {
      results.push({ repo, status: 'skipped', detail: S.doctorNoCheckout });
      continue;
    }
    if (!repo.verify?.length) {
      results.push({ repo, status: 'skipped', detail: S.doctorNoVerify });
      continue;
    }
    try {
      await runStreamed(repo.verify, repoDir);
      results.push({ repo, status: 'ok', detail: repo.verify.join(' ') });
    } catch {
      results.push({ repo, status: 'fail', detail: repo.verify.join(' ') });
    }
  }
  return results;
}
