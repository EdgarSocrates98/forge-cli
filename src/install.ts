import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

export interface InstallOptions {
  platform?: NodeJS.Platform;
  homedir?: string;
  bundlePath?: string;
}

export interface InstallReport {
  dir: string;
  shims: string[];
  profilesTouched: string[];
  pathAlready: boolean;
}

export interface UninstallReport {
  dirRemoved: boolean;
  shimsRemoved: boolean;
  profilesTouched: string[];
  pathRemoved: boolean;
}

export const GUARD_START = '# >>> forge-cli >>>';
export const GUARD_END = '# <<< forge-cli <<<';

export function installDir(home: string): string {
  return path.join(home, '.forge-cli', 'bin');
}

export const BUNDLE_NAME = 'index.mjs';

export function windowsShim(): string {
  return '@echo off\r\nnode "%USERPROFILE%\\.forge-cli\\bin\\index.mjs" %*\r\n';
}

export function posixShim(): string {
  return '#!/bin/sh\nexec node "$HOME/.forge-cli/bin/index.mjs" "$@"\n';
}

export function guardBlock(): string {
  return `${GUARD_START}\nexport PATH="$HOME/.forge-cli/bin:$PATH"\n${GUARD_END}\n`;
}

export function fishBlock(): string {
  return `${GUARD_START}\nset -gx PATH "$HOME/.forge-cli/bin" $PATH\n${GUARD_END}\n`;
}

export function profileCandidates(home: string): { file: string; block: string }[] {
  const shBlock = guardBlock();
  return [
    { file: path.join(home, '.bashrc'), block: shBlock },
    { file: path.join(home, '.zshrc'), block: shBlock },
    { file: path.join(home, '.profile'), block: shBlock },
    { file: path.join(home, '.config', 'fish', 'config.fish'), block: fishBlock() },
  ];
}

function stripBlock(content: string): string {
  const start = content.indexOf(GUARD_START);
  if (start === -1) return content;
  const end = content.indexOf(GUARD_END, start);
  if (end === -1) return content;
  return (content.slice(0, start) + content.slice(end + GUARD_END.length)).replace(
    /\n{3,}/g,
    '\n\n',
  );
}

function normalizeDir(dir: string): string {
  return dir.replace(/[\\/]+$/, '').toLowerCase();
}

async function psRun(script: string): Promise<string | null> {
  try {
    const result = await execa('powershell.exe', ['-NoProfile', '-Command', script], {
      reject: false,
    });
    return result.exitCode === 0 ? (result.stdout ?? '') : null;
  } catch {
    return null;
  }
}

export async function addToWindowsPath(dir: string): Promise<boolean> {
  const current = await psRun("[Environment]::GetEnvironmentVariable('Path','User')");
  if (current === null) return false;
  const parts = current.split(';').filter((p) => p.trim());
  if (parts.some((p) => normalizeDir(p) === normalizeDir(dir))) return true;
  const next = [...parts, dir].join(';').replace(/'/g, "''");
  const wrote = await psRun(`[Environment]::SetEnvironmentVariable('Path','${next}','User')`);
  return wrote !== null;
}

export async function removeFromWindowsPath(dir: string): Promise<boolean> {
  const current = await psRun("[Environment]::GetEnvironmentVariable('Path','User')");
  if (current === null) return false;
  const parts = current.split(';').filter((p) => p.trim());
  const kept = parts.filter((p) => normalizeDir(p) !== normalizeDir(dir));
  if (kept.length === parts.length) return true;
  const next = kept.join(';').replace(/'/g, "''");
  const wrote = await psRun(`[Environment]::SetEnvironmentVariable('Path','${next}','User')`);
  return wrote !== null;
}

export async function install(opts: InstallOptions = {}): Promise<InstallReport> {
  const platform = opts.platform ?? process.platform;
  const home = opts.homedir ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  const dir = installDir(home);
  const bundle = opts.bundlePath ?? fileURLToPath(import.meta.url);
  mkdirSync(dir, { recursive: true });
  copyFileSync(bundle, path.join(dir, BUNDLE_NAME));

  const shims: string[] = [];
  const profilesTouched: string[] = [];
  let pathAlready = false;

  if (platform === 'win32') {
    const shim = path.join(dir, 'forge-cli.cmd');
    writeFileSync(shim, windowsShim(), 'utf8');
    shims.push(shim);
    const current = await psRun("[Environment]::GetEnvironmentVariable('Path','User')");
    pathAlready =
      current !== null &&
      current
        .split(';')
        .filter((p) => p.trim())
        .some((p) => normalizeDir(p) === normalizeDir(dir));
    if (!pathAlready) await addToWindowsPath(dir);
  } else {
    const shim = path.join(dir, 'forge-cli');
    writeFileSync(shim, posixShim(), 'utf8');
    chmodSync(shim, 0o755);
    shims.push(shim);
    const candidates = profileCandidates(home);
    const existing = candidates.filter((c) => existsSync(c.file));
    for (const c of existing) {
      const content = readFileSync(c.file, 'utf8');
      if (!content.includes(GUARD_START)) {
        writeFileSync(c.file, `${content.replace(/\n*$/, '\n')}\n${c.block}`, 'utf8');
        profilesTouched.push(c.file);
      }
    }
    if (!existing.length) {
      const fallback = candidates[2];
      mkdirSync(path.dirname(fallback.file), { recursive: true });
      writeFileSync(fallback.file, fallback.block, 'utf8');
      profilesTouched.push(fallback.file);
    }
  }
  return { dir, shims, profilesTouched, pathAlready };
}

export async function uninstall(opts: InstallOptions = {}): Promise<UninstallReport> {
  const platform = opts.platform ?? process.platform;
  const home = opts.homedir ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  const dir = installDir(home);
  const profilesTouched: string[] = [];
  let pathRemoved = false;

  if (platform === 'win32') {
    pathRemoved = await removeFromWindowsPath(dir);
  } else {
    for (const c of profileCandidates(home)) {
      if (!existsSync(c.file)) continue;
      const content = readFileSync(c.file, 'utf8');
      const stripped = stripBlock(content);
      if (stripped !== content) {
        writeFileSync(c.file, stripped, 'utf8');
        profilesTouched.push(c.file);
      }
    }
  }
  const dirRemoved = existsSync(dir);
  if (dirRemoved) rmSync(dir, { recursive: true, force: true });
  return { dirRemoved, shimsRemoved: dirRemoved, profilesTouched, pathRemoved };
}

export async function pathStatus(opts: InstallOptions = {}): Promise<'on-path' | 'missing'> {
  const platform = opts.platform ?? process.platform;
  try {
    const [cmd, args] =
      platform === 'win32'
        ? (['where', ['forge-cli']] as const)
        : (['sh', ['-c', 'command -v forge-cli']] as const);
    const result = await execa(cmd, [...args], { reject: false });
    return result.exitCode === 0 ? 'on-path' : 'missing';
  } catch {
    return 'missing';
  }
}
