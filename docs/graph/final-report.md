# Relatório Final — Ciclo 13: evolução do Graph Studio (lf-0020 → lf-0025)

Ciclo completo: auditoria → reprodução → correção → modos de escala →
hardening → portal/federação → empacotamento + homologação. Este documento
obedece às 14 seções mandatórias de `prompt_evo_graph.md` §RELATÓRIO FINAL.

---

## 1. Commit SHA de cada repositório avaliado

HEADs no fechamento da homologação (commits criados por esta spec
marcados **lf-0025**):

| Repositório | Branch | SHA | Nota |
|---|---|---|---|
| the-forge | main | `9c206cf` (**lf-0025**) | fix `cwd=checkout` em `_view_from_cli` + teste + evidências `docs/graph/lf-0025-*.json`, `e2e-3k-metrics.json` |
| spark-forge-aws | main | `c5a60d6` (**lf-0025**) | `TestWheelCarriesGraphStudio` em `test_artifact_contents.py` |
| forge-cli | main | HEAD pós-commit `cf453aa` (**lf-0025**; SHA final = `git log -1` deste arquivo) | `docs/graph/lf-0025-homologation.md`, `final-report.md`, `case-*/` |
| forge-portal | release/2.2.2-certification | `2198589` | sem mudança nesta spec (build+specs re-rodados) |
| spark-forge-azure | main | `554a62c` | sem mudança — só evidência |
| api-forge | main | `bd057a6` | sem mudança — só evidência |
| platform-forge | main | `0df9528` | sem mudança — só evidência |
| forge-doctor-api | main | `43d5130` | sem mudança — só evidência |
| forge-doctor-data | main | `1845ca4` | sem mudança — só evidência |
| data-sentinel-forge | main | `97d7709` | **intocado** (read-only respeitado) |

Baseline auditada em lf-0020 (SHAs pré-ciclo): `audit.md` §HEADs.

## 2. Causa-raiz comprovada

Reproduzida headless sobre o `<script>` de produção real
(`the-forge/scripts/graphphysics_repro.py` extrai o script do
`STUDIO_HTML` e o executa verbatim sob node com DOM stubado):

> **Mola quadrática na distância** (`f=(d−120)·0.02` aplicada como
> `dx·(d−120)/6000` → kick ∝ d²) combinada com **rajada de repulsão de
> curta distância** (`dx/d` não-unitário com `d`=distância² → força
> explosiva r⁻³) diverge numericamente em grafos com concentração de
> grau. Coordenadas dobram de expoente a cada tick (2,5×10¹⁷ → 10³⁴ →
> 10⁶⁸ → 10¹³⁶ → 10²⁷³ → overflow float64 → `NaN` por `Inf−Inf`), em
> <10 ticks — `ctx.arc(NaN)` não desenha nada: o grafo inteiro some.
> Reproduzido em `star` (3000/3000 NaN no tick 7) e `high-degree-hubs`
> (975/3000 no tick 8); cadeia/árvore/malha/comunidades — controles —
> estabilizam. Evidência: `docs/graph/reproduction.md`.

Causas contribuintes provadas: RAF empilhável (`running` nunca desarmava),
zero guardas `isFinite`, sem fit-to-view, O(N²)+O(E·N) por frame, query
SQL de arestas desalinhada da janela de nós (`graphview.py`).

**Segunda causa-raiz (encontrada na homologação, lf-0025):** federação
rodava produtores com o cwd do chamador — todo sibling `graph view`
resolvia `--root .` no diretório errado e recusava "no index" mesmo com
índice presente. Fix: `cwd=checkout` em `theforge/graphview.py`.

## 3. Comparação antes/depois

| Eixo | Antes (lf-0020) | Depois (lf-0025) |
|---|---|---|
| 3k star/hubs | 3000/975 NaN em <10 ticks — grafo some | STABLE, non_finite=0, settle ~300 lticks |
| tick médio 3k | 96–319 ms | 18–37 ms (4–9×) |
| 10k full | ~1,1 s/tick (<1 fps) | settle ~19 min fatiado (SIM_MS=8, UI viva) — overview 8,1 s |
| 25k | 13,2 s/tick — travada | overview 250 clusters, settle ~6,6 s |
| Arestas truncadas | penduradas silenciosas | janela SQL alinhada + filtro + `#notice` explícito |
| Federação real | nunca exercitada | 3 providers / 17k nós mesclados ao vivo (bug cwd corrigido) |
| Wheel | `_graphstudio.py` não auditado | sha-verificado nas 7 wheels + clean-venv `graph ui` provado |

