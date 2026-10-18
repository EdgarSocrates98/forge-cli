import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function isSafeRepoName(name: unknown): name is string {
  return typeof name === 'string' && REPO_NAME.test(name) && !name.includes('..');
}

/** Aceita apenas https://, ssh:// e scp-like (git@host:path); sem credenciais embutidas. */
export function isSafeRepoUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url || url !== url.trim() || url.startsWith('-')) return false;
  if (/\s/.test(url)) return false;
  if (/^https:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return !parsed.username && !parsed.password && parsed.hostname.length > 0;
    } catch {
      return false;
    }
  }
  if (/^ssh:\/\/[^/@\s]+@?[^/\s]+\/\S+$/i.test(url)) return true;
  return /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(url);
}

/** Resolve `name` dentro de `base`; retorna null se escapar do diretório base. */
export function resolveInside(base: string, name: string): string | null {
  if (!isSafeRepoName(name)) return null;
  const root = path.resolve(base);
  const target = path.resolve(root, name);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

/** Symlinks e junctions do Windows são reportados como symbolic link por lstat. */
export function isLinkOrJunction(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

const REDACTIONS: [RegExp, string][] = [
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '***'],
  [/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1***@'],
  [/\b(authorization|proxy-authorization)\s*[:=]\s*(bearer|basic|token)?\s*\S+/gi, '$1: ***'],
  [
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/gi,
    '$1=***',
  ],
];

export function redactSecrets(text: string): string {
  return REDACTIONS.reduce((acc, [re, repl]) => acc.replace(re, repl), text);
}

/**
 * Escrita atômica: grava em arquivo temporário, fsync e renomeia sobre o
 * destino. Um SIGKILL entre o open e o rename deixa um `*.tmp` órfão —
 * o rename nunca publica conteúdo parcial, e a próxima escrita
 * bem-sucedida no mesmo destino remove os órfãos de runs anteriores.
 */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    for (const f of readdirSync(dir)) {
      if (f.startsWith(`${base}.`) && f.endsWith('.tmp')) {
        rmSync(path.join(dir, f), { force: true });
      }
    }
  } catch {
    // limpeza de órfãos é melhor esforço — nunca derruba a escrita
  }
}
