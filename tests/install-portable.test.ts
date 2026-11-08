import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('portable source installation', () => {
  it('ships equivalent POSIX, Git Bash and PowerShell entrypoints', () => {
    for (const file of ['install.sh', 'install.windows.sh', 'install.ps1']) {
      const source = readFileSync(path.join(root, file), 'utf8');
      expect(source.length).toBeGreaterThan(80);
      expect(source).toContain('scripts/install_portable.mjs');
    }
  });

  it('has a deterministic no-mutation plan', () => {
    const source = readFileSync(path.join(root, 'scripts/install_portable.mjs'), 'utf8');
    expect(source).toContain("schema: 'forge/node-install/v1'");
    expect(source).toContain('dry_run: dryRun');
    expect(source).toContain("['ci']");
    expect(source).toContain("['run', 'build']");
  });
});
