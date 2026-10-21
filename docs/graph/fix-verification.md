# Verificação do fix P0 — `graph ui` (spec lf-0021)

Contraparte de [`reproduction.md`](reproduction.md): a mesma matriz de fixtures
rodada **após** a correção em `the-forge/src/theforge/graphstudio.py`
(`STUDIO_HTML`, script inline — SHA extraído em cada relatório). O harness é o
mesmo (`scripts/graphphysics_repro.py`), estendido para distinguir parada por
convergência (`settled`) de interrupção inesperada (`raf_starved`).

## O que mudou no `<script>` do studio

| Defeito (audit.md)                                        | Correção                                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| repulsão com `dx/d` não-unitário (`d` = distância²)       | vetor unitário `dx/dist`, força `min(REP/(dist²+40), FCAP)`; Barnes–Hut (quadtree, θ=0.9) para N>500, exato O(N²) abaixo                      |
| mola quadrática `dx/d·f·d/120` (≈dx·(d−120)/6000)         | mola linear `dx/d·f`, `f=(d−120)·0.02·alpha`                                                                                                  |
| sem guarda de finitude                                    | `Number.isFinite` por nó/tick; nó não-finito volta a uma posição finita e o reset é **contado** no footer (`… · N resets`)                    |
| `running` nunca desarmava; RAF empilhável por `loadGraph` | contador de geração (`tick(g)` só continua se `g===gen`) + `cancelAnimationFrame` real a cada novo load                                       |
| sem fit-to-view; Escape fazia `{0,0,1}`                   | `fitToView()` no load, no Escape e em `window.onresize`; zoom preso a [0.02, 8]                                                               |
| `G.nodes.find()` por aresta em `draw`/`pick` (O(E·N))     | `G.byId` (`Map`) montado uma vez por `loadGraph`                                                                                              |
| exceção no tick = tela branca silenciosa                  | `try/catch` no tick → para o loop e mostra banner `#err`; `catch` nos fetches idem                                                            |
| canvas realocado quando a comparação com fração falhava   | `cv.width` só sincroniza em mudança inteira (`Math.round`)                                                                                    |
| sem decaimento — o laço nunca esfriava                    | `alpha*=0.985` por tick até piso 0.005; RAF para quando `moving==0` ou `alpha` no piso                                                        |
| `deg` contado antes do filtro de arestas penduradas       | filtro antes da contagem; idem em `sparkforge_aws/graphview.py` (subquery alinhada à janela `ORDER BY qualified_name, id` + filtro em `keep`) |

## Matriz pós-fix — 3.000 nós × 13 topologias (--ticks 600, node v22.23.2)

| Topologia            | Veredito   | Ticks até convergir | non_finite | resets | max \|coord\| | tick médio (antes)          |
| -------------------- | ---------- | ------------------- | ---------- | ------ | ------------- | --------------------------- |
| chain                | STABLE     | 352                 | 0          | 0      | 1.783 px      | 20,8 ms (137,5)             |
| **star**             | **STABLE** | 295                 | 0          | 0      | 899 px        | 18,6 ms (76,4 + NaN no t7)  |
| tree                 | STABLE     | 352                 | 0          | 0      | 1.787 px      | 23,5 ms (147,9)             |
| mesh                 | STABLE     | 352                 | 0          | 0      | 1.732 px      | 27,7 ms (193,9)             |
| dense-communities    | STABLE     | 352                 | 0          | 0      | 1.907 px      | 36,6 ms (318,8)             |
| disconnected         | STABLE     | 352                 | 0          | 0      | 1.842 px      | 25,2 ms (153,5)             |
| **high-degree-hubs** | **STABLE** | 352                 | 0          | 0      | 1.650 px      | 22,3 ms (155,9 + NaN no t8) |
| heterogeneous        | STABLE     | 352                 | 0          | 0      | 1.375 px      | 31,9 ms (121,8)             |
| isolated-components  | STABLE     | 275                 | 0          | 0      | 2.047 px      | 18,4 ms (103,6)             |
| parallel-edges       | STABLE     | 352                 | 0          | 0      | 1.803 px      | 23,4 ms (177,5)             |
| cycles               | STABLE     | 352                 | 0          | 0      | 1.744 px      | 21,1 ms (153,1)             |
| long-labels          | STABLE     | 352                 | 0          | 0      | 1.783 px      | 21,0 ms (151,3)             |
| heavy-metadata       | STABLE     | 352                 | 0          | 0      | 1.783 px      | 24,1 ms (96,1)              |

Leitura: **as duas topologias que explodiam (star, high-degree-hubs) agora
convergem** — `non_finite=0`, `resets=0`, coordenadas ≤2.100 px e o laço RAF
**para sozinho** (`settled=true`, ~352 ticks ≈ piso de alpha; o consumo de CPU
zera quando o layout estabiliza). O custo por tick caiu 4–9× (Barnes–Hut +
`byId`), de 96–319 ms para 18–37 ms.

`max|coord|` ficou maior que no baseline estável (~460 px → ~1.8k px) porque a
repulsão agora age na direção correta com alcance efetivo maior — o grafo se
espalha mais, mas de forma **limitada** e o `fitToView` enquadra tudo. Em
`dense-communities` (18k arestas) o tick médio (36,6 ms) ainda passa de um
frame de 16,6 ms durante o layout — melhora ~8,7×, honesta, não eliminação.

Controles pequenos (caminho exato, N≤500): star500 converge em 156 ticks
(533 px, 6,9 ms/tick); chain500 em 352 (1.004 px, 5,3 ms/tick).

## Regressão coberta por teste

`the-forge/tests/test_graphstudio_physics.py` — o pin da assinatura bugada virou
pin da assinatura corrigida + testes de convergência (star500, hubs1200,
chain500), de ciclo de vida RAF (segundo `loadGraph` deixa exatamente uma
cadeia viva), de `byId`/`fitToView`, de reset de nó envenenado com contagem no
footer e de banner de erro visível em exceção do tick. `spark-forge-aws
tests/test_graphview.py` — nenhuma aresta emitida pendura fora da janela de
nós (o bug de subquery agora tem teste que falharia na versão antiga).

## Vendorado

As 6 cópias `_graphstudio.py` foram re-vendoradas byte-paridade com o canônico
(sha256 `aade6687…` nas 7 — canônico incluído). Não existe script de vendor
para `_graphstudio.py` (`forge-portal/scripts/vendor.py` só cobre
`_forge_portal.py`/telemetria/assets); a cópia manual também corrigiu um drift
de formatação preexistente (`ruff format --check` agora passa nas 7).

## Limite honesto (inalterado)

Headless cobre física e sanidade de coordenadas — compositor, memória de
browser e resize real continuam fora do alcance do harness. `fitToView` e
`window.onresize` foram verificados logicamente (bbox → view) no driver, não
num compositor real.
