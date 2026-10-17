// P0-001: invariantes do pipeline npm Trusted Publishing — assertivas sobre o
// workflow real (não sobre cópia), + unidade do release gate.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..');
const wf = readFileSync(path.join(root, '.github', 'workflows', 'publish-npm.yml'), 'utf8');

describe('P0-001: publish-npm.yml invariantes', () => {
  it('disparo só por workflow_dispatch (nunca push na main)', () => {
    expect(wf).toContain('workflow_dispatch');
    expect(wf).not.toMatch(/on:\s*\n\s*push/);
  });
  it('id-token só no job publish, contents:read como default', () => {
    expect(wf).toContain('contents: read');
    const publishBlock = wf.split('publish:')[1];
    expect(publishBlock).toContain('id-token: write');
    expect(wf.split('validate:')[1].split('publish:')[0]).not.toContain('id-token');
  });
  it('environment npm (approval) + concurrency + ref pinado no SHA validado', () => {
    expect(wf).toContain('environment: npm');
    expect(wf).toContain('concurrency:');
    expect(wf).toContain('ref: ${{ needs.validate.outputs.sha }}');
  });
  it('sem token persistente: nenhum NODE_AUTH_TOKEN', () => {
    expect(wf).not.toContain('NODE_AUTH_TOKEN');
  });
  it('actions pinadas em SHA de 40 chars', () => {
    const uses = [...wf.matchAll(/uses: ([^@\s]+)@([0-9a-f]{40})/g)];
    expect(uses.length).toBeGreaterThanOrEqual(4);
  });
  it('publish com provenance + verificação pós-publish', () => {
    expect(wf).toContain('--provenance');
    expect(wf).toContain('npm view theforge-cli@');
  });
});

describe('verify-version.mjs — release gate', () => {
  // Pacote sintético em tmp (version 0.1.0, já publicada no npm): torna o
  // teste de version-exists determinístico independente do bump corrente.
  const fake = mkdtempSync(path.join(tmpdir(), 'release-gate-'));
  mkdirSync(path.join(fake, 'scripts', 'release'), { recursive: true });
  cpSync(
    path.join(root, 'scripts', 'release', 'verify-version.mjs'),
    path.join(fake, 'scripts', 'release', 'verify-version.mjs'),
  );
  writeFileSync(
    path.join(fake, 'package.json'),
    JSON.stringify({
      name: 'theforge-cli',
      version: '0.1.0',
      license: 'MIT',
      repository: { url: 'git+https://github.com/EdgarSocrates98/forge-cli.git' },
      files: ['dist'],
    }),
  );
  afterAll(() => rmSync(fake, { recursive: true, force: true }));

  const gate = (args: string[]) => {
    try {
      return JSON.parse(
        execFileSync(
          'node',
          [path.join(fake, 'scripts', 'release', 'verify-version.mjs'), ...args],
          { encoding: 'utf8' },
        ),
      ) as { ok: boolean; code?: string };
    } catch (e) {
      return JSON.parse((e as { stdout: string }).stdout) as { ok: boolean; code?: string };
    }
  };
  it('formato inválido ⇒ version-invalid', () => {
    expect(gate(['abc']).code).toBe('version-invalid');
  });
  it('mismatch package.json ⇒ version-mismatch', () => {
    expect(gate(['9.9.9']).code).toBe('version-mismatch');
  });
  it('versão já publicada (0.1.0 no npm) ⇒ version-exists', () => {
    expect(gate(['0.1.0']).code).toBe('version-exists');
  }, 30_000);
});
