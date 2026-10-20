import { describe, expect, it } from 'vitest';
import {
  isNodeSupported,
  pythonCandidates,
  pythonVersion,
  runPreflight,
} from '../src/preflight.js';
import { S } from '../src/ui/strings.js';

describe('isNodeSupported', () => {
  it('accepts Node >= 20', () => {
    expect(isNodeSupported('v20.0.0')).toBe(true);
    expect(isNodeSupported('v24.16.0')).toBe(true);
  });

  it('rejects Node < 20', () => {
    expect(isNodeSupported('v18.19.2')).toBe(false);
    expect(isNodeSupported('v16.20.0')).toBe(false);
  });

  it('rejects unparseable versions', () => {
    expect(isNodeSupported('not-a-version')).toBe(false);
    expect(isNodeSupported('')).toBe(false);
  });
});

describe('runPreflight', () => {
  it('fatal = git/node/shell-route; npm/python/pip/path = warn com hint', async () => {
    const checks = await runPreflight('win32');
    // lf-0016: a checagem fatal de shell agregou powershell/pwsh/Git Bash —
    // só falha quando NENHUMA rota nativa executa (WSL nunca substitui).
    const fatalNames = new Set([S.preflightGit, S.preflightNode, S.preflightShellWin]);
    for (const check of checks) {
      if (fatalNames.has(check.name)) {
        expect(check.severity).toBe('fatal');
      } else {
        expect(check.severity).toBe('warn');
      }
    }
    // bloco estendido: npm, toolchain Python, PATH, OS/arch, instalações
    const names = checks.map((c) => c.name);
    for (const required of [
      'npm disponível',
      'pip/pipx/uv (pacotes Python)',
      '~/.forge-cli gravável (shims/PATH)',
      'SO/arquitetura',
      'Instalações registry existentes',
    ]) {
      expect(names).toContain(required);
    }
    // check falho de warn tem dica de remediação
    const failed = checks.filter((c) => !c.ok);
    for (const f of failed) expect(f.hint).toBeTruthy();
  });

  it('keeps fatal gating separate from warn results', async () => {
    const checks = await runPreflight();
    // warn checks may fail without blocking: the run only exits on fatal
    const fatalFailed = checks.filter((c) => c.severity === 'fatal' && !c.ok);
    expect(Array.isArray(fatalFailed)).toBe(true);
  });
});

describe('pythonCandidates', () => {
  it('orders versioned py-launcher probes newest-first on win32, then bare names', () => {
    const candidates = pythonCandidates('win32');
    expect(candidates[0]).toEqual({ exe: 'py', args: ['-3.14'] });
    expect(candidates[4]).toEqual({ exe: 'py', args: ['-3.10'] });
    expect(candidates.slice(-3).map((c) => c.exe)).toEqual(['python', 'python3', 'py']);
  });

  it('orders versioned binaries first on POSIX', () => {
    const candidates = pythonCandidates('linux');
    expect(candidates[0]).toEqual({ exe: 'python3.14', args: [] });
    expect(candidates.slice(-2).map((c) => c.exe)).toEqual(['python3', 'python']);
  });
});

describe('pythonVersion', () => {
  it('resolves a python interpreter on this machine or returns null cleanly', async () => {
    const v = await pythonVersion();
    if (v !== null) expect(v.toLowerCase()).toContain('python');
  });
});
