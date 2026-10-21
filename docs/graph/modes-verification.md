# Verificação dos modos de escala — `graph ui` (spec lf-0022)

Continuação de [`fix-verification.md`](fix-verification.md) (lf-0021). Mesmo
harness (`the-forge/scripts/graphphysics_repro.py`, agora com `--mode`), mesmo
`<script>` extraído de `the-forge/src/theforge/graphstudio.py` e rodado
headless sob node — código real, DOM stubado.

SHA-256 do `<script>` extraído nesta rodada:
`67213a25de2e2b825f575b62202ff38d769838e540ba6c44082bca583336bcf3`
SHA-256 do arquivo canônico inteiro (idêntico nos 6 `_graphstudio.py`
vendored): `c27009ce28062e34a911b5f628e89a1e948d687ff18d77d549f5417c62e98584`

## O que o lf-0022 adicionou ao `<script>`

| Requisito                                | Implementação                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview** (> `OV_MIN`=2000 nós, auto) | `computeClusters()` — componentes conexos → label-propagation síncrono dentro de componentes >40 (desempate: menor índice de label — determinístico) → merge determinístico até ≤`CLUST_MAX`=250. Clusters renderizam como nós dimensionados por `size`; arestas viram `aggEdges` com `weight`/histograma de kinds e `provenance: 'cluster-rollup'`. |
| **Drill-down**                           | `drill()` → Explore com seeds = top-25 membros por grau; breadcrumb registra `overview › cl<id>` (`pushCrumb` antes da troca de modo).                                                                                                                                                                                                               |
| **Explore**                              | `exploreSet()` — BFS com `depth` (padrão 2, ajustável 1–5) e `cap` por nó (padrão 25; ordem `(-deg, id)` determinística), teto duro `EXPL_MAX`=2500 com notice visível; `expandNode`/`x` adiciona vizinhança ≤cap.                                                                                                                                   |
| **Full**                                 | Teto explícito `FULL_BUDGET`=10.000 nós e `3·budget` arestas; estouro → `#notice` `Truncated — showing N/M nodes, E/K edges · refine filters/search`. Nada é descartado em silêncio.                                                                                                                                                                 |
| **Persistência**                         | `savePrefs`/`loadPrefs` em `localStorage` por `graph_id` (mode, depth, cap, lod).                                                                                                                                                                                                                                                                    |
| **Tiered rendering**                     | `lod` auto/fine/coarse; labels só com `view.s≥0.6` ou ≤`LABEL_MAX`=300 visíveis; arestas em batches por estilo de trace; setas só ≤`ARROW_MAX`=1500; `edgeStride` dizima `eligible>EDGE_DRAW_MAX`(12.000) com passo determinístico — footer sempre `K edges · M drawn (dec ×s)`.                                                                     |
| **Navegação**                            | busca substring id/label (`/`, Enter destaca + `fitToNodes`); checkboxes de node-kind e edge-kind; minimapa clicável; setas pan, `+`/`-` zoom, Esc deseleciona; breadcrumbs `renderCrumbs`.                                                                                                                                                          |
| **Inspector**                            | `inspect()` — id, kind, label, atributos, degree (out/in), vizinhos limitados a `NEI_CAP`=50 com affordance `more +50 (… left)`, evidence refs; arestas: endpoints, kind, atributos, provenance/epistemic_state/confidence/temporal; botão `×` e Esc fecham.                                                                                         |
| **Análise**                              | `shortestPath` BFS ≤`PATH_MAX_DEPTH`=12 (miss reporta o bound); `blast` BFS dirigido ≤6 hops ≤`BLAST_CAP`=800 com painel e filtro; `commsPanel` lista comunidades (count + top-8); `jobSeq` torna um novo pedido cancelador do anterior.                                                                                                             |
| **Time-slice**                           | um tick lógico é a máquina `stepSlice` (live → rep → att → int) com cursores `{i,j}/{bi,aj}/ei`, cortada a `SIM_MS`=8 ms por RAF; grafos com `tickEst()≤TICK_SMALL`(8000) rodam o tick inteiro num frame (semântica antiga preservada). `lticks` conta ticks lógicos; nó mutado mid-tick é revalidado na entrada do frame antes de forças retomarem. |
| **Determinismo**                         | `srand('g:'+id)` + `rand()` mulberry32 para posições iniciais e jitter de colisão; clusters ganham `srand('pos:'+id+':'+cid)`; `Math.random` não aparece no script.                                                                                                                                                                                  |

