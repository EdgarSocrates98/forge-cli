import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  childReceiptDirs,
  delegationVerdict,
  findChildReceipt,
  isValidChildReceipt,
  receiptFromStdout,
  type ChildReceipt,
} from '../src/child-receipt.js';

/**
 * P0-2 wave-14: exit code 0 nunca é prova de instalação — só conta um
 * `forge/InstallReceipt/v1` da Forja certa + operação certa +
 * status completed + verification PASS.
 */
const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-cli-rcpt-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function receiptDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'forge/InstallReceipt/v1',
    forge_id: 'acme-forge',
    operation: 'install',
    status: 'completed',
    verification: { status: 'PASS' },
    ...over,
  };
}

function writeReceipt(root: string, stateDir: string, name: string, doc: unknown): string {
  const dir = path.join(root, stateDir, 'receipts');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

describe('isValidChildReceipt', () => {
  it('exige schema exato + forge_id + operation', () => {
    expect(isValidChildReceipt(receiptDoc(), 'acme-forge', 'install')).toBe(true);
    expect(isValidChildReceipt(receiptDoc({ schema: 'forge/Other/v1' }), 'acme-forge')).toBe(false);
    expect(isValidChildReceipt(receiptDoc({ forge_id: 'outra' }), 'acme-forge')).toBe(false);
    expect(isValidChildReceipt(receiptDoc({ operation: 'uninstall' }), 'acme-forge')).toBe(false);
    expect(isValidChildReceipt(null, 'acme-forge')).toBe(false);
    expect(isValidChildReceipt('{}', 'acme-forge')).toBe(false);
  });
});

describe('receiptFromStdout', () => {
  it('stdout JSON inteiro vale; linha final {…} também vale', () => {
    expect(receiptFromStdout(JSON.stringify(receiptDoc()), 'acme-forge')).not.toBeNull();
    const noisy = `log linha 1\noutra linha\n${JSON.stringify(receiptDoc())}\n`;
    expect(receiptFromStdout(noisy, 'acme-forge')?.forge_id).toBe('acme-forge');
  });
  it('receipt de OUTRA forja no stdout não conta', () => {
    const doc = receiptDoc({ forge_id: 'outra-forge' });
    expect(receiptFromStdout(JSON.stringify(doc), 'acme-forge')).toBeNull();
  });
});

describe('childReceiptDirs', () => {
  it('encontra .<state>/receipts e .<state>/install/receipts', () => {
    const root = temp();
    writeReceipt(root, '.acme', 'a.json', receiptDoc());
    writeReceipt(root, path.join('.forge', 'install'), 'b.json', receiptDoc());
    const dirs = childReceiptDirs(root);
    expect(dirs.some((d) => d.endsWith(path.join('.acme', 'receipts')))).toBe(true);
    expect(dirs.some((d) => d.endsWith(path.join('.forge', 'install', 'receipts')))).toBe(true);
  });
});

describe('findChildReceipt — precedência e staleness', () => {
  it('stdout vence filesystem', () => {
    const root = temp();
    writeReceipt(root, '.acme', 'install-1.json', receiptDoc({ marker: 'file' }));
    const found = findChildReceipt({
      forgeId: 'acme-forge',
      roots: [root],
      stdout: JSON.stringify(receiptDoc({ marker: 'stdout' })),
    });
    expect(found?.ref).toBe('stdout');
  });

  it('receipt mais novo e válido ganha; antigo demais é ignorado', () => {
    const root = temp();
    const old = writeReceipt(root, '.acme', 'install-old.json', receiptDoc());
    // sinceMs no futuro → tudo é "antigo" → nada conta.
    const found = findChildReceipt({
      forgeId: 'acme-forge',
      roots: [root],
      sinceMs: Date.now() + 60_000,
    });
    expect(found).toBeNull();
    expect(old).toBeTruthy();
  });

  it('forge_id errado no disco não vale (identidade, não só schema)', () => {
    const root = temp();
    writeReceipt(root, '.acme', 'install-1.json', receiptDoc({ forge_id: 'impostor' }));
    const found = findChildReceipt({ forgeId: 'acme-forge', roots: [root] });
    expect(found).toBeNull();
  });

  it('JSON malformado é ignorado, não derruba a busca', () => {
    const root = temp();
    const dir = path.join(root, '.acme', 'receipts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'install-bad.json'), '{quebrado');
    const good = writeReceipt(root, '.acme', 'install-good.json', receiptDoc());
    const found = findChildReceipt({ forgeId: 'acme-forge', roots: [root] });
    expect(found?.ref).toBe(good);
  });
});

describe('delegationVerdict — exit 0 NUNCA é prova sozinho', () => {
  const receiptAt = (doc: Record<string, unknown>): ChildReceipt => ({
    doc,
    ref: '/tmp/fake.json',
  });

  it('rc != 0 → failed mesmo com receipt PASS', () => {
    expect(delegationVerdict(1, receiptAt(receiptDoc()))).toBe('failed');
  });
  it('rc 0 sem receipt → unverified (não applied!)', () => {
    expect(delegationVerdict(0, null)).toBe('unverified');
  });
  it('rc 0 + receipt completed/PASS → applied', () => {
    expect(delegationVerdict(0, receiptAt(receiptDoc()))).toBe('applied');
  });
  it('rc 0 + receipt completed sem PASS → unverified', () => {
    expect(delegationVerdict(0, receiptAt(receiptDoc({ verification: { status: 'FAIL' } })))).toBe(
      'unverified',
    );
  });
  it('rc 0 + receipt planned → unverified', () => {
    expect(delegationVerdict(0, receiptAt(receiptDoc({ status: 'planned' })))).toBe('unverified');
  });
  it('rc 0 + receipt status estranho → failed', () => {
    expect(delegationVerdict(0, receiptAt(receiptDoc({ status: 'corrupted' })))).toBe('failed');
  });
});
