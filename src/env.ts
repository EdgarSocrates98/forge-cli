import { copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { EnvAction } from './types.js';
import { S } from './ui/strings.js';

const ENV_STUB_HEADER = `# .env gerado pelo forge-cli
# Preencha os valores necessários para este repositório antes de usá-lo.
`;

export function stubContent(envKeys?: readonly string[]): string {
  if (!envKeys?.length) return ENV_STUB_HEADER;
  return ENV_STUB_HEADER + envKeys.map((key) => `# ${key}=\n`).join('');
}

export function planEnvFile(repoDir: string): EnvAction {
  if (existsSync(path.join(repoDir, '.env'))) return 'exists';
  if (existsSync(path.join(repoDir, '.env.example'))) return 'copied';
  return 'stub';
}

export async function ensureEnvFile(
  repoDir: string,
  envKeys?: readonly string[],
): Promise<EnvAction> {
  const action = planEnvFile(repoDir);
  if (action === 'copied') {
    await copyFile(path.join(repoDir, '.env.example'), path.join(repoDir, '.env'));
  } else if (action === 'stub') {
    await writeFile(path.join(repoDir, '.env'), stubContent(envKeys), 'utf8');
  }
  return action;
}

export function envNoteFor(action: EnvAction): string {
  if (action === 'copied') return S.envCopied;
  if (action === 'stub') return S.envStub;
  return S.envExists;
}
