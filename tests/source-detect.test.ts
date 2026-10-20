import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contractValidator } from '../src/contracts/index.js';
import { detectSource, looksLikePathArg } from '../src/source/detect.js';

let tmp: string;
beforeEach(() => (tmp = mkdtempSync(path.join(os.tmpdir(), 'src-detect-'))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function makeForge(dir: string, opts: { forgeId?: string; manifest?: unknown } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'forge.json'),
    JSON.stringify(opts.manifest ?? { forge_id: opts.forgeId ?? 'custom-forge' }, null, 2),
  );
  writeFileSync(path.join(dir, 'setup.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
}

/** O contrato exige que todo veredito valide — prova de auditabilidade. */
function expectContract(det: ReturnType<typeof detectSource>) {
  expect(contractValidator().validate('forge/LocalForgeSourceDetection/v1', det)).toEqual([]);
}

describe('detectSource — os 8 estados', () => {
  it('GIT_REPOSITORY: .git diretório + manifesto + estrutura + checksums ok → identidade A', () => {
    const dir = path.join(tmp, 'repo');
    makeForge(dir);
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha('#!/bin/sh\nexit 0\n')}  setup.sh\n`);
    const det = detectSource(dir);
    expect(det.state).toBe('GIT_REPOSITORY');
    expect(det.is_git).toBe(true);
    expect(det.manifest_valid).toBe(true);
    expect(det.identity).toBe('A');
    expect(det.integrity).toBe('verified');
    expect(det.refusal).toBeUndefined();
    expectContract(det);
  });

  it('GIT_WORKTREE: .git arquivo (gitdir:) — distinto de diretório, nunca normalizado a repo', () => {
    const dir = path.join(tmp, 'wt');
    makeForge(dir);
    writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    const det = detectSource(dir);
    expect(det.state).toBe('GIT_WORKTREE');
    expect(det.is_git).toBe(true);
    expect(det.identity).not.toBe('A'); // worktree nunca alcança A
    expectContract(det);
  });

  it('GITLESS_VALID_FORGE: sem .git + forge.json válido + estrutura → identidade B', () => {
    const dir = path.join(tmp, 'zip-download');
    makeForge(dir);
    const det = detectSource(dir);
    expect(det.state).toBe('GITLESS_VALID_FORGE');
    expect(det.is_git).toBe(false);
    expect(det.identity).toBe('B');
    expect(det.source_trust).toBe('B');
    expect(det.manifest_valid).toBe(true);
    expect(det.forge_id).toBe('custom-forge');
    expect(det.refusal).toBeUndefined();
    expectContract(det);
  });

  it('GITLESS_PARTIAL_FORGE: forge.json válido sem estrutura → identidade C + integrity partial', () => {
    const dir = path.join(tmp, 'bare');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'forge.json'), JSON.stringify({ forge_id: 'lonely-forge' }));
    const det = detectSource(dir);
    expect(det.state).toBe('GITLESS_PARTIAL_FORGE');
    expect(det.identity).toBe('C');
    expect(det.integrity).toBe('partial');
    expectContract(det);
  });

  it('UNKNOWN_DIRECTORY: caminho inexistente → FORGE-SOURCE-NOT-FOUND', () => {
    const det = detectSource(path.join(tmp, 'nope'));
    expect(det.state).toBe('UNKNOWN_DIRECTORY');
    expect(det.refusal?.code).toBe('FORGE-SOURCE-NOT-FOUND');
    expect(det.identity).toBe('none');
    expectContract(det);
  });

  it('UNKNOWN_DIRECTORY: dir sem .git e sem forge.json → FORGE-SOURCE-NOT-FOUND', () => {
    const dir = path.join(tmp, 'random');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'README.md'), 'hi');
    const det = detectSource(dir);
    expect(det.state).toBe('UNKNOWN_DIRECTORY');
    expect(det.refusal?.code).toBe('FORGE-SOURCE-NOT-FOUND');
    expectContract(det);
  });

  it('INVALID_MANIFEST: JSON malformado → FORGE-SOURCE-INVALID', () => {
    const dir = path.join(tmp, 'bad');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'forge.json'), '{oops');
    const det = detectSource(dir);
    expect(det.state).toBe('INVALID_MANIFEST');
    expect(det.refusal?.code).toBe('FORGE-SOURCE-INVALID');
    expect(det.manifest_valid).toBe(false);
    expectContract(det);
  });

  it('INVALID_MANIFEST: JSON válido sem forge_id → FORGE-SOURCE-INVALID', () => {
    const dir = path.join(tmp, 'noid');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'forge.json'), JSON.stringify({ cli: 'x' }));
    const det = detectSource(dir);
    expect(det.state).toBe('INVALID_MANIFEST');
    expect(det.refusal?.code).toBe('FORGE-SOURCE-INVALID');
    expectContract(det);
  });

  it('INVALID_MANIFEST: forge_id inseguro (traversal) → FORGE-SOURCE-INVALID', () => {
    const dir = path.join(tmp, 'trav');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'forge.json'), JSON.stringify({ forge_id: '../escape' }));
    const det = detectSource(dir);
    expect(det.state).toBe('INVALID_MANIFEST');
    expect(det.refusal?.code).toBe('FORGE-SOURCE-INVALID');
    expectContract(det);
  });

  it('CONFLICTING_IDENTITY: dir de Forja do catálogo com forge_id divergente → FORGE-SOURCE-CONFLICT', () => {
    const dir = path.join(tmp, 'api-forge');
    makeForge(dir, { forgeId: 'custom-forge' });
    const det = detectSource(dir);
    expect(det.state).toBe('CONFLICTING_IDENTITY');
    expect(det.refusal?.code).toBe('FORGE-SOURCE-CONFLICT');
    expect(det.manifest_valid).toBe(true); // manifesto é válido — a identidade contradiz
    expectContract(det);
  });

  it('CONFLICTING_IDENTITY: forge_id do catálogo com cli de OUTRA Forja do catálogo', () => {
    const dir = path.join(tmp, 'mixed');
    makeForge(dir, { manifest: { forge_id: 'api-forge', cli: 'the-forge' } });
    const det = detectSource(dir);
    expect(det.state).toBe('CONFLICTING_IDENTITY');
    expect(det.refusal?.code).toBe('FORGE-SOURCE-CONFLICT');
    expectContract(det);
  });

  it('UNTRUSTED_SOURCE: fonte por link simbólico → FORGE-SOURCE-INVALID', () => {
    const real = path.join(tmp, 'real');
    makeForge(real);
    const link = path.join(tmp, 'linked');
    symlinkSync(real, link, 'dir');
    const det = detectSource(link);
    expect(det.state).toBe('UNTRUSTED_SOURCE');
    expect(det.refusal?.code).toBe('FORGE-SOURCE-INVALID');
    expectContract(det);
  });

  it('UNTRUSTED_SOURCE: forge.json por link simbólico → FORGE-SOURCE-INVALID', () => {
    const dir = path.join(tmp, 'planted');
    makeForge(dir);
    const outside = path.join(tmp, 'outside.json');
    writeFileSync(outside, JSON.stringify({ forge_id: 'planted' }));
    rmSync(path.join(dir, 'forge.json'));
    symlinkSync(outside, path.join(dir, 'forge.json'));
    const det = detectSource(dir);
    expect(det.state).toBe('UNTRUSTED_SOURCE');
    expect(det.refusal?.code).toBe('FORGE-SOURCE-INVALID');
    expectContract(det);
  });
});

describe('detectSource — integridade nunca identifica origem', () => {
  it('checksum divergente rebaixa integrity, NÃO o estado nem a identidade', () => {
    const dir = path.join(tmp, 'drifted');
    makeForge(dir);
    writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha('other')}  setup.sh\n`);
    const det = detectSource(dir);
    expect(det.state).toBe('GITLESS_VALID_FORGE'); // permanece instalável
    expect(det.identity).toBe('B');
    expect(det.integrity).toBe('partial');
    expect(det.refusal).toBeUndefined();
    expectContract(det);
  });

  it('checksums verificados em fonte gitless → integrity verified', () => {
    const dir = path.join(tmp, 'summed');
    makeForge(dir);
    writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha('#!/bin/sh\nexit 0\n')}  setup.sh\n`);
    const det = detectSource(dir);
    expect(det.state).toBe('GITLESS_VALID_FORGE');
    expect(det.integrity).toBe('verified');
    expectContract(det);
  });

  it('.git dir sem manifesto → GIT_REPOSITORY com identidade none (git NÃO é manifesto)', () => {
    const dir = path.join(tmp, 'raw-git');
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    writeFileSync(path.join(dir, 'setup.sh'), 'x');
    const det = detectSource(dir);
    expect(det.state).toBe('GIT_REPOSITORY');
    expect(det.manifest_valid).toBe(false);
    expect(det.identity).toBe('none');
    expect(det.refusal).toBeUndefined(); // rota git cuida dele — não é recusa local
    expectContract(det);
  });
});

describe('looksLikePathArg — roteamento install <dir>', () => {
  it('diretório existente e caminho com separador são fonte local', () => {
    const dir = path.join(tmp, 'a-dir');
    mkdirSync(dir);
    expect(looksLikePathArg(dir)).toBe(true);
    expect(looksLikePathArg('./x')).toBe(true);
    expect(looksLikePathArg('some/where')).toBe(true);
  });
  it('nome de Forja simples inexistente NÃO é caminho', () => {
    expect(looksLikePathArg('api-forge')).toBe(false);
    expect(looksLikePathArg('not-a-dir-anywhere')).toBe(false);
  });
});
