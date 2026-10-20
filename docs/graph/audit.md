# Auditoria do stack de grafos das Forjas — spec lf-0020 (FASE 0)

Auditoria das 9 forjas sobre as 12 dimensões de `prompt_evo_graph.md` §FASE 0,
mais a reprodução do P0 (`graph ui` ~3.000 elementos: vértices aparecem, se
espaçam violentamente e desaparecem). Síntese de duas auditorias independentes
sobre o checkout local; evidência da reprodução em
[`reproduction.md`](reproduction.md).

## HEADs auditados

| Repositório | SHA | Branch |
|---|---|---|
| the-forge | `6f7f696b941cbda628a5065e25317e67a82ccbf6` | main |
| api-forge | `b3df36e9942b2a69698dcf9334916694f95a4a69` | main |
| platform-forge | `e9b6231262923094d70f0411f79400320e67e394` | main |
| spark-forge-aws | `3c98d4751ce07a6c27cc7d2d685246ba4b4f6dcc` | main |
| spark-forge-azure | `82018e108808440fc6b9fb78e0b9ef64517f449a` | main |
| forge-doctor-api | `c64315f253a81cde2fa3b8e04375b19a3c1c3b37` | main |
| forge-doctor-data | `2864b0e16fbe62df143100e2240f802838990517` | main |
| data-sentinel-forge | `ae9ac2dc13bc72170f0a1afa9992473eea354ab2` | main (read-only) |
| forge-portal | `9d997d27badec109b8b335dd5f1f943abae72d94` | release/2.2.2-certification |

## Achado estrutural central: um único Graph Studio, sete cópias

Todas as forjas com `graph ui` compartilham **o mesmo** frontend: o arquivo
canônico `the-forge/src/theforge/graphstudio.py` é vendorado **byte a byte**
como `_graphstudio.py` em api-forge, platform-forge, spark-forge-aws,
spark-forge-azure, forge-doctor-api e forge-doctor-data. Idem para o contrato
`ForgeGraphView/v1`: canônico em `the-forge/src/theforge/contracts/graphview.py`,
vendorado como `_graphview.py` nas mesmas 6 forjas. Um defeito no
`graphstudio.py` canônico é, portanto, um defeito nas sete forjas.

Artefatos vendorados com byte-paridade verificada:

| Artefato | Canônico | Cópias |
|---|---|---|
| `_graphstudio.py` | `the-forge/src/theforge/graphstudio.py` | ×6 forjas |
| `_graphview.py` | `the-forge/src/theforge/contracts/graphview.py` | ×6 forjas |
| `_forge_portal.py` | `forge-portal/portal_core/forge_portal.py` (SHA `a6bbc5f5…`) | ×7 forjas |
| `portal/assets` (Angular) | `forge-portal/` | ×7 forjas |

Pipeline de vendor: `forge-portal/scripts/vendor.py`. data-sentinel-forge não
contém nenhum desses artefatos.

## As 12 dimensões por repositório

| Repo | Motor / modelo | Fonte | Projeção | UI / layout / render | APIs | Limite de escala | Testes | Portal |
|---|---|---|---|---|---|---|---|---|
| **the-forge** | `graphview.capability_view`, `federated_views`, `federated_merge` (`src/theforge/contracts/graphview.py`) | subcomandos `graph --view/--federated/--ui` | ForgeGraphView/v1 (canônico) | Graph Studio canônico; Canvas 2D + force sim próprio | HTTP GET-only `/api/health`, `/api/graphs`, `/api/graph/<id>` (`graphstudio.py:267-286`) | sem limite declarado | `tests/test_graphstudio.py` (incl. gate de sintaxe `node --check` do script inline) | vendora portal |
| **api-forge** | engine próprio; `nodes.jsonl`/`edges.jsonl` canônicos | `graph build/query/impact/trace/coverage/export/view/ui` | ForgeGraphView/v1 | mesmo `_graphstudio.py` vendorado | CLI + tools MCP `graph *` | sem limite declarado | suíte própria | `portal_adapter._graph_view` → GET `/api/v1/graphs` |
| **platform-forge** | `platformforge/graph/` com **snapshots temporais** | `graph` ×18 subcomandos (build/stats/deps/blast/paths/gaps/cycles/diff/snapshots/identity-*/at/timeline/view/ui) | ForgeGraphView/v1 | mesmo `_graphstudio.py` vendorado | CLI | sem limite declarado | suíte própria | adapter portal |
| **spark-forge-aws** | codeintel SQLite (`nodes`/`edges`) | `graph build/status/view/ui` (`cli.py:2460-2499`, `5941-5999`) | `sparkforge_aws/graphview.py` → ForgeGraphView/v1 | mesmo `_graphstudio.py` vendorado | CLI | `--limit 5000` (nó do P0) | suíte própria | adapter portal |
| **spark-forge-azure** | `sparkforge_azure/graph/` | `graph build/query/impact/federate/view/ui` (`cli/cmd_graph.py`) | ForgeGraphView/v1 | mesmo `_graphstudio.py` vendorado | CLI + tools MCP `sfa_graph_*` | sem limite declarado | suíte própria | adapter portal |
| **forge-doctor-api** | `graph TARGET` build `ServiceGraph` | view/ui | ForgeGraphView/v1 | mesmo `_graphstudio.py` vendorado | CLI | sem limite declarado | suíte própria | adapter `_graphs` (`no_graph`+unlock) |
| **forge-doctor-data** | `core/graph.build_graph` (arestas reais apenas) | `graph inspect/schema/traversals/project/view/ui` (`cli/graph.py`) | ForgeGraphView/v1 | mesmo `_graphstudio.py` vendorado | CLI | sem limite declarado | suíte própria | adapter portal |
| **data-sentinel-forge** | **independente** — SVG Evidence Graph, layout longest-path determinístico, derivado de InvestigationReports | cliente (reports) | própria | SVG, sem force sim | sem API | n/a (audit read-only) | suíte própria | nenhuma dependência |
| **forge-portal** | **não executa motor de grafo** — consome ForgeGraphView/v1 de cada forja via `GET /api/v1/graphs` e monta overlay `forge/FederatedGraph/v1` (sem relações inferidas) | APIs das forjas | ForgeGraphView/v1 + FederatedGraph/v1 | **Angular Graph Studio independente**: Cytoscape 3.34.3, renderer canvas | portal_core vendora a 7 irmãs | tiers: ≤250 cose / ≤1200 concentric / ≤6000 grid / >6000 grid+progressive+cluster-advisory; `TIER_MAX_NODES=4000`, `PROGRESSIVE_CHUNK=2000`, watchdog budgets | `docs/perf/graph-scale-report.md`, `scripts/graph-bench.mjs`: 10k mount 2,4 s, grid 797 ms | canônico |

