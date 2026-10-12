import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { planEnvFile } from './env.js';
import { declaredPrereqs } from './prereqs.js';
import type { ForgeRepo } from './types.js';
import { S } from './ui/strings.js';
import { findSetupScript, hasGitRepo, npmInstallArgs } from './utils/system.js';

export function planLines(repo: ForgeRepo, targetDir: string): string[] {
  const repoDir = path.join(targetDir, repo.name);
  const lines: string[] = [];

  if (!existsSync(repoDir)) {
    lines.push(`${S.planSync}: git clone (${S.planDetectAfter})`);
    for (const step of [
      S.phaseEnv,
      S.phaseConfigs,
      S.phasePrereqs,
      S.phaseInstall,
      'npm',
      S.phaseVerify,
    ]) {
      lines.push(`${step}: ${S.planDetectAfter}`);
    }
    return lines;
  }
  if (!hasGitRepo(repoDir)) {
    lines.push(`${S.planSync}: ${S.nonGitDir}`);
    return lines;
  }
  lines.push(`${S.planSync}: git pull --ff-only`);

  const envAction = planEnvFile(repoDir);
  lines.push(
    `${S.phaseEnv}: ${
      envAction === 'exists'
        ? S.planEnvKeep
        : envAction === 'copied'
          ? S.planEnvCopy
          : S.planEnvStub
    }`,
  );

  const examples = readdirSync(repoDir).filter(
    (f) => f !== '.env.example' && f.includes('.example.'),
  );
  lines.push(
    examples.length
      ? `${S.phaseConfigs}: ${examples.map((f) => f.replace('.example.', '.')).join(', ')}`
      : `${S.phaseConfigs}: ${S.planNone}`,
  );

  const prereqs = declaredPrereqs(repoDir);
  lines.push(`${S.phasePrereqs}: ${prereqs.length ? prereqs.join(', ') : S.planNone}`);

  const script = findSetupScript(repoDir);
  lines.push(`${S.phaseInstall}: ${script ? script.file : S.planNone}`);

  const npmArgs = npmInstallArgs(repoDir);
  lines.push(`npm: ${npmArgs ? `npm ${npmArgs[0]}` : S.planNone}`);

  lines.push(`${S.phaseVerify}: ${repo.verify?.length ? repo.verify.join(' ') : S.planNone}`);
  return lines;
}
