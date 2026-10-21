/**
 * Integrações opcionais entre Forjas (lf-0031, PHASE 12).
 *
 * A tabela `OPTIONAL_INTEGRATIONS` é DECLARADA pelo mantenedor — deriva do
 * grafo de composição dos knowledge packs (composes_with ∪
 * preferred_verifiers ∪ fallback), nunca inferida de nomes. Cada aresta é
 * opcional por construção: nenhuma Forja ganha dependência obrigatória de
 * uma irmã, e instalar uma integração exige consentimento explícito —
 * este módulo só classifica e propõe, nunca instala sozinho.
 *
 * Estados (detecção por evidência, superfícies gerenciadas apenas):
 * - `verified`  — receipt registry/local com `verify.ok` (saúde executável provada)
 * - `installed` — receipt presente sem prova de verify, ou binário no PATH
 * - `degraded`  — receipt presente mas verify falhou / fonte local ausente
 * - `checkout`  — diretório com `.git` no workspace, sem receipt gerenciado
 * - `absent`    — nada detectado (opcional: nunca falha, sempre recomendação)
 */

import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { loadForgeState } from './registry/install.js';
import { resolveInside } from './safety.js';
import { hasGitRepo } from './utils/system.js';

export interface OptionalIntegration {
  /** Nome da Forja irmã (id do catálogo — ou gap nomeado e documentado). */
  name: string;
  /** Por que ela compõe — razão declarada, evidência mantenedora. */
  reason: string;
  /** Adapter the-forge existe (delegation-adapter-health); false = gap não-adaptado documentado. */
  adapter: boolean;
  /** Instalável pelo caminho registry (PyPI); false = sem rota de install hoje. */
  installable: boolean;
}

export const OPTIONAL_INTEGRATIONS: Readonly<Record<string, readonly OptionalIntegration[]>> = {
  'the-forge': [
    {
      name: 'spark-forge-aws',
      reason: 'análise estática/runtime PySpark — delegate do orquestrador',
      adapter: true,
      installable: true,
    },
    {
      name: 'spark-forge-azure',
      reason: 'análise PySpark em Azure — delegate do orquestrador',
      adapter: true,
      installable: true,
    },
    {
      name: 'api-forge',
      reason: 'construção/contratos de API — delegate do orquestrador',
      adapter: true,
      installable: true,
    },
    {
      name: 'platform-forge',
      reason: 'postura de plataforma — delegate do orquestrador',
      adapter: true,
      installable: true,
    },
    {
      name: 'forge-doctor-data',
      reason: 'verificação independente de dados — delegate do orquestrador',
      adapter: true,
      installable: true,
    },
    {
      name: 'forge-doctor-api',
      reason: 'verificação independente de API — delegate do orquestrador',
      adapter: true,
      installable: true,
    },
    {
      name: 'data-sentinel-forge',
      reason:
        'diagnóstico de runtime (logs/plans) — sem adapter the-forge e sem rota de install: gap documentado, nunca obrigatório',
      adapter: false,
      installable: false,
    },
  ],
  'spark-forge-aws': [
    {
      name: 'forge-doctor-data',
      reason: 'verificador independente das análises produzidas',
      adapter: true,
      installable: true,
    },
    {
      name: 'platform-forge',
      reason: 'estado da plataforma onde o job roda',
      adapter: true,
      installable: true,
    },
    {
      name: 'spark-forge-azure',
      reason: 'fallback declarado (mesma família spark)',
      adapter: true,
      installable: true,
    },
    {
      name: 'api-forge',
      reason: 'contratos de API adjacentes ao pipeline',
      adapter: true,
      installable: true,
    },
    {
      name: 'data-sentinel-forge',
      reason:
        'diagnóstico de runtime — sem adapter e sem rota de install: gap documentado, nunca obrigatório',
      adapter: false,
      installable: false,
    },
  ],
  'spark-forge-azure': [
    {
      name: 'forge-doctor-data',
      reason: 'verificador independente das análises produzidas',
      adapter: true,
      installable: true,
    },
    {
      name: 'platform-forge',
      reason: 'estado da plataforma onde o job roda',
      adapter: true,
      installable: true,
    },
    {
      name: 'spark-forge-aws',
      reason: 'fallback declarado (mesma família spark)',
      adapter: true,
      installable: true,
    },
    {
      name: 'data-sentinel-forge',
      reason:
        'diagnóstico de runtime — sem adapter e sem rota de install: gap documentado, nunca obrigatório',
      adapter: false,
      installable: false,
    },
  ],
  'api-forge': [
    {
      name: 'forge-doctor-api',
      reason: 'verificador independente (producer≠verifier)',
      adapter: true,
      installable: true,
    },
    {
      name: 'platform-forge',
      reason: 'governança/estado da plataforma consumidora',
      adapter: true,
      installable: true,
    },
  ],
  'platform-forge': [
    {
      name: 'api-forge',
      reason: 'compõe governança de APIs da plataforma',
      adapter: true,
      installable: true,
    },
    {
      name: 'forge-doctor-data',
      reason: 'verificador independente declarado',
      adapter: true,
      installable: true,
    },
  ],
  'forge-doctor-api': [
    {
      name: 'api-forge',
      reason: 'produtor dos artefatos que ele verifica',
      adapter: true,
      installable: true,
    },
    {
      name: 'forge-doctor-data',
      reason: 'fallback declarado entre verificadores',
      adapter: true,
      installable: true,
    },
  ],
  'forge-doctor-data': [
    {
      name: 'spark-forge-aws',
      reason: 'produtor das análises que ele verifica',
      adapter: true,
      installable: true,
    },
    {
      name: 'spark-forge-azure',
      reason: 'produtor das análises que ele verifica',
      adapter: true,
      installable: true,
    },
    {
      name: 'platform-forge',
      reason: 'estado da plataforma verificada',
      adapter: true,
      installable: true,
    },
    {
      name: 'forge-doctor-api',
      reason: 'fallback declarado entre verificadores',
      adapter: true,
      installable: true,
    },
    {
      name: 'data-sentinel-forge',
      reason:
        'importa doctor-bundles para diagnóstico de runtime — sem adapter e sem rota de install: gap documentado',
      adapter: false,
      installable: false,
    },
  ],
  'forge-portal': [
    {
      name: 'the-forge',
      reason: 'control plane que o portal renderiza',
      adapter: true,
      installable: true,
    },
  ],
  'data-sentinel-forge': [
    {
      name: 'forge-doctor-data',
      reason: 'consome doctor-bundles para diagnóstico independente',
      adapter: true,
      installable: true,
    },
    {
      name: 'spark-forge-aws',
      reason: 'fonte de evidência Spark para diagnóstico',
      adapter: true,
      installable: true,
    },
    {
      name: 'spark-forge-azure',
      reason: 'fonte de evidência Spark para diagnóstico',
      adapter: true,
      installable: true,
    },
  ],
};

