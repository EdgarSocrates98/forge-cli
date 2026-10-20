import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import {
  checkRepoPrereqs,
  compareVersions,
  declaredPrereqs,
  parseEngines,
  parseRequiresPython,
  satisfiesVersion,
} from '../src/prereqs.js';

const mockedExeca = vi.mocked(execa);
const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-pre-'));
  tmpDirs.push(dir);
  return dir;
}

function writePy(dir: string, requiresPython?: string): void {
  writeFileSync(
    path.join(dir, 'pyproject.toml'),
    `[project]\nname = "x"\n${requiresPython ? `requires-python = "${requiresPython}"\n` : ''}`,
  );
}

function writePkg(dir: string, engines?: { node?: string; npm?: string }): void {
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'x', ...(engines ? { engines } : {}) }),
  );
}

function okOut(stdout: string) {
  return { exitCode: 0, stdout, stderr: '' } as never;
}

function failOut() {
  return { exitCode: 1, stdout: '', stderr: '' } as never;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('compareVersions', () => {
  it('compares numeric segments', () => {
    expect(compareVersions('3.10', '3.11')).toBeLessThan(0);
    expect(compareVersions('3.14.0', '3.11')).toBeGreaterThan(0);
    expect(compareVersions('3.11', '3.11.0')).toBe(0);
    expect(compareVersions('v24.16.0', '20')).toBeGreaterThan(0);
  });
});

describe('satisfiesVersion', () => {
  it('handles >= floors like requires-python', () => {
    expect(satisfiesVersion('Python 3.14.0', '>=3.10')).toBe(true);
    expect(satisfiesVersion('Python 3.14.0', '>=3.12')).toBe(true);
    expect(satisfiesVersion('3.9.0', '>=3.10')).toBe(false);
  });

  it('handles ranged specs and exact pins', () => {
    expect(satisfiesVersion('3.11.4', '>=3.10,<4')).toBe(true);
    expect(satisfiesVersion('4.0', '>=3.10,<4')).toBe(false);
    expect(satisfiesVersion('20.0.0', '>=18')).toBe(true);
    expect(satisfiesVersion('16.0.0', '>=18')).toBe(false);
    expect(satisfiesVersion('1.2.3', '=1.2.3')).toBe(true);
    expect(satisfiesVersion('1.2.4', '=1.2.3')).toBe(false);
    expect(satisfiesVersion('9.9.9', '!=9.9.8')).toBe(true);
  });
});

describe('parseRequiresPython', () => {
  it('extracts the spec from pyproject content', () => {
    expect(parseRequiresPython('[project]\nrequires-python = ">=3.12"\n')).toBe('>=3.12');
    expect(parseRequiresPython('requires-python = ">=3.10,<4"')).toBe('>=3.10,<4');
    expect(parseRequiresPython('[project]\nname = "x"')).toBeNull();
  });
});

describe('parseEngines', () => {
  it('reads engines.node/npm from package.json', () => {
    expect(parseEngines('{"engines":{"node":">=18","npm":">=9"}}')).toEqual({
      node: '>=18',
      npm: '>=9',
    });
    expect(parseEngines('{"name":"x"}')).toEqual({});
    expect(parseEngines('not json')).toEqual({});
  });
});

describe('declaredPrereqs', () => {
  it('summarizes declared requirements from repo files', () => {
    const dir = tmpDir();
    writePy(dir, '>=3.11');
    writePkg(dir, { node: '>=18' });
    expect(declaredPrereqs(dir)).toEqual(['python >=3.11', 'node >=18', 'npm']);
  });

  it('returns empty for a repo without manifests', () => {
    expect(declaredPrereqs(tmpDir())).toEqual([]);
  });
});

describe('checkRepoPrereqs', () => {
  it('passes when resolved python satisfies the floor and pip/venv work', async () => {
    const dir = tmpDir();
    writePy(dir, '>=3.11');
    mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
      const joined = args.join(' ');
      // Pipeline lf-0017: nomes do PATH resolvem via where.exe antes do
      // probe `--version` — sem resolução o nome conta como `absent`.
      if (cmd === 'where.exe' && args[0] === 'python') {
        return okOut('C:\\Python314\\python.exe');
      }
      if (joined === '--version' && cmd === 'python') return okOut('Python 3.14.0');
      if (joined === '--version' && cmd !== 'python') return failOut();
      if (joined === '-m pip --version') return okOut('pip 25.0');
      if (joined === '-c import venv') return okOut('');
      return failOut();
    }) as never);
    const checks = await checkRepoPrereqs(dir, 'win32');
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(['Python >=3.11', 'pip', 'venv']);
  });

  it('fails the python check when the resolved version is below floor', async () => {
    const dir = tmpDir();
    writePy(dir, '>=3.12');
    mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
      const joined = args.join(' ');
      if (cmd === 'where.exe' && args[0] === 'python') {
        return okOut('C:\\Python310\\python.exe');
      }
      if (joined === '--version' && cmd === 'python') return okOut('Python 3.10.4');
      if (joined === '-m pip --version') return okOut('pip 25.0');
      if (joined === '-c import venv') return okOut('');
      return failOut();
    }) as never);
    const checks = await checkRepoPrereqs(dir, 'win32');
    const pyCheck = checks.find((c) => c.name.startsWith('Python'));
    expect(pyCheck?.ok).toBe(false);
    expect(pyCheck?.detail).toContain('3.10.4');
  });

  it('fails python and probes the fallback exe when no interpreter resolves', async () => {
    const dir = tmpDir();
    writePy(dir, '>=3.10');
    mockedExeca.mockImplementation((() => failOut()) as never);
    const checks = await checkRepoPrereqs(dir, 'win32');
    expect(checks.find((c) => c.name.startsWith('Python'))?.ok).toBe(false);
    expect(checks.find((c) => c.name === 'pip')?.ok).toBe(false);
    expect(checks.find((c) => c.name === 'venv')?.ok).toBe(false);
  });

  it('reports ok/undeclared when pyproject has no requires-python', async () => {
    const dir = tmpDir();
    writePy(dir);
    mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
      const joined = args.join(' ');
      if (joined === '--version' && cmd === 'python') return okOut('Python 3.14.0');
      return okOut('x');
    }) as never);
    const checks = await checkRepoPrereqs(dir, 'win32');
    expect(checks[0]).toMatchObject({ name: 'Python', ok: true });
  });

  it('checks npm and engines for package.json repos', async () => {
    const dir = tmpDir();
    writePkg(dir, { node: '>=20', npm: '>=9' });
    mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
      if (cmd === 'npm' && args[0] === '--version') return okOut('12.0.2');
      return failOut();
    }) as never);
    const checks = await checkRepoPrereqs(dir, 'linux');
    const names = checks.map((c) => c.name);
    expect(names).toEqual(['npm', 'Node >=20', 'npm >=9']);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('fails npm when unavailable and engines.npm when range unmet', async () => {
    const dir = tmpDir();
    writePkg(dir, { npm: '>=99' });
    mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
      if (cmd === 'npm' && args[0] === '--version') return okOut('12.0.2');
      return failOut();
    }) as never);
    const checks = await checkRepoPrereqs(dir, 'linux');
    expect(checks.find((c) => c.name === 'npm')?.ok).toBe(true);
    expect(checks.find((c) => c.name === 'npm >=99')?.ok).toBe(false);
  });

  it('satisfies the floor via a versioned interpreter when the default is too old', async () => {
    const dir = tmpDir();
    writePy(dir, '>=3.12');
    mockedExeca.mockImplementation(((cmd: string, args: string[] = []) => {
      const joined = args.join(' ');
      // `py` precisa resolver no PATH (where.exe) antes dos probes -3.x.
      if (cmd === 'where.exe' && args[0] === 'py') return okOut('C:\\Windows\\py.exe');
      if (cmd === 'py' && joined === '-3.12 -m pip --version') return okOut('pip 25.0');
      if (cmd === 'py' && joined === '-3.12 -c import venv') return okOut('');
      if (cmd === 'py' && joined === '-3.12 --version') return okOut('Python 3.12.4');
      if (joined.endsWith('--version')) return failOut();
      return failOut();
    }) as never);
    const checks = await checkRepoPrereqs(dir, 'win32');
    const pyCheck = checks.find((c) => c.name === 'Python >=3.12');
    expect(pyCheck?.ok).toBe(true);
    expect(pyCheck?.detail).toContain('py -3.12');
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(mockedExeca).toHaveBeenCalledWith(
      'py',
      ['-3.12', '-m', 'pip', '--version'],
      expect.objectContaining({ reject: false }),
    );
  });

  it('returns no checks for a repo without manifests', async () => {
    expect(await checkRepoPrereqs(tmpDir())).toEqual([]);
  });
});
