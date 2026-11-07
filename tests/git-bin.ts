import { existsSync } from 'node:fs';
import path from 'node:path';

/** Resolve git without relying on the runner's case-duplicated PATH entries. */
export const GIT_BIN = (() => {
  if (process.platform !== 'win32') return 'git';
  const raw = process.env.Path ?? process.env.PATH ?? '';
  for (const dir of raw.split(path.delimiter)) {
    const candidate = path.join(dir, 'git.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'git';
})();