export type IntegrationState = 'verified' | 'installed' | 'degraded' | 'checkout' | 'absent';

export interface IntegrationStatus {
  integration: OptionalIntegration;
  state: IntegrationState;
  evidence: string[];
}

export interface IntegrationDeps {
  /** Workspace root — checkouts são `<root>/<name>` com `.git`. */
  root: string;
  /** Home dir do state registry (`~/.forge-cli/forges/state.json`). */
  home: string;
  /**
   * Sonda PATH injetável (`command -v <bin>` → path ou null). Sem ela a
   * detecção cobre só receipts + checkouts — instalações não-gerenciadas
   * reportam 'absent' com evidência honesta, nunca falsa presença.
   */
  which?: (bin: string) => string | null | Promise<string | null>;
  /** Binário a sondar quando não há receipt (`verify[0]` do catálogo). */
  bin?: (name: string) => string | undefined;
}

/** Integrações declaradas de uma Forja (consumidora) — vazio fora da tabela. */
export function integrationsOf(forge: string): readonly OptionalIntegration[] {
  return OPTIONAL_INTEGRATIONS[forge] ?? [];
}

/**
 * Detecção local (spawn-free): receipt registry/local → checkout no
 * workspace → ausente. Não sonda PATH — usada pelo doctor (diagnóstico
 * síncrono, zero subprocessos).
 */
function detectLocal(
  integration: OptionalIntegration,
  deps: Pick<IntegrationDeps, 'root' | 'home'>,
): IntegrationStatus {
  const { name } = integration;
  const evidence: string[] = [];
  const receipt = loadForgeState(deps.home).forges[name];
  if (receipt) {
    evidence.push(`receipt=${receipt.method}@${receipt.venv ?? receipt.bin ?? '?'}`);
    if (receipt.version) evidence.push(`version=${receipt.version}`);
    const localMissing =
      receipt.method === 'local' &&
      (typeof receipt.source_dir !== 'string' || !existsSync(receipt.source_dir));
    if (localMissing) {
      evidence.push(`source_dir=${receipt.source_dir ?? '?'} (AUSENTE)`);
      return { integration, state: 'degraded', evidence };
    }
    if (receipt.verify?.ok === false) {
      evidence.push(`verify=${receipt.verify.command.join(' ') || '?'} falhou`);
      return { integration, state: 'degraded', evidence };
    }
    evidence.push(`verify=${receipt.verify?.ok ? 'ok' : 'não executado'}`);
    return { integration, state: receipt.verify?.ok ? 'verified' : 'installed', evidence };
  }
  const dir = resolveInside(deps.root, name);
  if (dir && existsSync(dir)) {
    evidence.push(`checkout=${dir}${hasGitRepo(dir) ? ' (git)' : ' (sem .git)'}`);
    return { integration, state: 'checkout', evidence };
  }
  evidence.push('sem receipt, checkout ou binário gerenciado detectado');
  return { integration, state: 'absent', evidence };
}

