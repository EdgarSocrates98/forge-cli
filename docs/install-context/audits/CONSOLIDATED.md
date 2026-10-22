# CONSOLIDATED — Install 2.0 Cycle 1 audit (lf-0034)

Baseline SHAs: spark-forge-aws `2230a5d` · spark-forge-azure `d35305c` ·
api-forge `5b3a195` · platform-forge `b58dc9c` · the-forge `77654a5` ·
forge-cli `4a12652` · forge-portal `2dca5cf` · forge-doctor-data `8d41bde` ·
forge-doctor-api `c7a05b2` · data-sentinel-forge `92f245f`.

Docs por repo: `docs/audits/FORGE_CONTEXT_BASELINE.md` em cada uma das 5 forges
+ `docs/install-context/audits/COMPLEMENTARY.md` (cli/portal/doctors/sentinel).

## Resumo executivo

O **motor de instalação já existe** — `_installkit.py` byte-idêntico vendored nas
5 forges (sha `37250539…`), `~/.forge/installations/` registry de conta ativo,
`install/status/repair/uninstall/update` implementados, wheels **byte-identicos
ao PyPI publicado** (reproducible build confirmado nos 5). O que **não existe** é
a camada de contexto: registry de workspace `.forge/context/`, manifesto
`forge-context/v1`, templates de entry-point (AGENTS.md/CLAUDE.md/
AGENT_PROTOCOL.md) e handles instalados para knowledge/rules/evals.

## Matriz de gaps transversais

| Gap | AWS | Azure | api-forge | platform | the-forge |
|---|---|---|---|---|---|
| `.forge/context/` registry + `forge-context/v1` | ausente | ausente | ausente | ausente | ausente |
| Templates AGENTS/CLAUDE/PROTOCOL ao alvo | marker só | marker só | AGENT_PROTOCOL no wheel, não copiado | `marker_files=()` — zero | marker ~5 linhas |
| Refs mortas `../../knowledge/*` em mirrors instalados | 130 refs/51 SKILL.md | sim | sim (dead refs AGENT_PROTOCOL) | — | — |
| `install manifest`/`install env` verbs | ausente | ausente | parcial | parcial | existe |
| `forge.json`/manifestos no wheel | ausente | ausente | ausente | ausente | presente |
| agents/skills no wheel completos | ok | ok | ok | ok | **P0: `agentic/agents/` ausente** |
| MCP registration pelo install | ok (.mcp.json) | ok | quebrado (`"command":"python"`) | **nunca registrado** | ok |
| `~/.forge/installations/` registro | ok | ok | entry stale pós-uninstall | ausente | ok |

## P0s pontuais por repo

- **the-forge**: `agentic/agents/` fora do wheel (`install apply --components agents` → 0).
- **AWS**: `AGENT_PROTOCOL.md` nunca instalado — 65 refs instaladas apontam para ele.
- **Azure**: `doctor.agentic_fleet` usa `REPO` root errado → 40 agents `broken` num install válido (bug, não design).
- **api-forge**: AGENT_PROTOCOL.md no wheel mas nunca copiado; nada no alvo aponta para knowledge/rules/evals.
- **platform-forge**: install não escreve instrução nenhuma ao consumidor; MCP nunca registrado (`mcp integrate` manual gera `"command":"python"` quebrado e duplica blocos TOML fora do ledger).
- **Transversal**: sdists locais vazam `.tokensave/` (~148MB api-forge, ~83MB platform) — exclusão só via `.git/info/exclude`; publicados limpos por acidente de checkout limpo.

## Decisões propostas (entrada para lf-0035+)

1. `forge-context/v1` como schema canônico + cópia vendored com byte-parity
   (padrão `_installkit.py`/`_graphview.py` já estabelecido).
2. `.forge/context/` = registry de WORKSPACE (novo), distinto de
   `~/.forge/installations/` (conta, já existe) — sem conflito de ownership.
3. Templates de consumo como assets do installkit, merge por blocos gerenciados
   (`<!-- forge:<id>:begin/end -->`, padrão `theforge:invariants` já em uso).
4. Knowledge/rules ficam package-resident: install escreve handles/discovery
   apontando para os comandos nativos (`knowledge path`, `rules search` etc.) —
   não copiar catálogos (spec §2.3 REFERENCIAR).
5. Corrigir bugs P0 encontrados (Azure doctor root, the-forge agents packaging,
   platform MCP/marker) como parte da implementação — são bugfix-class.
6. the-forge em Feature Freeze: `.forge/context` novo → ADR obrigatório com
   evidência de dogfooding (specs já produzem essa evidência).
7. Fix `.tokensave/` leakage: `.gitignore`/`MANIFEST.in` committed, não
   `.git/info/exclude`.

## Notas de processo

- api-forge: implementação deve criar `.apiforge/case/` + `apiforge next-step`
  conforme AGENTS.md — o audit não criou (gap a remediar nos specs seguintes).
- Azure `check_claims.py` timeoutou por tempo de suíte local (issue de máquina,
  não do change) — CI é a referência.
- Artefatos de teste em /tmp pelos workers (af-venv, af-target etc.) — deletáveis.
