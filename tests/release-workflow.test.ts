// P0-001: invariantes do pipeline npm Trusted Publishing — assertivas sobre o
// workflow real (não sobre cópia), + unidade do release gate.
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..');
const wf = readFileSync(path.join(root, '.github', 'workflows', 'publish-npm.yml'), 'utf8');

/** Blocos `run: |` do workflow — onde interpolação insegura viveria. */
const runBlocks = [...wf.matchAll(/run: \|?\n((?:\s+.+\n?)+)/g)].map((m) => m[1]);

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
  it('actions pinadas em SHA de 40 chars (incl. upload/download-artifact)', () => {
    const uses = [...wf.matchAll(/uses: ([^@\s]+)@([0-9a-f]{40})/g)];
    expect(uses.length).toBeGreaterThanOrEqual(6);
    expect(wf).toMatch(/actions\/upload-artifact@[0-9a-f]{40}/);
    expect(wf).toMatch(/actions\/download-artifact@[0-9a-f]{40}/);
  });
  it('inputs chegam via env — nenhum ${{ inputs.* }} dentro de run:', () => {
    expect(wf).toContain('RELEASE_VERSION: ${{ inputs.version }}');
    expect(wf).toContain('RELEASE_TAG: ${{ inputs.tag }}');
    for (const block of runBlocks) {
      expect(block).not.toContain('${{ inputs.');
    }
  });
  it('branch gate: dispatch fora da main falha (github.ref_name)', () => {
    expect(wf).toContain('REF_NAME: ${{ github.ref_name }}');
    expect(wf).toContain('"$REF_NAME" != "main"');
  });
  it('binding anti-TOCTOU: tarball sobe no validate, desce no publish', () => {
    const validateBlock = wf.split('publish:')[0];
    expect(validateBlock).toMatch(/npm pack --json/);
    expect(validateBlock).not.toContain('npm pack --dry-run');
    expect(wf).toContain('name: npm-tarball');
    expect(wf).toContain('if-no-files-found: error');
    // publish usa o .tgz — nunca `npm publish` nu (que rebuildaria)
    expect(wf).toMatch(/npm publish "theforge-cli-\$RELEASE_VERSION\.tgz" --provenance/);
  });
  it('publish re-valida SHA (--expect-sha) e não rebuilda', () => {
    const publishBlock = wf.split('\n  publish:')[1];
    expect(publishBlock).toContain('--expect-sha "$EXPECT_SHA"');
    expect(publishBlock).toContain('EXPECT_SHA: ${{ needs.validate.outputs.sha }}');
    expect(publishBlock).not.toContain('npm ci');
    expect(publishBlock).not.toContain('npm run build');
  });
  it('artifact gate: exatamente um .tgz com o nome da versão', () => {
    expect(wf).toContain('TARBALL="theforge-cli-$RELEASE_VERSION.tgz"');
    expect(wf).toContain('wc -l');
  });
  it('attestation ausente é falha — sem `|| echo` mascarando', () => {
    const att = wf.split('dist.attestations');
    expect(att.length).toBeGreaterThan(1);
    const attLine = att[1].split('\n')[0];
    expect(attLine).not.toContain('|| echo');
    expect(wf).not.toContain("|| echo 'attestations");
    expect(wf).toContain('attestation ausente');
  });
  it('integrity pós-publish: dist.integrity do registry == sha512 local', () => {
    expect(wf).toContain('dist.integrity');
    expect(wf).toContain('sha512');
    expect(wf).toContain('[ "$REMOTE" = "$LOCAL" ]');
  });
  it('publish com provenance + verificação pós-publish', () => {
    expect(wf).toContain('--provenance');
    expect(wf).toContain('npm view "theforge-cli@$RELEASE_VERSION"');
  });
});

// ---------------------------------------------------------------------------
// Fixture: pacote sintético + git repo (tag/sha gates precisam de história).
// ---------------------------------------------------------------------------

const makeFake = (pkgVersion: string, lockVersion: string | null = pkgVersion) => {
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
      version: pkgVersion,
      license: 'MIT',
      repository: { url: 'git+https://github.com/EdgarSocrates98/forge-cli.git' },
      files: ['dist'],
    }),
  );
  if (lockVersion !== null) {
    writeFileSync(
      path.join(fake, 'package-lock.json'),
      JSON.stringify({
        name: 'theforge-cli',
        version: lockVersion,
        lockfileVersion: 3,
        packages: { '': { name: 'theforge-cli', version: lockVersion } },
      }),
    );
  }
  return fake;
};

