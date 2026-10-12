import { existsSync } from 'node:fs';
import path from 'node:path';
import { checkRepoPrereqs } from './prereqs.js';
import type { ForgeRepo } from './types.js';
import { S } from './ui/strings.js';
import { hasGitRepo, runStreamed } from './utils/system.js';

export type DoctorStatus = 'ok' | 'fail' | 'skipped';

export function reposNeedingFix(results: readonly DoctorResult[]): ForgeRepo[] {
  return results.filter((r) => r.status === 'fail').map((r) => r.repo);
}

export interface DoctorResult {
  repo: ForgeRepo;
  status: DoctorStatus;
  detail: string;
  prereqFails?: string[];
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

    const prereqs = await checkRepoPrereqs(repoDir);
    const prereqFails = prereqs.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);

    if (!repo.verify?.length) {
      results.push({
        repo,
        status: prereqFails.length ? 'fail' : 'skipped',
        detail: S.doctorNoVerify,
        prereqFails: prereqFails.length ? prereqFails : undefined,
      });
      continue;
    }
    try {
      await runStreamed(repo.verify, repoDir);
      results.push({
        repo,
        status: prereqFails.length ? 'fail' : 'ok',
        detail: repo.verify.join(' '),
        prereqFails: prereqFails.length ? prereqFails : undefined,
      });
    } catch {
      results.push({
        repo,
        status: 'fail',
        detail: repo.verify.join(' '),
        prereqFails: prereqFails.length ? prereqFails : undefined,
      });
    }
  }
  return results;
}
