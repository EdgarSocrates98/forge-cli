// Capability negotiation over forge/ForgeCapability/v1 documents.
// Returns an explainable result: every requested capability is answered with
// an explicit status + reason — 'declared' never flattens into 'integrated'.

export type CapabilityState = 'supported' | 'unverified' | 'unsupported' | 'not_applicable';

export interface Capability {
  id: string;
  state: CapabilityState;
  requires?: string[];
  detail?: string | null;
  evidence?: string | null;
}

export type NegotiationStatus = 'granted' | 'granted_unverified' | 'refused' | 'unknown';

export interface NegotiationAnswer {
  capability: string;
  status: NegotiationStatus;
  reason: string;
}

export interface NegotiationResult {
  ok: boolean;
  complete: boolean; // false when anything is unverified
  answers: NegotiationAnswer[];
}

export function negotiateCapabilities(
  requested: readonly string[],
  offered: readonly Capability[],
): NegotiationResult {
  const byId = new Map(offered.map((c) => [c.id, c]));
  const answers: NegotiationAnswer[] = [];
  for (const id of requested) {
    const cap = byId.get(id);
    if (!cap) {
      answers.push({ capability: id, status: 'unknown', reason: 'not offered by this forge' });
      continue;
    }
    switch (cap.state) {
      case 'supported':
        answers.push({ capability: id, status: 'granted', reason: 'declared supported' });
        break;
      case 'unverified':
        answers.push({
          capability: id,
          status: 'granted_unverified',
          reason: cap.detail ?? 'offered but not verified — treat as provisional',
        });
        break;
      case 'not_applicable':
        answers.push({ capability: id, status: 'refused', reason: 'not applicable to this forge' });
        break;
      default:
        answers.push({
          capability: id,
          status: 'refused',
          reason: cap.detail ?? 'declared unsupported',
        });
    }
  }
  const ok = answers.every((a) => a.status === 'granted' || a.status === 'granted_unverified');
  const complete = answers.every((a) => a.status === 'granted');
  return { ok, complete, answers };
}

// ---------------------------------------------------------------------------
// Discovery precedence (contracts/CONTRACTS.md §Discovery, spec §1.3)
//
// Precedence (highest wins): verified local manifests (forge.json /
// installation registry) > existing Forja discovery services > trusted local
// catalog/cache > optional remote registry > explicit fallback (nothing
// discovered). Each level produces a DiscoveryState — the seven states are
// never flattened: a 'declared' capability must never render as 'integrated'.

export type DiscoveryState =
  | 'integrated' // verified running integration (host/MCP handshake proven)
  | 'validated' // integration present and re-checked against evidence
  | 'configured' // config applied (env/registry consistent)
  | 'declared' // Forja declares itself (manifest/descriptor present)
  | 'detected' // filesystem evidence only (checkout/install found)
  | 'degraded' // was working, evidence now failing
  | 'unknown'; // could not check / no evidence

export type DiscoveryOrigin =
  | 'manifest' // verified local manifest (forge.json, ~/.forge/installations)
  | 'forja-discovery' // Forja's own discovery service
  | 'catalog' // trusted local catalog/cache (repos.ts, cached scans)
  | 'remote-registry' // optional remote registry
  | 'fallback'; // explicit fallback — nothing discovered

export interface DiscoverySource {
  origin: DiscoveryOrigin;
  state: DiscoveryState;
  forge_id: string;
  evidence?: string;
}

const PRECEDENCE: readonly DiscoveryOrigin[] = [
  'manifest',
  'forja-discovery',
  'catalog',
  'remote-registry',
  'fallback',
];

export function resolveDiscovery(sources: readonly DiscoverySource[]): DiscoverySource | null {
  for (const origin of PRECEDENCE) {
    const hit = sources.find((s) => s.origin === origin);
    if (hit) return hit;
  }
  return null;
}
