import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORGE_REPOS } from '../src/constants/repos.js';
import type { NativeFlag } from '../src/types.js';

/**
 * Drift-guard catálogo ↔ manifesto (P1-5 wave-14): quando o `forge.json`
 * do irmão existe ao lado do checkout (`../<name>/forge.json`), as flags
 * nativas do catálogo estático DEVEM ser exatamente as flags que o
 * manifesto declara no vocabulário que o CLI conhece — nem mais (flag
 * fantasma repassada), nem menos (superfície real escondida).
 *
 * Flags fora do vocabulário (`--yes`, `--dry-run`, `--json`, `--no-input`,
 * `--workspace`, `--runtime-profile`, `--gateway`, `--init-app`,
 * `--with-bridge`, `--data-dir`, `--file`, `--source`, `--member`,
 * `--forge`) são de protocolo/comando, não de superfície declarável.
 */
const VOCAB = new Set<NativeFlag>([
  'scope',
  'profile',
  'components',
  'host',
  'gateway-profile',
  'root',
  'to',
  'repo',
  'purge',
]);

const WORKSPACE = path.resolve(process.cwd(), '..');

interface SiblingManifest {
  forge_id?: string;
  install?: { flags?: unknown; operations?: unknown };
}

function siblingManifest(name: string): SiblingManifest | null {
  const file = path.join(WORKSPACE, name, 'forge.json');
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as SiblingManifest) : null;
  } catch {
    return null;
  }
}

function declaredFlags(manifest: SiblingManifest): Set<string> {
  const raw = manifest.install?.flags;
  if (!Array.isArray(raw)) return new Set();
  return new Set(
    raw
      .filter((f): f is string => typeof f === 'string')
      .map((f) => f.replace(/^--/, '').replace(/_/g, '-')),
  );
}

const present = FORGE_REPOS.filter(
  (r) => r.nativeInstall && existsSync(path.join(WORKSPACE, r.name, 'forge.json')),
);

describe('drift-guard: catálogo ↔ forge.json do irmão (P1-5)', () => {
  it('contexto: rodando ao lado dos checkouts, cobre as Forjas presentes', () => {
    // Informativo: lista o que o guard cobre NESTE ambiente. Em CI sem
    // irmãos, `present` é vazio e os asserts por-Forja não rodam.
    expect(present.length).toBeGreaterThanOrEqual(0);
    if (present.length) {
      // eslint-disable-next-line no-console
      console.log(`drift-guard cobrindo: ${present.map((r) => r.name).join(', ')}`);
    }
  });

  it('flags do catálogo == flags declaradas ∩ vocabulário, por Forja', () => {
    const drift: string[] = [];
    for (const repo of FORGE_REPOS.filter((r) => r.nativeInstall)) {
      const manifest = siblingManifest(repo.name);
      if (!manifest) continue;
      const declared = new Set([...declaredFlags(manifest)].filter((f) => VOCAB.has(f as NativeFlag)));
      const catalog = new Set(repo.nativeInstall!.flags);
      const missing = [...declared].filter((f) => !catalog.has(f as NativeFlag));
      const phantom = [...catalog].filter((f) => !declared.has(f));
      if (missing.length || phantom.length) {
        drift.push(
          `${repo.name}: faltam no catálogo=[${missing.join(',')}] fantasmas=[${phantom.join(',')}]`,
        );
      }
    }
    expect(drift, drift.join('\n')).toEqual([]);
  });

  it('flags do catálogo são sempre subconjunto do vocabulário', () => {
    for (const repo of FORGE_REPOS.filter((r) => r.nativeInstall)) {
      for (const flag of repo.nativeInstall!.flags) {
        expect(VOCAB.has(flag), `${repo.name} declara flag desconhecida: ${flag}`).toBe(true);
      }
    }
  });

  it('os dois achados da auditoria ficaram resolvidos', () => {
    // forge-doctor-data declara --host no manifesto — o catálogo tinha esquecido.
    expect(
      FORGE_REPOS.find((r) => r.name === 'forge-doctor-data')?.nativeInstall?.flags,
    ).toContain('host');
    // data-sentinel-forge declara --gateway-profile — idem.
    expect(
      FORGE_REPOS.find((r) => r.name === 'data-sentinel-forge')?.nativeInstall?.flags,
    ).toContain('gateway-profile');
    // forge-doctor-api TEM instalador nativo (script do repositório).
    expect(
      FORGE_REPOS.find((r) => r.name === 'forge-doctor-api')?.nativeInstall?.command[0],
    ).toBe('{python}');
  });
});