## Defeitos confirmados no `graphstudio.py` canônico

Cada item cita `the-forge/src/theforge/graphstudio.py`; as cópias vendoradas
são byte-idênticas. **Nada foi corrigido** — correção é spec lf-0021.

### Força/layout (causa-raiz provada — ver `reproduction.md`)

- **Repulsão O(N²) com cauda r⁻³** — `tick()`, linhas 101-103: `d` é distância
  ao QUADRADO (`d=dx*dx+dy*dy+40`, :102) e o kick usa `a.vx+=dx/d*f` (:103) —
  `dx/d` não é vetor unitário → kick ~`dx/(dx²+40)·min(2000/(dx²+40),40)`,
  explosivo a curta distância.
- **Mola quadrática na distância** — linhas 104-106: `f=(d-120)*0.02` (:105)
  aplicada como `a.vx+=dx/d*f*d/120` (:106) → kick componente =
  `dx·(d-120)/6000` → cresce com `d²` → Euler explícito diverge assim que um
  par passa de d≈2.000 (empiricamente: tick seguinte já e+17, depois e+34,
  e+68, e+136 — expoente dobra a cada tick → Infinity → NaN por Inf−Inf).
- **Sem amortecimento de convergência** — gravidade `a.vx-=a.x*0.001`,
  damping `vx*=0.85`, integração `a.x+=a.vx` (:107-108); não existe alpha
  decay: o laço nunca esfria.
- **RAF empilhável** — `running` é declarado `true` (:63), nunca vai a
  `false`; `tick` re-agenda se `n>0&&running` (:109) e cada `loadGraph`
  chama `running=true;tick()` (:88) → cada troca de grafo empilha mais uma
  cadeia de RAF sobre a anterior, multiplicando a força efetiva por frame.
- **Sem `Number.isFinite`**, sem `try/catch`, sem fit-to-view (Escape faz
  `view={x:0,y:0,s:1}` :240 — reset, não fit), sem `window.onresize`; caixa
  inicial aleatória de ±300 px (`Math.random()*600-300`, :77).

### Complexidade por frame (saturação da main thread)

- `tick()` é O(N²) por frame (:101-103) — 3.000 nós ≈ 4,5 M pares/tick
  (medido: 137 ms médio ≈ 7 fps na máquina da auditoria; 10.000 nós ≈
  1.117 ms/tick ≈ <1 fps — ver `reproduction.md`).
- `draw()` resolve cada aresta com `G.nodes.find(...)` dentro do loop
  (:124) → O(E·N) por frame; `pick()` idem (:161-162).
- `cv.width!==r.width*devicePixelRatio` (:113) realoca o canvas sempre que a
  comparação com fração falha → redraw + realloc por frame.

### Modelo de dados

- `spark-forge-aws/sparkforge_aws/graphview.py:74-79` — a query de arestas
  usa `WHERE source_id IN (SELECT id FROM nodes LIMIT ?)` (ordem de rowid),
  enquanto a janela de nós é `ORDER BY nodes.qualified_name LIMIT ?` (:70) —
  subconjuntos diferentes → arestas penduradas em views truncadas; `deg` é
  contado antes do filtro. (No `graph ui` o filtro do lado JS descarta as
  penduradas — a aresta some; o defeito aparece em consumidores do view doc.)

## Causa-raiz do P0

**PROVADA por reprodução headless sobre o código de produção** (detalhes e
números em [`reproduction.md`](reproduction.md)):

> A combinação da mola quadrática (`dx·(d-120)/6000`) com a rajada inicial de
> repulsão entre nós de alta concentração de grau diverge numericamente: os
> vértices "se espaçam" (rajada de repulsão a curta distância) e em <10 ticks
> as coordenadas passam de ~4×10⁴ px a ±Infinity/NaN — `ctx.arc(NaN)` não
> desenha nada, e todo o grafo desaparece de uma vez. O gatilho é
> **concentração de grau** (topologias com hub): estrela e high-degree-hubs
> a 3.000 nós reproduzem; cadeia, árvore, malha, comunidades e os demais
> controles estabilizam — não é o harness nem "qualquer grafo de 3k".

Causas contribuintes confirmadas: ausência de `isFinite`/guardas (nada
interrompe a divergência), `running` que nunca desarma + RAF empilhável
(multiplica a força a cada `loadGraph`), O(N²)/O(E·N) por frame (a main
thread satura e a explosão acontece em frações de segundo). O bug de subquery
do `graphview.py` é de **integridade do modelo**, paralelo ao P0 — arestas
penduradas são descartadas silenciosamente pelo filtro do studio.

## Fora de escopo desta spec

Qualquer correção de código de produção (lf-0021); evolução de
data-sentinel-forge (read-only); implementação do portal (lf-0023).