async function detect(
  integration: OptionalIntegration,
  deps: IntegrationDeps,
): Promise<IntegrationStatus> {
  const local = detectLocal(integration, deps);
  if (local.state !== 'absent' || !deps.which) return local;
  const bin = deps.bin?.(integration.name);
  if (!bin) return local;
  const found = await deps.which(bin);
  if (!found) return local;
  return {
    integration,
    state: 'installed',
    evidence: [`bin=${found} (PATH, não-gerenciado)`],
  };
}

/** Classifica todas as integrações declaradas de uma Forja. */
export async function classifyIntegrations(
  forge: string,
  deps: IntegrationDeps,
): Promise<IntegrationStatus[]> {
  const out: IntegrationStatus[] = [];
  for (const integration of integrationsOf(forge)) {
    out.push(await detect(integration, deps));
  }
  return out;
}

/**
 * Variante síncrona e spawn-free — a superfície do doctor: receipts +
 * checkouts apenas. Instalações não-gerenciadas (só PATH) reportam
 * 'absent' com evidência honesta — nunca presença fabricada.
 */
export function classifyIntegrationsSync(
  forge: string,
  deps: Pick<IntegrationDeps, 'root' | 'home'>,
): IntegrationStatus[] {
  return integrationsOf(forge).map((i) => detectLocal(i, deps));
}

/** Integrações ainda não presentes de forma saudável — candidatas da oferta. */
export function pendingIntegrations(
  statuses: readonly IntegrationStatus[],
): readonly IntegrationStatus[] {
  return statuses.filter((s) => s.state === 'absent' || s.state === 'checkout');
}

/** Nomes instaláveis pelo método registry (PyPI) — os demais são nota honesta. */
export function installableNames(statuses: readonly IntegrationStatus[]): string[] {
  return statuses.filter((s) => s.integration.installable).map((s) => s.integration.name);
}

/** `command -v`/`where` real — a sonda PATH default dos fluxos de install. */
export async function defaultWhich(bin: string): Promise<string | null> {
  const isWin = process.platform === 'win32';
  try {
    const res = await execa(isWin ? 'where' : 'sh', isWin ? [bin] : ['-c', `command -v ${bin}`], {
      reject: false,
    });
    const first = (res.stdout ?? '').split('\n')[0]?.trim();
    return res.exitCode === 0 && first ? first : null;
  } catch {
    return null;
  }
}

export interface IntegrationOffer {
  /** Integrações exibidas ao usuário (pendentes — nada já saudável). */
  offered: readonly IntegrationStatus[];
  /** Nomes explicitamente consentidos (checkbox marcado). */
  consented: string[];
  /** Consentidos instaláveis pelo método atual. */
  installable: string[];
  /** Consentidos sem rota de instalação — nota honesta, nunca falha. */
  notInstallable: string[];
}

/**
 * A oferta de integrações pós-install — checkbox-style, consentimento
 * explícito, nada pré-marcado. O prompt é injetável: em modo
 * não-interativo/`--yes`/`--json` ninguém chama isto — o chamador mostra
 * a nota informativa e segue (consentimento nunca é presumido).
 */
export async function askOptionalIntegrations(
  statuses: readonly IntegrationStatus[],
  ask: (options: { value: string; label: string; hint?: string }[]) => Promise<string[] | null>,
): Promise<IntegrationOffer> {
  const pending = pendingIntegrations(statuses);
  const chosen =
    (await ask(
      pending.map((s) => ({
        value: s.integration.name,
        label: s.integration.name,
        hint: s.integration.reason,
      })),
    )) ?? [];
  const installable = new Set(installableNames(pending));
  return {
    offered: pending,
    consented: chosen,
    installable: chosen.filter((n) => installable.has(n)),
    notInstallable: chosen.filter((n) => !installable.has(n)),
  };
}