## 4. Algoritmos anteriores e novos

| Antes | Depois |
|---|---|
| Repulsão O(N²) `dx/d` com d=dist² (r⁻³ explosivo) | vetor unitário + `min(REP/(dist²+40), FCAP)`; **Barnes–Hut** (quadtree θ=0,9) N>500, exato O(N²) abaixo |
| Mola quadrática ∝d² | mola linear `f=(d−120)·0.02·alpha` |
| Sem decaimento | `alpha*=0.985` até piso 0,005 → RAF para no settle |
| `G.nodes.find()` por aresta/frame | `G.byId` Map único por load |
| RAF empilhável | contador `gen` + `cancelAnimationFrame` |
| Sem modo | **overview** (componentes→LPA→merge ≤250 clusters), **explore** (BFS depth/cap ≤2500), **full** (orçamento 10k/30k + notice) |
| Frame monolítico | **time-slice** `stepSlice` SIM_MS=8 ms por RAF |
| Sem prova de empacotamento | wheel contém módulo; guarda em `test_artifact_contents.py` |
| Federação por subprocesso em cwd herdado | `cwd=checkout` — produtor lê o próprio estado |

## 5. Métricas de performance

Fontes: `the-forge/docs/graph/perf-baseline.json` + `perf-report.md`
(node headless), `e2e-3k-metrics.json` (Chromium real), reports lf-0025.

| Escala | Modo | load | settle | tick médio | non_finite |
|---:|---|---:|---:|---:|---:|
| 100 | full | 85 ms | 1.051 ms | 12,4 ms | 0 |
| 3.000 | overview | 1.702 ms | 6.140 ms | 11,6 ms | 0 |
| 3.000 | full (browser real) | 2.311 ms | 56.462 ms* | — | 0 — 3000/3000 inside |
| 3.000 | full (harness) | — | 352 lticks | 45,4 ms | 0 |
| 10.000 | overview | 14.720 ms | 6.094 ms | 11,4 ms | 0 |
| 10.000 | full | timeout 900 s — **registrado, não escondido** | | | |
| 25.000 | overview | 100.318 ms† | 6.584 ms | 11,6 ms | 0 |
| live 16,6k (repo real) | overview via `graph ui` | 2.893 ms | settled | — | 0 — 250/250 inside pós-fit |

\* software-rendered headless, inclui pacing de RAF; † quase todo em
`computeClusters`. Portal (jsdom+Cytoscape, mesma projeção): merge de 3
views→10,2k nós em 0,82 s, primeiro layout 5,6 s, viewport p50 ≤25 ms,
busca 4,7 ms — `forge-portal/docs/perf/graph-federation-report.md`.

## 6. Capturas de tela

| Artefato | Caminho |
|---|---|
| 3k full settled (browser real) | `the-forge/e2e/artifacts/graph-studio/01-3k-full-settled.png` |
| Inspector sobre nó clicado | `…/02-3k-inspector.png` |
| Pós-teclado (busca+export) | `…/03-3k-after-keyboard.png` |
| Payload malformado → erro explícito | `…/04-malformed-error.png` |
| `graph ui` real 16,6k — overview | `forge-cli/docs/graph/case-a-cliui/cli-ui-overview.png` |
| ídem pós-fit (250/250 inside) | `…/cli-ui-overview-fitted.png` |
| ídem inspector | `…/cli-ui-inspector.png` |
| ídem busca | `…/cli-ui-search.png` |
| Portal explorer live (Lista) | `forge-cli/docs/graph/case-b-portal/portal-graph-explorer.png` |
| ídem Canvas (cytoscape) | `…/portal-graph-canvas.png` |
| ídem inspector | `…/portal-graph-canvas-inspect.png` |
| ídem após 30 s | `…/portal-graph-30s.png` |
| Screenshots de rotas do portal (lf-0023) | `the-forge/e2e/artifacts/*.png` |

(`e2e/artifacts/` é gitignored no the-forge — os PNGs vivem no filesystem;
métricas commitadas em `docs/graph/`.)

## 7. Resultados Playwright

- `the-forge/tests/test_graphstudio_e2e.py` — **4/4 verdes** nesta spec
  (Chromium 156 headless): load→full→settle→fit→pan→zoom→inspect→
  search→export + reduced-motion + malformed + headers CSP.
- Homologação ao vivo (scripts em `/tmp`, artefatos commitados):
  `case-a-cliui` (graph ui real 5k→overview) e `case-b-portal`
  (SPA real + `/api/v1/graphs` real, Lista↔Canvas, 30 s, 0 erros).

