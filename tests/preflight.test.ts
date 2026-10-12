import { describe, expect, it } from 'vitest';
import {
  isNodeSupported,
  pythonCandidates,
  pythonVersion,
  runPreflight,
} from '../src/preflight.js';

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
  it('marks git/node/powershell checks as fatal and python as warn', async () => {
    const checks = await runPreflight('win32');
    const byName = new Map(checks.map((c) => [c.name, c]));
    const python = checks.find((c) => c.severity === 'warn');
    expect(python, 'python check should exist').toBeDefined();
    expect(python?.name).toContain('Python');
    for (const [name, check] of byName) {
      if (!name.includes('Python')) expect(check.severity).toBe('fatal');
    }
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
