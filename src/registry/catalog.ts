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
  /**
   * Template do comando MCP da Forja (espelho do `mcp_command` do forge.json).
   * `{bin}` = bin principal da venv; `{binDir}/x` = script irmão na venv.
   */
  mcp?: string[];
  /**
   * Allowlist explícita de tools MCP seguras para `mcp --verify` chamar —
   * read-only e sem efeitos. Declarada pelo mantenedor, nunca inferida do
   * nome da tool. Ausente/vazia → verify para em TOOLS_DISCOVERED.
   */
  mcp_safe_tools?: string[];
  /**
   * Extras PEP 508 pedidos no install/lock/resolve (`dist[extra]`). Só
   * entram extras que existem no `[project.optional-dependencies]` da
   * dist — verificados no pyproject do sibling, nunca inferidos de `mcp`.
   * Receipt/state continuam com `dist` limpa (extras são do pedido, não
   * da identidade da distribuição).
   */
  extras?: string[];
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
    minPython: '3.12',
    mcp: ['{binDir}/apiforge-mcp'],
    // pyproject do sibling: mcp = ["mcp>=2.2,<3"]
    extras: ['mcp'],
    // Tools documentadas em src/apiforge/mcp (read-only).
    mcp_safe_tools: ['apiforge_tools', 'apiforge_discover'],
    origin: 'official',
  },
  {
    name: 'platform-forge',
    dist: 'platformforge',
    bin: 'platformforge',
    minPython: '3.10',
    mcp: ['{binDir}/platformforge-mcp'],
    // pyproject do sibling: mcp = ["mcp>=2.2,<3"]
    extras: ['mcp'],
    // Tools read-only em platformforge/mcp/registry.py.
    mcp_safe_tools: ['platformforge_inspect', 'platformforge_agents'],
    origin: 'official',
  },
  {
    name: 'spark-forge-aws',
    dist: 'sparkforge-aws',
    bin: 'sparkforge-aws',
    minPython: '3.10',
    mcp: ['{bin}', 'mcp', 'serve'],
    // pyproject do sibling: extra mcp (deps do servidor MCP)
    extras: ['mcp'],
    // Tools read-only em sparkforge_aws/adapters/tools.py.
    mcp_safe_tools: ['sparkforge_aws_pack_list', 'sparkforge_aws_rules_lookup'],
    origin: 'official',
  },
  {
    name: 'spark-forge-azure',
    dist: 'sparkforge-azure',
    bin: 'sparkforge-azure',
    minPython: '3.10',
    mcp: ['{bin}', 'mcp', 'serve'],
    // pyproject do sibling: mcp = ["mcp>=2,<3"]
    extras: ['mcp'],
    // read_only, zero params — docs/reference/mcp-tools.md.
    mcp_safe_tools: ['sfa_version', 'sfa_agents_list'],
    origin: 'official',
  },
  {
    name: 'forge-doctor-data',
    dist: 'forge-doctor-data',
    bin: 'forge-doctor-data',
    minPython: '3.11',
    mcp: ['{bin}', 'mcp'],
    // Read-only, all-args-optional — src/forge_doctor_data/integrations/mcp_server.py.
    mcp_safe_tools: ['get_host_status', 'get_portfolio_summary'],
    origin: 'official',
  },
  {
    name: 'forge-doctor-api',
    dist: 'forge-doctor-api',
    bin: 'forge-doctor-api',
    minPython: '3.11',
    mcp: ['{bin}', 'mcp'],
    // Zero-arg read-only lambdas — src/forge_doctor_api/handoff/mcp_server.py.
    mcp_safe_tools: ['doctor.get_capabilities', 'doctor.get_handoff'],
    // pyproject do sibling: mcp = ["mcp>=2.0,<3"]
    extras: ['mcp'],
    origin: 'official',
  },
  {
    name: 'data-sentinel-forge',
    dist: 'data-sentinel-forge',
    bin: 'data-sentinel',
    minPython: '3.11',
    mcp: ['{bin}', 'mcp', 'serve'],
    // pyproject do sibling: mcp = ["mcp>=1.9"]
    extras: ['mcp'],
    // Toda tool registrada é LOCAL_READ sem side_effects — o dispatcher
    // nunca escreve (src/data_sentinel/tools/registry.py). estimate_cost é
    // tabela estática sem I/O de arquivo.
    mcp_safe_tools: ['sentinel.emr.estimate_cost', 'sentinel.sql.analyze'],
    origin: 'official',
  },
  {
    name: 'api-sentinel-forge',
    dist: 'api-sentinel-forge',
    bin: 'api-sentinel',
    minPython: '3.11',
    mcp: ['{bin}', 'mcp', 'serve'],
    // pyproject do sibling: mcp = ["mcp>=1.9"]
    extras: ['mcp'],
    // Read-only, zero params — src/api_sentinel/mcp_server.py.
    mcp_safe_tools: ['sentinel_health', 'sentinel_list_services'],
    origin: 'official',
  },
  {
    name: 'forge-agent-bridge',
    dist: 'forge-agent-bridge',
    bin: 'forge-bridge',
    minPython: '3.11',
    mcp: ['{bin}', 'mcp', 'serve'],
    // Catálogo estático stdlib-only — mcp/tool_registry.py marca
    // readOnlyHint/kind:'pure' nas duas tools abaixo.
    mcp_safe_tools: ['forge_health', 'forge_architecture_review'],
    origin: 'official',
  },
  {
    name: 'code-atlas-forge',
    dist: 'code-atlas-forge',
    bin: 'code-atlas',
    minPython: '3.12',
    mcp: ['{bin}', 'mcp', 'serve'],
    // Servidor MCP ndjson próprio (sem pacote mcp) — sem extra no pyproject.
    // atlas_status/atlas_dependencies: todos os params opcionais, read-only —
    // src/code_atlas/mcp.py.
    mcp_safe_tools: ['atlas_status', 'atlas_dependencies'],
    origin: 'official',
  },
  {
    name: 'product-forge',
    dist: 'product-forge',
    bin: 'productforge',
    minPython: '3.11',
    mcp: ['{bin}', 'mcp', 'serve'],
    // pyproject do sibling: mcp = ["mcp>=1.9"]
    extras: ['mcp'],
    // Zero-arg/opcionais read-only — src/product_forge/mcp/server.py.
    mcp_safe_tools: ['productforge_status', 'product_list'],
    origin: 'official',
  },
  {
    name: 'forge-lens',
    dist: 'forge-lens-fl',
    bin: 'forge-lens',
    minPython: '3.11',
    mcp: ['{bin}', 'mcp-serve'],
    // Servidor MCP stdio próprio (stdlib) — sem extra mcp no pyproject.
    // lens.capabilities zero-arg; lens.stats só opcionais — ambas leem a
    // store local. src/forge_lens/mcp_server.py.
    mcp_safe_tools: ['lens.capabilities', 'lens.stats'],
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