## 8. Resultados dos testes Python

| Repo | Recorte | Resultado |
|---|---|---|
| the-forge | `test_graphstudio*` + `test_graph*` + `test_capability_graph*` + `test_portal_graph_parity` | **120 pass** (+4 e2e) |
| spark-forge-aws | 16 arquivos `test_*graph*` + `test_artifact_contents` | **567 pass** (58 min) — suite completa ≈4 h não rodada (substituto declarado na spec) |
| spark-forge-azure | todos `test_*graph*` + packaging | **163 pass** |
| api-forge | `tests/graph/` + adapters/collectors/contracts/evals graph | **137 pass** |
| platform-forge | `test_graph*` + `test_ops_opgraph` + artifact | **34 pass** |
| forge-doctor-api | `test_*graph*` + packaging/boundary | **130 pass** |
| forge-doctor-data | `test_*graph*` | **121 pass, 3 skip** (env: `packaged _data ausente`, pré-existente) |
| **Total** | | **1.272 pass + 4 e2e, 0 falhas** |

## 9. Resultados dos testes Angular

`forge-portal` (`ng test`, vitest runner):

| Arquivo | Resultado |
|---|---|
| `core/graph/projection.spec.ts` | 13/13 |
| `core/graph/federated.spec.ts` | 13/13 |
| `core/graph/view-model.spec.ts` | 4/4 |
| `core/graph/analysis.spec.ts` | 11/11 |
| `pages/graph/graph.page.spec.ts` | 33/33 |
| **Recorte grafo** | **74/74** |

Suite completa reportada em lf-0024: 567/572 — as 5 falhas são timeouts
de 5 s sob carga da suite inteira e passam isoladas (flake pré-existente,
não do grafo). `ng build` produção: verde (bundle 371 kB inicial +
`graph-page` lazy 69 kB).

## 10. Validação de contratos

- `forge/ForgeGraphView/v1`: documentos servidos por `_graphstudio`,
  `graphview.build_view`, `federated_merge`, `/api/v1/graphs` — todos
  validados por `ForgeGraphView.from_dict` nos testes e na homologação.
- Paridade de contrato produtor: `test_portal_graph_parity.py` (aws +
  the-forge) — o documento do portal `/graphs` é **byte-idêntico** ao do
  `graph view`/`--federated --ui` (exceto `federation_notes`, diagnóstico
  de transporte do lado do portal — declarado).
- `forge/PortalApi/1`: session token + 405 mutação + loopback-only +
  CSP/nosniff — verificado em e2e (`test_studio_e2e_server_headers_in_browser`)
  e no serve-smoke das 7 forjas.
- Build reproduzível: 3 builds → sha256 `0d959ff6…` idêntico.

## 11. Matriz de providers

| Provider | `graph` verbos | `graph ui` | view própria | índice construído | federação | nota |
|---|---|---|---|---|---|---|
| the-forge | `graph --view/--federated/--ui` | ✓ | capability (11n) | n/a (capability) | ✓ produtor direto | também orquestra federação |
| spark-forge-aws | `build/status/view/ui` | ✓ | codeintel sqlite | ✓ 16.658n/28.186e | ✓ 5.000n (limit default) | caso A |
| spark-forge-azure | `build/query/impact/federate/view/ui` | ✓ | graph.json | ✓ 11.995n/35.693e | ✓ 11.995n | caso C+D |
| api-forge | `graph …/view/ui` | ✓ | nodes/edges jsonl | sem índice | `AF-GRAPH-NOT-FOUND` honesto | — |
| platform-forge | `graph` ×18 + `view/ui` | ✓ | snapshots temporais | sem índice | `PF-GRAPH-NOGRAPH` honesto | — |
| forge-doctor-api | `graph TARGET`, `view/ui` | ✓ | ServiceGraph | — | exit 2: dialeto `graph view` não exposto | ver §13 P1 |
| forge-doctor-data | `graph …/view/ui` | ✓ | build_graph | — | exit 2 (idem) | ver §13 P1 |
| data-sentinel-forge | — | n/a | SVG independente | — | exit 2 | **não aplicável** — read-only, fora do contrato |
| forge-portal | consumidor | n/a | merge via `projection.ts` | — | overlay `/api/v1/graphs` ×N | caso B+D |

## 12. Estado das publicações