## Matriz — 3.000 nós × 13 topologias (modo auto → overview, `--ticks 600`)

| Topologia           | Veredito | clusters | lticks settle | RAF frames | frame médio (ms) | resets | non_finite |
| ------------------- | -------- | -------- | ------------- | ---------- | ---------------- | ------ | ---------- |
| chain               | STABLE   | 250      | 316           | 555        | 11,71            | 0      | 0          |
| cycles              | STABLE   | 250      | 327           | 571        | 11,66            | 0      | 0          |
| dense-communities   | STABLE   | 50       | 267           | 36         | 10,95            | 0      | 0          |
| disconnected        | STABLE   | 120      | 191           | 79         | 11,65            | 0      | 0          |
| heavy-metadata      | STABLE   | 250      | 336           | 581        | 11,73            | 0      | 0          |
| heterogeneous       | STABLE   | 5        | 134           | 2          | 8,04             | 0      | 0          |
| high-degree-hubs    | STABLE   | 116      | 324           | 118        | 12,62            | 0      | 0          |
| isolated-components | STABLE   | 250      | 216           | 387        | 10,04            | 0      | 0          |
| long-labels         | STABLE   | 250      | 325           | 554        | 11,69            | 0      | 0          |
| mesh                | STABLE   | 250      | 352           | 631        | 13,87            | 0      | 0          |
| parallel-edges      | STABLE   | 250      | 347           | 607        | 11,59            | 0      | 0          |
| star                | STABLE   | 2        | 164           | 2          | 3,62             | 0      | 0          |
| tree                | STABLE   | 250      | 338           | 610        | 11,89            | 0      | 0          |

Leitura: em overview, a sim roda sobre os corpos de cluster (≤250 nós de
render), não sobre os 3.000 membros — wall-clock caiu de ~1–3 min (lf-0021,
3k reais) para 0,06–9 s. `non_finite=0`, `resets=0`, `settled=true` em todas.
Coordenadas de membros permanecem na caixa seed ±300 (`max|coord|≈300`) — são
posicionadas só quando o cluster é drillado, o que é o comportamento
projetado (relatório mede `G.nodes`, os nós reais).

## Escalas grandes

| Fixture           | Modo          | Render                     | Veredito | settled | lticks | RAF    | frame médio | wall     | notice                                                                           |
| ----------------- | ------------- | -------------------------- | -------- | ------- | ------ | ------ | ----------- | -------- | -------------------------------------------------------------------------------- |
| graph_10000_chain | auto→overview | 250 clusters / 249 agg     | STABLE   | sim     | 325    | 567    | 11,79 ms    | 8,1 s    | —                                                                                |
| graph_25000_chain | auto→overview | 250 clusters / 249 agg     | STABLE   | sim     | 337    | 607    | 12,00 ms    | 10,5 s   | —                                                                                |
| graph_10000_chain | full          | 10.000 nós / 9.999 arestas | STABLE   | sim     | 352    | 9.665  | 118,9 ms*   | 19,4 min | —                                                                                |
| graph_25000_chain | full          | 10.000 nós / 9.999 arestas | STABLE   | sim     | 352    | 10.230 | 145,8 ms*   | 25,5 min | `Truncated — showing 10000/25000 nodes, 9999/9999 edges · refine filters/search` |

