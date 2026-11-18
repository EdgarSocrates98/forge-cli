/**
 * Receipt do filho delegado — port da lógica de
 * `the-forge/install/service._child_install_receipt` +
 * `_delegation_verdict`.
 *
 * Um exit code 0 NÃO é evidência de instalação: só conta um
 * `forge/InstallReceipt/v1` válido para ESTA Forja + operação, com
 * `status: completed` e `verification.status: PASS`. Qualquer outra
 * combinação é honesta — `unverified` (rodou limpo, sem prova) ou
 * `failed` — nunca `applied` por retorno de processo sozinho.
 */
import { readdirSync, readFileSync, lstatSync, statSync } from 'node:fs';
import path from 'node:path';

export const CHILD_RECEIPT_SCHEMA = 'forge/InstallReceipt/v1';
export const CHILD_RECEIPTS_DIR = 'receipts';

export type DelegationVerdict = 'applied' | 'unverified' | 'failed';

export interface ChildReceipt {
  readonly doc: Record<string, unknown>;
  /** Onde o receipt foi encontrado — caminho do arquivo ou 'stdout'. */
  readonly ref: string;
}

/** Shape + identidade: schema exato, `forge_id` e `operation` casando. */
export function isValidChildReceipt(
  doc: unknown,
  forgeId: string,
  operation = 'install',
): doc is Record<string, unknown> {
  return (
    doc !== null &&
    typeof doc === 'object' &&
    (doc as Record<string, unknown>).schema === CHILD_RECEIPT_SCHEMA &&
    (doc as Record<string, unknown>).forge_id === forgeId &&
    (doc as Record<string, unknown>).operation === operation
  );
}

/** Stdout inteiro como JSON primeiro; senão últimas linhas `{…}`. */
export function receiptFromStdout(
  text: string | undefined,
  forgeId: string,
  operation = 'install',
): Record<string, unknown> | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  try {
    const doc: unknown = JSON.parse(trimmed);
    if (isValidChildReceipt(doc, forgeId, operation)) return doc;
  } catch {
    /* stdout não é um JSON único — tenta linha a linha */
  }
  for (const line of trimmed.split('\n').reverse()) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      const doc: unknown = JSON.parse(l);
      if (isValidChildReceipt(doc, forgeId, operation)) return doc;
    } catch {
      /* linha não-JSON — segue procurando */
    }
  }
  return null;
}

/**
 * Diretórios candidatos `<root>/.<state>/receipts` e
 * `<root>/.<state>/install/receipts` — a convenção `.<state>/` do
 * installkit (`.forge/`, `.<forge_id>/`…), sem seguir symlinks.
 */
export function childReceiptDirs(root: string): string[] {
  const dirs: string[] = [];
  let hidden: string[] = [];
  try {
    hidden = readdirSync(root)
      .filter((name) => name.startsWith('.'))
      .filter((name) => {
        const p = path.join(root, name);
        try {
          return statSync(p).isDirectory() && !lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return dirs;
  }
  for (const dir of hidden) {
    for (const cand of [
      path.join(root, dir, CHILD_RECEIPTS_DIR),
      path.join(root, dir, 'install', CHILD_RECEIPTS_DIR),
    ]) {
      try {
        if (statSync(cand).isDirectory()) dirs.push(cand);
      } catch {
        /* candidato ausente */
      }
    }
  }
  return dirs;
}

export interface FindChildReceiptOptions {
  readonly forgeId: string;
  readonly operation?: string;
  /** Raízes varridas por `.<state>/receipts` (alvo + home p/ user scope). */
  readonly roots: readonly string[];
  /** Receipts com mtime anterior a `sinceMs - 1s` são ignorados (staleness). */
  readonly sinceMs?: number;
  /** Stdout do filho — checado antes do filesystem. */
  readonly stdout?: string;
}

/**
 * Localiza o receipt do filho: stdout primeiro (o filho pode emitir o
 * doc no terminal), depois o arquivo MAIS NOVO válido escrito após
 * `sinceMs` nos diretórios `.<state>/receipts` das raízes.
 */
export function findChildReceipt(opts: FindChildReceiptOptions): ChildReceipt | null {
  const operation = opts.operation ?? 'install';
  const fromStdout = receiptFromStdout(opts.stdout, opts.forgeId, operation);
  if (fromStdout) return { doc: fromStdout, ref: 'stdout' };
  const sinceSec = (opts.sinceMs ?? 0) / 1000 - 1.0;
  let newest: { mtime: number; doc: Record<string, unknown>; ref: string } | null = null;
  for (const root of opts.roots) {
    for (const dir of childReceiptDirs(root)) {
      let files: string[] = [];
      try {
        files = readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .sort();
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = path.join(dir, file);
        let mtime = 0;
        try {
          mtime = statSync(filePath).mtimeMs / 1000;
        } catch {
          continue;
        }
        if (mtime < sinceSec) continue;
        let doc: unknown = null;
        try {
          doc = JSON.parse(readFileSync(filePath, 'utf8'));
        } catch {
          continue;
        }
        if (!isValidChildReceipt(doc, opts.forgeId, operation)) continue;
        if (!newest || mtime > newest.mtime) newest = { mtime, doc, ref: filePath };
      }
    }
  }
  return newest ? { doc: newest.doc, ref: newest.ref } : null;
}

/**
 * rc + receipt → veredito honesto (espelha `_delegation_verdict`):
 * `applied` exige receipt com `status: completed` + `verification: PASS`.
 */
export function delegationVerdict(
  exitCode: number,
  receipt: ChildReceipt | null,
): DelegationVerdict {
  if (exitCode !== 0) return 'failed';
  if (receipt === null) return 'unverified';
  const status = String(receipt.doc.status ?? '');
  const verification = String(
    (receipt.doc.verification as Record<string, unknown> | undefined)?.status ?? '',
  );
  if (status === 'completed' && verification === 'PASS') return 'applied';
  if (status === 'completed' || status === 'planned') return 'unverified';
  return 'failed';
}
