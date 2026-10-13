import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { planEnvFile } from './env.js';
import {
  buildNativeInstall,
  hasNativeRequest,
  type NativeInstallOptions,
} from './native-install.js';
import { declaredPrereqs } from './prereqs.js';
import type { ForgeRepo } from './types.js';
import { S } from './ui/strings.js';
import { currentHead, findSetupScript, hasGitRepo, npmInstallArgs } from './utils/system.js';

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

export interface ExecutionSummary {
  name: string;
  origin: string;
  revision?: string;
  trust: 'builtin' | 'custom';
  commands: string[];
}

/** O que será executado, com origem, revisão e comandos exatos — insumo da aprovação. */
export async function executionSummary(
  repo: ForgeRepo,
  targetDir: string,
  native?: NativeInstallOptions,
  platform: NodeJS.Platform = process.platform,
): Promise<ExecutionSummary> {
  const repoDir = path.join(targetDir, repo.name);
  const trust = repo.origin === 'custom' ? 'custom' : 'builtin';
  const commands: string[] = [];
  let revision: string | undefined;

  if (!existsSync(repoDir) || !hasGitRepo(repoDir)) {
    commands.push(`git clone -- ${repo.url}`, S.planScriptsAfterClone);
  } else {
    revision = (await currentHead(repoDir))?.slice(0, 7);
    commands.push('git pull --ff-only');
    const script = findSetupScript(repoDir, platform);
    if (script) commands.push([script.command, ...script.args].join(' '));
    const npmArgs = npmInstallArgs(repoDir);
    if (npmArgs) commands.push(`npm ${npmArgs.join(' ')}`);
  }
  if (repo.verify?.length) commands.push(repo.verify.join(' '));
  if (hasNativeRequest(native) && native) {
    const built = buildNativeInstall(repo, native);
    commands.push(built ? built.argv.join(' ') : S.nativeUnsupported);
  }
  return { name: repo.name, origin: repo.url, revision, trust, commands };
}

export function summaryLines(summary: ExecutionSummary): string[] {
  const trust = summary.trust === 'builtin' ? S.trustBuiltin : S.trustCustom;
  return [
    `${S.planOrigin}: ${summary.origin}`,
    ...(summary.revision ? [`${S.planRevision}: ${summary.revision}`] : []),
    `${S.planTrust}: ${trust}`,
    ...summary.commands.map((c) => `$ ${c}`),
  ];
}
