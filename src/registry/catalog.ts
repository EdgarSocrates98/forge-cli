/**
 * Catálogo registry-first: mapeia cada Forja publicada à sua dist no PyPI.
 * `minPython` é o piso declarado (fallback offline); o `requires_python`
 * real do release — consultado no PyPI — é a fonte autoritativa.
 */

export interface RegistryEntry {
  /** Nome do repo/Forja (igual ao catálogo git). */
  name: string;
  /** Distribuição no PyPI (não é o import name nem o binário). */
  dist: string;
  /** Console script publicado pela dist — usado no verify pós-install. */
  bin: string;
  /** Piso documentado de Python — usado só quando o PyPI está inalcançável. */
  minPython: string;
  /** Classe de origem para a política de confiança. */
  origin: 'official';
}

export const REGISTRY_PACKAGES: RegistryEntry[] = [
  {
    name: 'the-forge',
    dist: 'theforge-core',
    bin: 'theforge',
    minPython: '3.11',
    origin: 'official',
  },
  {
    name: 'api-forge',
    dist: 'apiforge-af',
    bin: 'apiforge',
    minPython: '3.10',
    origin: 'official',
  },
  {
    name: 'platform-forge',
    dist: 'platformforge',
    bin: 'platformforge',
    minPython: '3.10',
    origin: 'official',
  },
  {
    name: 'spark-forge-aws',
    dist: 'sparkforge-aws',
    bin: 'sparkforge-aws',
    minPython: '3.10',
    origin: 'official',
  },
  {
    name: 'spark-forge-azure',
    dist: 'sparkforge-azure',
    bin: 'sparkforge-azure',
    minPython: '3.10',
    origin: 'official',
  },
  {
    name: 'forge-doctor-data',
    dist: 'forge-doctor-data',
    bin: 'forge-doctor-data',
    minPython: '3.10',
    origin: 'official',
  },
  {
    name: 'forge-doctor-api',
    dist: 'forge-doctor-api',
    bin: 'forge-doctor-api',
    minPython: '3.10',
    origin: 'official',
  },
];

const BY_NAME = new Map(REGISTRY_PACKAGES.map((e) => [e.name, e]));
const BY_DIST = new Map(REGISTRY_PACKAGES.map((e) => [e.dist, e]));

/** Aceita tanto o nome da Forja (`api-forge`) quanto o da dist (`apiforge-af`). */
export function registryEntry(nameOrDist: string): RegistryEntry | null {
  return BY_NAME.get(nameOrDist) ?? BY_DIST.get(nameOrDist) ?? null;
}

export function registryNames(): string[] {
  return REGISTRY_PACKAGES.map((e) => e.name);
}
