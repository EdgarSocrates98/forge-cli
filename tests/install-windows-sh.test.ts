/**
 * lf-0018 — `install.windows.sh` (rota Windows Git Bash) carregado no root
 * do forge-cli e vendido byte-para-byte nos repositórios forge.
 *
 * Garantias do artefato: sintaxe válida para bash (`bash -n`), finais de
 * linha LF (um checkout com core.autocrlf=true é o risco documentado no
 * cabeçalho do script), zero spawn de powershell.exe/pwsh (PowerShell não
 * é fallback desta rota — recusa FORGE-SHELL-UNAVAILABLE) e os códigos
 * FORGE-* do contrato compartilhado presentes no texto.
 *
 * A seleção de rota (git bash → install.windows.sh) e a paridade de
 * campos do receipt vs install.sh vivem em env-discover.test.ts e na
 * suíte installkit do the-forge, respectivamente.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'install.windows.sh');

function hasCmd(cmd: string): boolean {
  try {
    execFileSync(cmd, ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('install.windows.sh — artefato do lf-0018', () => {
  const src = readFileSync(SCRIPT, 'utf8');

  it('shebang bash + bit executável', () => {
    expect(src.startsWith('#!/usr/bin/env bash')).toBe(true);
    // Bits de modo POSIX não existem no fs do Windows (statSync devolve
    // o mode sintetizado dos atributos do arquivo — 0o111 sai 0 para um
    // .sh). O bit executável é mecânica POSIX: verificado onde existe;
    // shebang e finais LF seguem valendo em qualquer host.
    if (process.platform !== 'win32') {
      // modo 0755 preservado (POSIX; no Windows o bit é irrelevante para bash)
      expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
    }
  });

  it('finais LF apenas — tolerância CRLF documentada no cabeçalho', () => {
    expect(src).not.toContain('\r\n');
    expect(src).toContain('core.autocrlf');
    expect(src).toContain("sed -i 's/\\r$//'");
  });

  it('nunca invoca powershell/pwsh — FORGE-SHELL-UNAVAILABLE fora do bash', () => {
    // comentários e mensagens podem NOMEAR powershell.exe/pwsh (a recusa
    // aponta install.ps1 como alternativa); o que não pode é INVOCAR.
    const executable = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#') && !l.trimStart().startsWith('echo'))
      .join('\n')
      .toLowerCase();
    expect(executable).not.toMatch(/powershell|pwsh/);
    expect(src).toContain('FORGE-SHELL-UNAVAILABLE');
    expect(src).toContain('BASH_VERSION');
  });

  it('detecta a família MSYS (Git Bash/MSYS2/Cygwin) pelo MSYSTEM/OSTYPE', () => {
    expect(src).toContain('MSYSTEM');
    expect(src).toMatch(/MSYS.*MINGW.*UCRT.*CYGWIN/s);
  });

  it('delega ao bootstrap compartilhado com --persist-env --allow-download', () => {
    expect(src).toContain('scripts/forge_bootstrap.py');
    expect(src).toContain('--persist-env');
    expect(src).toContain('--allow-download');
  });

  it('prioridade de interpretador do lf-0017: --python, FORGE_PYTHON, PATH', () => {
    expect(src).toContain('--python');
    expect(src).toContain('FORGE_PYTHON');
    expect(src).toMatch(/python3.*python.*py/s);
  });

  it('códigos FORGE-* do contrato compartilhado presentes', () => {
    for (const code of [
      'FORGE-SHELL-UNAVAILABLE',
      'FORGE-PYTHON-NOT-FOUND',
      'FORGE-PYTHON-UNEXECUTABLE',
      'FORGE-INSTALL-BOOTSTRAP-FAILED',
    ]) {
      expect(src).toContain(code);
    }
    // o kind do bootstrap é surfacado verbatim do receipt JSON
    expect(src).toContain('"kind"');
  });

  it('bash -n aceita o script', (ctx) => {
    if (!hasCmd('bash')) {
      ctx.skip();
      return;
    }
    expect(() => execFileSync('bash', ['-n', SCRIPT], { stdio: 'pipe' })).not.toThrow();
  });

  // No Windows este caso não é alcançável: o dash que vem no usr/bin do
  // Git for Windows é um binário MSYS — `env -i` apaga o PATH (env não
  // resolve mais o dash) e o path win32 do script chega sem tradução
  // POSIX ("can't open" → 127, nunca o guard-rail). A rota MSYS já é
  // coberta pelo teste de MSYSTEM/OSTYPE acima; aqui o alvo é só o
  // interpretador não-bash POSIX, então o teste é POSIX-only de verdade.
  it.skipIf(process.platform === 'win32')(
    'fora do bash (dash interpretando) → FORGE-SHELL-UNAVAILABLE',
    (ctx) => {
      // o shebang `#!/usr/bin/env bash` faz `sh script` cair em bash de
      // novo — a guarda só é exercitada quando um interpretador não-bash
      // lê o arquivo diretamente (dash cobre o caso "shell errada").
      if (!hasCmd('dash')) {
        ctx.skip();
        return;
      }
      try {
        execFileSync('env', ['-i', 'dash', SCRIPT], { stdio: 'pipe' });
        expect.unreachable('o script deveria recusar fora do bash');
      } catch (err) {
        const e = err as { status?: number; stderr?: Buffer };
        expect(e.status).toBe(2);
        expect(String(e.stderr)).toContain('FORGE-SHELL-UNAVAILABLE');
      }
    },
  );
});
