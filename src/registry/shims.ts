/**
 * Launchers dos installs registry-first: shim por Forja em
 * `~/.forge-cli/bin/<cli>` (o dir já vai ao PATH pelo self-install do
 * forge-cli). POSIX emite shell script `exec`, Windows emite `.cmd` —
 * ambos apontando para o bin da venv da Forja. Nome fora do padrão
 * seguro recusa — o shim NUNCA escreve fora de `~/.forge-cli/bin`.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isSafeRepoName, resolveInside } from '../safety.js';

export function shimsDir(home: string): string {
  return path.join(home, '.forge-cli', 'bin');
}

/** Nome do shim = basename do bin (`venv/bin/<cli>` → `<cli>`). */
function shimName(bin: string, platform: NodeJS.Platform): string {
  const base = path.basename(bin).replace(/\.(exe|cmd|bat)$/i, '');
  return platform === 'win32' ? `${base}.cmd` : base;
}

/**
 * Emite o launcher do `bin` instalado. Retorna o caminho do shim; falha
 * de escrita lança — o chamador decide se degrada ou registra.
 */
export function emitForgeShim(home: string, bin: string, platform: NodeJS.Platform): string {
  const dir = shimsDir(home);
  const target = resolveInside(dir, shimName(bin, platform));
  if (!target || !isSafeRepoName(path.basename(target).replace(/\.cmd$/i, ''))) {
    throw new Error(`nome de shim inseguro: ${path.basename(bin)}`);
  }
  mkdirSync(dir, { recursive: true });
  if (platform === 'win32') {
    writeFileSync(target, `@echo off\r\n"${bin}" %*\r\n`, 'utf8');
  } else {
    writeFileSync(target, `#!/bin/sh\nexec "${bin}" "$@"\n`, { encoding: 'utf8', mode: 0o755 });
    chmodSync(target, 0o755);
  }
  return target;
}

/** Remove o shim da Forja (uninstall). Idempotente, recusa nome inseguro. */
export function removeForgeShim(
  home: string,
  bin: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (!bin) return false;
  const target = resolveInside(shimsDir(home), shimName(bin, platform));
  if (!target || !existsSync(target)) return false;
  rmSync(target, { force: true });
  return true;
}
