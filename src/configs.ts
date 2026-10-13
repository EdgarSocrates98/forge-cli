import { existsSync } from 'node:fs';
import { copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const EXAMPLE_PATTERN = '.example.';
const EXCLUDED = new Set(['.env.example']);

export async function copyConfigExamples(repoDir: string): Promise<string[]> {
  const copied: string[] = [];
  for (const entry of await readdir(repoDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = entry.name;
    if (EXCLUDED.has(source) || !source.includes(EXAMPLE_PATTERN)) continue;
    const target = source.replace(EXAMPLE_PATTERN, '.');
    if (existsSync(path.join(repoDir, target))) continue;
    await copyFile(path.join(repoDir, source), path.join(repoDir, target));
    copied.push(target);
  }
  return copied;
}
