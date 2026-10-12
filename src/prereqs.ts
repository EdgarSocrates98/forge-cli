import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pythonInfo } from './preflight.js';
import type { PrereqCheck } from './types.js';
import { S } from './ui/strings.js';
import { commandOutput, commandWorks } from './utils/system.js';

function parseVersion(version: string): number[] {
  const match = version.match(/\d+(?:\.\d+)*/);
  return match ? match[0].split('.').map((p) => Number.parseInt(p, 10) || 0) : [0];
}

export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (va[i] ?? 0) - (vb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function satisfiesVersion(version: string, spec: string): boolean {
  for (const part of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = part.match(/^(>=|<=|==|!=|>|<|=)?\s*(.+)$/);
    if (!m) return false;
    const op = m[1] ?? '=';
    const cmp = compareVersions(version, m[2]);
    if (op === '>=' && cmp < 0) return false;
    if (op === '>' && cmp <= 0) return false;
    if (op === '<=' && cmp > 0) return false;
    if (op === '<' && cmp >= 0) return false;
    if ((op === '=' || op === '==') && cmp !== 0) return false;
    if (op === '!=' && cmp === 0) return false;
  }
  return true;
}

export function parseRequiresPython(pyproject: string): string | null {
  const m = pyproject.match(/requires-python\s*=\s*["']([^"']+)["']/);
  return m?.[1]?.trim() || null;
}

export function parseEngines(pkgJson: string): { node?: string; npm?: string } {
  try {
    const parsed = JSON.parse(pkgJson) as { engines?: { node?: string; npm?: string } };
    return parsed.engines ?? {};
  } catch {
    return {};
  }
}

function readIfExists(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function declaredPrereqs(repoDir: string): string[] {
  const declared: string[] = [];
  const py = readIfExists(path.join(repoDir, 'pyproject.toml'));
  if (py !== null) {
    const spec = parseRequiresPython(py);
    declared.push(spec ? `python ${spec}` : 'python');
  }
  const pkg = readIfExists(path.join(repoDir, 'package.json'));
  if (pkg !== null) {
    const engines = parseEngines(pkg);
    declared.push(
      engines.node ? `node ${engines.node}` : 'node',
      engines.npm ? `npm ${engines.npm}` : 'npm',
    );
  }
  return declared;
}

export async function checkRepoPrereqs(
  repoDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<PrereqCheck[]> {
  const checks: PrereqCheck[] = [];
  const py = readIfExists(path.join(repoDir, 'pyproject.toml'));
  const pkg = readIfExists(path.join(repoDir, 'package.json'));

  if (py !== null) {
    const spec = parseRequiresPython(py);
    const pyInfo = await pythonInfo(platform);
    if (spec) {
      if (!pyInfo) {
        checks.push({ name: `Python ${spec}`, ok: false, detail: S.pythonNotFound });
      } else {
        const ok = satisfiesVersion(pyInfo.version, spec);
        checks.push({
          name: `Python ${spec}`,
          ok,
          detail: ok ? pyInfo.version : `${S.prereqFound}: ${pyInfo.version}`,
        });
      }
    } else {
      checks.push({ name: 'Python', ok: true, detail: S.prereqNotDeclared });
    }
    const base = pyInfo?.exe ?? (platform === 'win32' ? 'python' : 'python3');
    checks.push({
      name: 'pip',
      ok: (await commandOutput(base, ['-m', 'pip', '--version'])) !== null,
      detail: `${base} -m pip --version`,
    });
    checks.push({
      name: 'venv',
      ok: await commandWorks(base, ['-c', 'import venv']),
      detail: `${base} -c "import venv"`,
    });
  }

  if (pkg !== null) {
    const npmVersion = await commandOutput('npm', ['--version']);
    checks.push({
      name: 'npm',
      ok: npmVersion !== null,
      detail: npmVersion ?? S.pythonNotFound,
    });
    const engines = parseEngines(pkg);
    if (engines.node) {
      const ok = satisfiesVersion(process.version, engines.node);
      checks.push({
        name: `Node ${engines.node}`,
        ok,
        detail: ok ? process.version : `${S.prereqFound}: ${process.version}`,
      });
    }
    if (engines.npm) {
      const ok = npmVersion !== null && satisfiesVersion(npmVersion, engines.npm);
      checks.push({
        name: `npm ${engines.npm}`,
        ok,
        detail: ok ? (npmVersion ?? '') : `${S.prereqFound}: ${npmVersion ?? S.pythonNotFound}`,
      });
    }
  }

  return checks;
}
