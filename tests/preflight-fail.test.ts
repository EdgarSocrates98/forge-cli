import { describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { pythonVersion, runPreflight } from '../src/preflight.js';
import { S } from '../src/ui/strings.js';

const mockedExeca = vi.mocked(execa);

describe('preflight failure paths', () => {
  it('pythonVersion returns null when no interpreter resolves', async () => {
    mockedExeca.mockRejectedValue(new Error('command not found'));
    expect(await pythonVersion('win32')).toBeNull();
  });

  it('pythonVersion returns null when the command exits non-zero', async () => {
    mockedExeca.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' } as never);
    expect(await pythonVersion('linux')).toBeNull();
  });

  it('runPreflight marks failed commands as not ok instead of throwing', async () => {
    mockedExeca.mockRejectedValue(new Error('command not found'));
    const checks = await runPreflight('win32');
    expect(checks.every((c) => typeof c.ok === 'boolean')).toBe(true);
    const commandChecks = checks.filter(
      (c) => c.name === S.preflightGit || c.name === S.preflightPwsh,
    );
    expect(commandChecks.every((c) => !c.ok)).toBe(true);
    expect(checks.find((c) => c.severity === 'warn')?.ok).toBe(false);
  });
});
