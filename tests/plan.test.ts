import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planLines } from '../src/plan.js';
import type { ForgeRepo } from '../src/types.js';
import { S } from '../src/ui/strings.js';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-plan-'));
  tmpDirs.push(dir);
  return dir;
}

const repo: ForgeRepo = {
  name: 'demo',
  url: 'https://x/demo',
  description: 'd',
  kind: 'node',
  verify: ['demo', '--help'],
};

function existingGitRepo(targetDir: string): string {
  const repoDir = path.join(targetDir, repo.name);
  mkdirSync(path.join(repoDir, '.git'), { recursive: true });
  return repoDir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('planLines', () => {
  it('plans a clone with deferred detection for missing dirs', () => {
    const lines = planLines(repo, tmpDir()).join('\n');
    expect(lines).toContain('git clone');
    expect(lines).toContain(S.planDetectAfter);
  });

  it('warns on existing non-git dirs', () => {
    const target = tmpDir();
    mkdirSync(path.join(target, repo.name));
    expect(planLines(repo, target).join('\n')).toContain(S.nonGitDir);
  });

  it('lists pull, env stub, script, npm and verify for a git checkout', () => {
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    writeFileSync(path.join(repoDir, 'package-lock.json'), '{}');
    const text = planLines(repo, target).join('\n');
    expect(text).toContain('git pull --ff-only');
    expect(text).toContain(S.planEnvStub);
    expect(text).toContain('npm ci');
    expect(text).toContain('demo --help');
  });

  it('detects the setup script and config examples', () => {
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, process.platform === 'win32' ? 'setup.ps1' : 'setup.sh'), 'x');
    writeFileSync(path.join(repoDir, 'config.example.yaml'), 'a: 1\n');
    const text = planLines(repo, target).join('\n');
    expect(text).toContain(process.platform === 'win32' ? 'setup.ps1' : 'setup.sh');
    expect(text).toContain('config.yaml');
  });
});

describe('executionSummary', () => {
  it('mostra clone e origem para Forja ausente', async () => {
    const { executionSummary, summaryLines } = await import('../src/plan.js');
    const s = await executionSummary(repo, tmpDir());
    expect(s.trust).toBe('builtin');
    expect(s.commands[0]).toContain('git clone -- https://x/demo');
    expect(summaryLines(s).join('\n')).toContain(S.trustBuiltin);
  });

  it('lista comandos exatos e marca repositório customizado', async () => {
    const { executionSummary } = await import('../src/plan.js');
    const target = tmpDir();
    const repoDir = existingGitRepo(target);
    writeFileSync(path.join(repoDir, 'package.json'), '{}');
    const s = await executionSummary({ ...repo, origin: 'custom' }, target, undefined, 'linux');
    expect(s.trust).toBe('custom');
    expect(s.commands).toContain('git pull --ff-only');
    expect(s.commands).toContain('npm install');
    expect(s.commands).toContain('demo --help');
  });

  it('inclui o instalador nativo somente quando solicitado', async () => {
    const { executionSummary } = await import('../src/plan.js');
    const withNative: ForgeRepo = {
      ...repo,
      nativeInstall: { command: ['demo', 'install'], flags: ['profile'] },
    };
    const none = await executionSummary(withNative, tmpDir());
    expect(none.commands.join(' ')).not.toContain('demo install');
    const asked = await executionSummary(withNative, tmpDir(), { profile: 'full' });
    expect(asked.commands).toContain('demo install --profile full --dry-run');
  });
});
