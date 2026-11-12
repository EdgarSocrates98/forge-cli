import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/system.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/system.js')>();
  return { ...actual, runStreamed: vi.fn() };
});

import { runStreamed } from '../src/utils/system.js';
import { parseCliArgs } from '../src/cli-args.js';
import { runWorkspaceCommand } from '../src/cmd/adaptive.js';

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-wsinstall-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.mocked(runStreamed).mockReset();
});

const streamed = vi.mocked(runStreamed);

function cliFor(args: string[], ws: string) {
  const cli = parseCliArgs(['--dir', ws, '--json', ...args]);
  return cli;
}

function lastJson(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const calls = spy.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(String(calls[i][0])) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  throw new Error('nenhuma saída JSON capturada');
}

describe('workspace install <forja> — GAP-07', () => {
  it('sem forja → erro de uso (2) e nada executado', async () => {
    const ws = temp();
    const code = await runWorkspaceCommand(cliFor([], ws), ['install']);
    expect(code).toBe(2);
    expect(streamed).not.toHaveBeenCalled();
  });

  it('forja fora do catálogo → recusa nomeada (2)', async () => {
    const ws = temp();
    const code = await runWorkspaceCommand(cliFor([], ws), ['install', 'nao-existe']);
    expect(code).toBe(2);
    expect(streamed).not.toHaveBeenCalled();
  });

  it('forja sem instalador nativo → WORKSPACE-INSTALL-UNSUPPORTED (2)', async () => {
    const ws = temp();
    // forge-portal não declara nativeInstall no catálogo.
    const code = await runWorkspaceCommand(cliFor([], ws), ['install', 'forge-portal']);
    expect(code).toBe(2);
    expect(streamed).not.toHaveBeenCalled();
  });

  it('--scope conflitante → WORKSPACE-SCOPE-CONFLICT (2)', async () => {
    const ws = temp();
    const code = await runWorkspaceCommand(cliFor(['--scope', 'user'], ws), [
      'install',
      'data-sentinel-forge',
    ]);
    expect(code).toBe(2);
    expect(streamed).not.toHaveBeenCalled();
  });

  it('sem --yes: só plano — argv --scope workspace --dry-run, zero execução', async () => {
    const ws = temp();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await runWorkspaceCommand(cliFor([], ws), ['install', 'data-sentinel-forge']);
      expect(code).toBe(0);
      const doc = lastJson(spy);
      expect((doc.plan as { operation: string }).operation).toBe('install');
      expect((doc.receipt as { status: string }).status).toBe('planned');
      expect(doc.argv).toEqual([
        'data-sentinel',
        'install',
        '--scope',
        'workspace',
        '--dry-run',
      ]);
      expect(streamed).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('--plan é o mesmo caminho só-plano', async () => {
    const ws = temp();
    const code = await runWorkspaceCommand(cliFor(['--plan'], ws), [
      'install',
      'data-sentinel-forge',
    ]);
    expect(code).toBe(0);
    expect(streamed).not.toHaveBeenCalled();
  });

  it('--yes executa o instalador nativo na raiz do workspace com --yes', async () => {
    const ws = temp();
    streamed.mockResolvedValue(undefined);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await runWorkspaceCommand(cliFor(['--yes'], ws), [
        'install',
        'data-sentinel-forge',
      ]);
      expect(code).toBe(0);
      expect(streamed).toHaveBeenCalledTimes(1);
      const [argv, cwd] = streamed.mock.calls[0];
      expect(argv).toEqual(['data-sentinel', 'install', '--scope', 'workspace', '--yes']);
      expect(cwd).toBe(path.resolve(ws));
      const doc = lastJson(spy);
      expect((doc.receipt as { status: string }).status).toBe('applied');
    } finally {
      spy.mockRestore();
    }
  });

  it('falha do instalador → receipt failed + exit 1 (nunca sucesso falso)', async () => {
    const ws = temp();
    streamed.mockRejectedValue(new Error('spawn data-sentinel ENOENT'));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await runWorkspaceCommand(cliFor(['--yes'], ws), [
        'install',
        'data-sentinel-forge',
      ]);
      expect(code).toBe(1);
      const doc = lastJson(spy);
      expect((doc.receipt as { status: string }).status).toBe('failed');
      expect(String(doc.error)).toContain('ENOENT');
    } finally {
      spy.mockRestore();
    }
  });
});