const gate = (fake: string, args: string[]) => {
  try {
    return JSON.parse(
      execFileSync('node', [path.join(fake, 'scripts', 'release', 'verify-version.mjs'), ...args], {
        encoding: 'utf8',
      }),
    ) as { ok: boolean; code?: string; sha?: string };
  } catch (e) {
    return JSON.parse((e as { stdout: string }).stdout) as { ok: boolean; code?: string };
  }
};

describe('verify-version.mjs — release gate', () => {
  // Pacote sintético em tmp (version 0.1.0, já publicada no npm): torna o
  // teste de version-exists determinístico independente do bump corrente.
  const fake = makeFake('0.1.0');
  afterAll(() => rmSync(fake, { recursive: true, force: true }));

  it('formato inválido ⇒ version-invalid', () => {
    expect(gate(fake, ['abc']).code).toBe('version-invalid');
  });
  it('SemVer estrito: leading zero e versão parcial recusados', () => {
    expect(gate(fake, ['01.2.3']).code).toBe('version-invalid');
    expect(gate(fake, ['0.1']).code).toBe('version-invalid');
    expect(gate(fake, ['0.1.0-']).code).toBe('version-invalid');
  });
  it('input malformado/perigoso ⇒ version-invalid (nunca chega ao shell)', () => {
    expect(gate(fake, ['0.1.0; rm -rf /']).code).toBe('version-invalid');
    expect(gate(fake, ['$(id)']).code).toBe('version-invalid');
  });
  it('mismatch package.json ⇒ version-mismatch', () => {
    expect(gate(fake, ['9.9.9']).code).toBe('version-mismatch');
  });
  it('versão já publicada (0.1.0 no npm) ⇒ version-exists', () => {
    expect(gate(fake, ['0.1.0']).code).toBe('version-exists');
  }, 30_000);
});

describe('verify-version.mjs — package-lock e git bindings', () => {
  const fake = makeFake('9.9.9');
  const rev = () => execSync('git rev-parse HEAD', { cwd: fake, encoding: 'utf8' }).trim();
  execSync('git init -q && git add -A', { cwd: fake });
  execSync('git -c user.email=t@t -c user.name=t commit -qm init', { cwd: fake });
  const first = rev();
  writeFileSync(path.join(fake, 'x.txt'), 'x');
  execSync('git add x.txt && git -c user.email=t@t -c user.name=t commit -qm x', { cwd: fake });
  afterAll(() => rmSync(fake, { recursive: true, force: true }));

  it('tag inexistente ⇒ tag-missing', () => {
    expect(gate(fake, ['9.9.9', '--tag', 'v9.9.9']).code).toBe('tag-missing');
  });
  it('tag apontando para commit ≠ HEAD ⇒ tag-mismatch; == HEAD ⇒ ok', () => {
    execSync(`git tag v9.9.9 ${first}`, { cwd: fake }); // tag no 1º; HEAD = 2º
    expect(gate(fake, ['9.9.9', '--tag', 'v9.9.9']).code).toBe('tag-mismatch');
    execSync('git tag -f v9.9.9 HEAD', { cwd: fake }); // tag agora em HEAD
    const r = gate(fake, ['9.9.9', '--tag', 'v9.9.9']);
    // passa o check de tag (9.9.9 nunca publicada ⇒ sem version-exists)
    expect(r.code === undefined || r.code === 'version-exists').toBe(true);
  });
  it('--expect-sha divergente ⇒ sha-mismatch; igual ⇒ passa o check', () => {
    expect(gate(fake, ['9.9.9', '--expect-sha', '0'.repeat(40)]).code).toBe('sha-mismatch');
    const r = gate(fake, ['9.9.9', '--expect-sha', rev()]);
    expect(r.code).not.toBe('sha-mismatch');
  });
  it('--expect-sha malformado ⇒ sha-invalid', () => {
    expect(gate(fake, ['9.9.9', '--expect-sha', 'abc']).code).toBe('sha-invalid');
  });
  it('lock divergente ⇒ lock-mismatch', () => {
    writeFileSync(
      path.join(fake, 'package-lock.json'),
      JSON.stringify({ version: '9.9.8', packages: { '': { version: '9.9.8' } } }),
    );
    expect(gate(fake, ['9.9.9']).code).toBe('lock-mismatch');
    writeFileSync(
      path.join(fake, 'package-lock.json'),
      JSON.stringify({ version: '9.9.9', packages: { '': { version: '9.9.9' } } }),
    );
  });
  it('lock ausente ⇒ lock-missing', () => {
    const bare = makeFake('9.9.9', null);
    try {
      execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm i', {
        cwd: bare,
      });
      expect(gate(bare, ['9.9.9']).code).toBe('lock-missing');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