**Nada foi publicado no Ciclo 13 até este relatório.** Nenhum bump de
versão, tag, release ou push a PyPI/npm foi executado — a onda de release
(dump+tag+publish) ocorre **depois** do aceite desta spec, pelo parent.

| Pacote | Versão atual (checkout) | Publicado? |
|---|---|---|
| sparkforge-aws | 0.5.4 | não nesta espec (wheel local construído e provado) |
| sparkforge-azure | 0.1.4 | não |
| apiforge-af | 0.1.4 | não |
| platformforge | 0.1.4 | não |
| forge-doctor-api | 0.2.4 | não |
| forge-doctor-data | 1.0.4 | não |
| theforge-core | 0.5.4 | não |
| forge-portal | branch `release/2.2.2-certification` | não (build de homologação local) |

Pendente para a release wave: bump/publish dos 7 pacotes Python com o
`_graphstudio.py` hardened `a1cd735c…` (já dentro deles por `packages=`),
re-vendor do `portal/assets` com o explorer de grafos da branch de
certificação nos pacotes que o embarcam, e push das branches.

## 13. Pendências P0/P1/P2

**P0** — nenhuma aberta. (O P0 original — desaparecimento — está corrigido
e coberto por testes; `10k --mode full` não completa em 900 s no harness
node, mas é limitação de budget do harness, não do produto: o browser real
faz 3k-full em 56 s e o overview é o modo recomendado >2k.)

**P1**
- `forge-doctor-api`/`forge-doctor-data`: o verbo `graph` não expõe
  `view` no dialeto que a federação chama (`graph view` → exit 2,
  "cannot read path"). Produtor recusa **honestamente** (motivo no
  `notes[]`), mas a federação nunca verá seus grafos até o verbo
  compatível existir. Registrado; corrigir requer spec própria.
- `spark-forge-aws graph view` não aceita `--json` (dialeto coberto pelo
  retry de flags da federação — funciona, mas documenta atrito de
  dialecto; considerar aceitar `--json` como no-op).
- Índices por-provider precisam ser construídos (`graph build`) antes de
  a federação enxergar a forja — hoje só AWS e Azure os têm neste
  workspace. Comportamento correto, mas operacionalmente exige o passo.
- Verbo dedicado de "verificar integridade do visualizador" no Forge CLI:
  não existe (integridade hoje = RECORD do wheel + sha256 auditado).
  Avaliar se `forge doctor` deve ganhar essa checagem.

**P2**
- Windows/Git Bash não exercitado localmente (caminho portável por
  construção; gate de wheel roda Windows no CI).
- `e2e/artifacts/` é gitignored — screenshots não sobem ao repo (métricas
  sim, em `docs/graph/`).
- Portal: 5 flakes de timeout pré-existentes na suite inteira (passam
  isoladas); `graph ui` usa `--limit 5000` por default (declarado em
  `limitations`/`#notice` — nunca silencioso).
- FPS real/compositor nunca medido (harness sem rasterizador) — claim
  honestamente omitida.

## 14. Recomendações finais

1. **Aceitar e prosseguir com a release wave** — os 26/27 itens de §13
   estão verified/simulated com evidência; o único bloqueado estrutural é
   "wheel no PyPI", que é a própria release.
2. **Antes de publicar, re-vendor `portal/assets`** nos pacotes que o
   embarcam — o bundle vendored atual é da geração 2.2.1 e não contém o
   explorer pós-lf-0024 (a homologação do Caso B usou build fresco da
   branch de certificação).
3. **Abrir spec para o dialeto `graph view` dos doctors** — hoje a
   federação os enumera mas nunca os coleta; basta um subcomando `view`
   emitindo ForgeGraphView/v1.
4. **Manter o harness** (`graphphysics_repro.py`, `graph_perf.py`,
   fixtures determinísticos) como gate de qualquer futura mudança de
   física — ele provou causa-raiz, correção e não-regressão sem browser.
5. **CI**: os gates locais passaram em todos os repos tocados; o check
   "CI verde" depende do push — validar na wave antes do publish.
6. **Documentar `graph build` como pré-requisito de federação** por forja
   (o `notes[]` já diz isso por refusal code; um README/steering curto
   evita a pergunta).

---

*Evidência completa: `lf-0025-homologation.md` (casos A–D + checklist),
`audit.md`, `reproduction.md`, `fix-verification.md`,
`modes-verification.md`, `lf-0024-verification.md` — todos em
`forge-cli/docs/graph/`; artefatos por caso em `case-a-cliui/`,
`case-b-portal/`, `case-d-federation/`.*