\* máquina sob load ~9 + draw via Proxy-stub que aloca closures — o número
absoluto é um artefato do harness; o estrutural é `raf_frames ≫ lticks` (~29
frames/tick → fatiamento real a `SIM_MS=8`), `non_finite=0`, `resets=0`,
`max|coord|≈2,7k px` e `settled=true`. Em full-25k o notice de truncamento
aparece exatamente como projetado.

## Checks de superfície (drivers custom, mesmo script verbatim)

| Requisito                | Evidência (teste em `tests/test_graphstudio_modes.py`)                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clusters determinísticos | `computeClusters()` rodado 2× → assinatura `id=members` idêntica; `clusterMap.size===G.nodes`; dbl-click → `drill` seeds ⊆ membros; crumb `[overview, cl…]` |
| Explore honra caps       | chain n30: depth2+cap2 → exatamente `{n28..n32}`; cap1 → `{n28,n29,n30}`; depth1+cap2 → `{n29,n30,n31}`                                                     |
| Truncamento visível      | `FULL_BUDGET=150` em 500 → `#notice` `Truncated — showing 150/500 nodes, …` + `display:block`                                                               |
| Busca                    | `'node-1'` em 200 → 111 hits destacados, `111 shown of 111 matches` no `#prov`, `111 hits` no footer; limpar restaura                                       |
| Inspector                | hub n0 → `deg 199`, `Neighbors (199)`, `more +50`, atributos; aresta → `n0 → n1`, `imports`; `×`/vazio volta ao placeholder                                 |
| BFS limitado             | `n0→n5` = 6 nós + 5 arestas destacadas; `n0→n59` (>12 hops) → `no path …` sem travar                                                                        |
| Labels virtualizados     | 400 nós `view.s=1` → 400 labels; `view.s=0.02` → <50                                                                                                        |
| Time-slice settle        | `SIM_MS=1` forçado em 550 nós → `settled=true`, `raf>lticks` (frames realmente fatiados), `non_finite=0`                                                    |
| Decimação de arestas     | dense-communities full: `18049 edges · 9025 drawn (dec ×2)` no footer                                                                                       |

## Gates

- `the-forge`: `pytest tests/test_graphstudio*.py -q` → **35 passed**;
  `ruff check .` → **clean**; `mypy src/theforge/graphstudio.py
scripts/graphphysics_repro.py` → **clean**.
- `spark-forge-aws`: `pytest tests/test_graphview.py` → **3 passed**
  (`tests/graph/` contém apenas fixtures/gerador — sem testes coletáveis).
- `forge-doctor-api`: `pytest test_package test_boundary
test_plugin_boundary` → **49 passed**.
- `forge-doctor-data`: `pytest test_contract_boundaries test_plugins
test_forger_boundary test_mcp_boundary` → **84 passed**.
- `spark-forge-azure`: `scripts/check_surface_lock.py` → `{"status":"ok","drift":[]}`.
- `api-forge` / `platform-forge` / `spark-forge-azure` /
  `forge-doctor-*`: import de `*_graphstudio` OK; SHA-256 idêntico ao
  canônico nos 6 arquivos.

## Limitações honestas

- O harness é headless: sem compositor, sem GPU, sem RAF real — “UI não
  congela” é inferida do bound `SIM_MS=8 ms`/frame, não medido em browser.
- `tick_ms` mede a duração do callback RAF (slice de sim ≤8 ms + draw stubado
  por Proxy no-op) numa máquina sob load ~9 — **tempos absolutos não são
  representativos**; o número estrutural é `raf_frames > logical_ticks`
  (fatias acontecem) e `settled=true`.
- Em `overview`, `G.nodes` fica na caixa seed; o relatório mede nós reais —
  `max|coord|≈300` reflete o init, não a explosão.
- `pick()`/hit-test é O(R) linear por evento de mouse — aceitável ≤250
  clusters ou ≤10k full, mas sem índice espacial para hover em full-25k.
- `diff`/`export`/snapshot não são exercitados pelos testes de modo.
- `localStorage`/`setTimeout` são stubs — persistência real só testada em
  browser.
