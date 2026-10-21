# Homologação lf-0025 — empacotamento wheel + casos A–D + checklist §13

Spec final do Ciclo 13 (evolução de grafos). Fonte de verdade:
`prompt_evo_graph.md` §FASE 11/12/13. Execução em 2026-10-21 sobre os HEADs
listados na seção de SHAs do `final-report.md`.

## FASE 11 — Empacotamento (wheel-only)

### Auditoria de dependências do frontend

`STUDIO_HTML` é uma string inline em `graphstudio.py`/`_graphstudio.py` —
o "asset" que viaja é o próprio módulo `.py`, incluído por
`packages = [...]` do hatchling em todos os 7 pacotes. Auditoria estática do
canônico (`the-forge/src/theforge/graphstudio.py`, sha256 `a1cd735c…`):

- **Zero referências externas**: nenhum `<script src=`, `<link href=`,
  `url(http…)`, CDN (`cdn`/`jsdelivr`/`unpkg`/`googleapis`). Os únicos
  `fetch()` são same-origin (`/api/graphs`, `/api/graph/<id>`) — servidos
  pelo próprio handler.
- **Zero leitura de arquivo de frontend**: o único `read_text` do módulo
  lê `components.json` (estado de instalação, não asset — ausência =
  enabled por default).
- Servidor: `ThreadingHTTPServer` stdlib em 127.0.0.1; sem deps além de
  PyYAML/jsonschema do pacote (o caminho `graph ui` em si é stdlib-only).

### Matriz de wheels (7/7)

Cada wheel construído via `python -m build --wheel` no venv do repo e
inspecionado por zipfile:

| wheel                   | módulo                              | sha256      | refs externas |
| ----------------------- | ----------------------------------- | ----------- | ------------- |
| sparkforge_aws-0.5.4    | `sparkforge_aws/_graphstudio.py`    | `a1cd735c…` | 0             |
| sparkforge_azure-0.1.4  | `sparkforge_azure/_graphstudio.py`  | `a1cd735c…` | 0             |
| apiforge_af-0.1.4       | `apiforge/_graphstudio.py`          | `a1cd735c…` | 0             |
| platformforge-0.1.4     | `platformforge/_graphstudio.py`     | `a1cd735c…` | 0             |
| forge_doctor_api-0.2.4  | `forge_doctor_api/_graphstudio.py`  | `a1cd735c…` | 0             |
| forge_doctor_data-1.0.4 | `forge_doctor_data/_graphstudio.py` | `a1cd735c…` | 0             |
| theforge_core-0.5.4     | `theforge/graphstudio.py`           | `a1cd735c…` | 0             |

54.896 bytes idênticos em todos — o sha256 do **módulo dentro do wheel** é
o mesmo do checkout canônico.

### Prova de instalação limpa (spark-forge-aws)

```text
python -m venv /tmp/lf0025-venv
pip install sparkforge_aws-0.5.4-py3-none-any.whl   # resolve PyYAML+jsonschema do PyPI
sparkforge-aws graph build --root /tmp/lf0025-ws    # workspace sintético 3 arquivos .py
sparkforge-aws graph status --root /tmp/lf0025-ws   # → 6 nodes / 3 edges
sparkforge-aws graph view   --root /tmp/lf0025-ws   # → forge/ForgeGraphView/v1
sparkforge-aws graph ui --root /tmp/lf0025-ws --no-browser --port 18765
  GET /                  → 200 (49.023 B de STUDIO_HTML, 0 refs externas)
  GET /api/health        → {"status":"ok","graphs":1}
  GET /api/graphs        → descriptor codeintel-graph (6n/3e)
  GET /api/graph/<id>    → documento completo
  POST /                 → 405 (read-only)
```

Nenhum checkout, nenhum arquivo fora do site-packages — o wheel basta.

### Reprodutibilidade de build

Três builds independentes do mesmo tree produziram wheel idêntico:
sha256 `0d959ff62740e3c30d07d9e5b622902246b5574e9e7fbd33fe5518e90e4a58bd`
(sparkforge_aws-0.5.4). `reproducible = true` no hatchling + gate
`scripts/verify_wheel.py` (CI, ubuntu+windows) mantém a propriedade.

### Guarda durável adicionada nesta spec

`spark-forge-aws/tests/test_artifact_contents.py::TestWheelCarriesGraphStudio`
(3 testes): módulo dentro do wheel, bytes do wheel == bytes do checkout,
STUDIO_HTML sem referência externa. Falharia em qualquer regressão de
`packages=` ou reintrodução de CDN.

### Itens §FASE 11 não cobertos localmente (honesto)

- **Windows + Git Bash**: sem Windows nesta máquina — o caminho é portável
  por construção (stdlib, loopback, `venv_python` cobre os dois layouts);
  o gate `verify_wheel.py` roda em Windows no CI. **Simulado.**
- **Wheel no PyPI**: nada publicado ainda (a onda de release vem depois do
  aceite — ver `final-report.md` §12). **Bloqueado até a release wave.**
- **Verificação de integridade do visualizador pelo Forge CLI**: não há
  verbo dedicado; a integridade hoje vem da estrutura (hashes RECORD do
  wheel verificados pelo pip + sha256 único auditado aqui). **Parcial.**

## CASO A — spark-forge-aws, cenário ~3k (e maior)

Três camadas de evidência, todas re-executadas nesta spec:

1. **Harness node** (`the-forge/scripts/graphphysics_repro.py`, script de
   produção extraído por regex e rodado verbatim):
   - `graph_3000_chain` overview: **STABLE**, 316 lticks, 6,9 s wall,
     `non_finite=0`, `outside_10k=0`, 250 clusters →
     `the-forge/docs/graph/lf-0025-repro-3k.json`.
   - `graph_3000_chain` **full** (o cenário do P0 original): **STABLE**,
     3000/3000 renderizados, 352 lticks, `non_finite=0`, `max|coord|=1.783`
     → `the-forge/docs/graph/lf-0025-repro-3k-full.json`.

2. **Browser real** (Playwright + Chromium 156 headless,
   `the-forge/tests/test_graphstudio_e2e.py`, re-rodado nesta spec):
   `load 2.311 ms`, `settle 56.462 ms` (software-rendered), auditoria de
   coordenadas `non_finite=0`, **3000/3000 dentro do viewport após fit**,
   pan/zoom/click-inspect/search/export OK, **zero erros de console** →
   `the-forge/e2e/artifacts/graph-studio/*.png` +
   `the-forge/docs/graph/e2e-3k-metrics.json`.

3. **`graph ui` real sobre índice real** — índice codeintel do próprio
   spark-forge-aws construído por `graph build` (16.658 nós / 28.186
   arestas, 139,6 s — maior que o alvo de 3k): `graph ui` serviu a view
   (limit 5000 → overview 250 clusters) e o audit headless confirmou:
   settled, `non_finite=0`, **250/250 dentro após `f`**, click→inspector
   (`cl983`), busca `graph` → 8 hits, zoom clampado em [0.02,8],
   drill `x` honesto em cluster de 1 membro, zero erros de console →
   `forge-cli/docs/graph/case-a-cliui/` (4 PNGs + 2 JSONs).

Checklist FASE-12-A item a item: abre ✓, vértices aparecem ✓, layout
estabiliza ✓, vértices não desaparecem ✓ (auditoria + fit), zoom ✓, fit ✓,
seleção ✓, inspector ✓, busca ✓, navegação por arestas ✓ (inspector lista
vizinhos; BFS path ≤12 hops coberto pelos testes de modo), interface
responsiva ✓ (settle em overview ~7 s; slicing `SIM_MS=8`).

## CASO B — Forge Portal ao vivo contra dados de provider

Execução real (não só a suíte): bundle Angular **rebuildado** de
`forge-portal@release/2.2.2-certification` (`ng build` produção, 70 s) e
servido pelo `PortalServer` real de `sparkforge_aws` apontando para o
workspace `/tmp/lf0025-ws` (índice construído pelo wheel instalado).

- `GET /api/v1/graphs` (com `X-Forge-Session`) → `availability: available`,
  **6 nós / 3 arestas** — o mesmo documento que `graph view` emite
  (paridade byte-a-byte é pinnada por
  `spark-forge-aws/tests/test_portal_graph_parity.py`, verde).
- Playwright → `/?forge_session=<tok>` (bootstrap de sessão real) →
  `/graph`: a página "Graph Studio" renderizou o explorer
  (`spark-forge-aws · codeintel-graph — 6 nós · 3 arestas`), alternância
  **Lista→Canvas** montou o cytoscape (3 canvases), inspector por clique,
  **0 erros de console na carga e após 30 s de permanência** →
  `forge-cli/docs/graph/case-b-portal/` (`api-graphs.json`,
  `portal-live.json`, `portal-canvas.json`, 4 PNGs).
- Evidência de escala permanece a de lf-0023:
  `forge-portal/docs/graph/portal-parity.md` (matriz de paridade),
  `forge-portal/docs/perf/graph-federation-report.md` (10,2k nós
  federados: layout 5,6 s, select p50 18 ms, busca 4,7 ms).

## CASO C — Demais forjas (regressão)

Superficie de grafo por forja = módulo vendored + verbo `graph ui` +
suíte de grafos própria. Evidência:

| Forja               | byte-paridade               | serve-smoke (/_api_/405) | testes de grafo                                                       | `graph ui` no CLI                                                        |
| ------------------- | --------------------------- | ------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| the-forge           | canônico `a1cd735c…`        | OK (100n)                | 120 pass (graph*+studio+parity, e2e 4/4 separado)                     | `graph --view/--federated --ui`                                          |
| spark-forge-aws     | ✓                           | OK                       | **567 pass** (subset de grafos, 58 min)                               | `graph ui`                                                               |
| spark-forge-azure   | ✓                           | OK                       | **163 pass**                                                          | `graph ui`                                                               |
| api-forge           | ✓                           | OK                       | **137 pass**                                                          | `graph ui`                                                               |
| platform-forge      | ✓                           | OK                       | **34 pass**                                                           | `graph ui`                                                               |
| forge-doctor-api    | ✓                           | OK                       | **130 pass**                                                          | `graph ui`                                                               |
| forge-doctor-data   | ✓                           | OK                       | 121 pass, 3 skip (`packaged _data ausente` — ambiente, pré-existente) | `graph ui`                                                               |
| data-sentinel-forge | n/a — sem artefato vendored | n/a                      | n/a                                                                   | **não aplicável** — grafo SVG independente, fora do contrato (read-only) |

Serve-smoke: cada venv importou seu `*_graphstudio`, serviu um fixture
`ForgeGraphView/v1` real pelo próprio `_handler` e respondeu
`/`(200, 49 kB) + `/api/graphs` + `/api/graph/<id>` + POST→405.

`forge-portal`: `ng test` recorte de grafos — **74/74**
(`projection.spec` 13, `federated.spec` 13, `view-model.spec` 4,
`analysis.spec` 11, `graph.page.spec` 33). `ng build` produção verde.

## CASO D — Federação

**Bug real encontrado e corrigido nesta spec** (`the-forge/src/theforge/
graphview.py::_view_from_cli`): o subprocesso produtor herdava o cwd do
chamador — `<forge> graph view` resolve `--root .` contra o cwd, então
cada sibling procurava o índice **no diretório do the-forge** e recusava
("SF-GRAPH-NO-INDEX" etc.) mesmo com índice construído no próprio
checkout. Fix: `cwd=checkout` + teste de regressão
(`test_view_from_cli_runs_producer_in_its_own_checkout` — fake CLI codifica
`Path.cwd().name` no id do nó).

Antes: `theforge graph --federated --view` → 1 view (só the-forge), todas
as 6+1 siblings recusando. Depois, contra o workspace real:

| provider          |    nós | arestas | fonte                                                                    |
| ----------------- | -----: | ------: | ------------------------------------------------------------------------ |
| the-forge         |     11 |       0 | capability_view (canônico, sem cli_entry)                                |
| spark-forge-aws   |  5.000 |   1.194 | índice codeintel real (16.658 nós no db; `--limit 5000` do `graph view`) |
| spark-forge-azure | 11.995 |  35.693 | `graph build --root .` real                                              |

Total mesclado: **17.006 nós / 36.887 arestas**, proveniência preservada
(`source_provider` em todo nó; `provenance` por aresta
`spark-forge-aws/observed`, `spark-forge-azure/static`; ids namespacados
`provider:`). Ausências nomeadas, não fabricadas:
`api-forge AF-GRAPH-NOT-FOUND` (sem índice construído),
`platform-forge PF-GRAPH-NOGRAPH` (idem), `forge-doctor-*` e
`data-sentinel-forge` dialeto `graph view` não exposto (exit 2 — motivo
registrado em `federation-notes.txt`).

Evidência: `forge-cli/docs/graph/case-d-federation/` (`federated-views.json`,
`merged-view.json`, `federation-notes.txt`) + `the-forge/tests/
test_portal_graph_parity.py` + `federated.spec.ts`/`graph.page.spec.ts`
§5.6 (8 specs de federação verdes).

## Checklist §FASE 13 — item a item

| #   | Critério                                               | Status        | Evidência                                                                                          |
| --- | ------------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Bug de desaparecimento reproduzido ou causa comprovada | **verified**  | `reproduction.md` (star/hubs NaN t7–t8); pós-fix STABLE                                            |
| 2   | Física corrigida                                       | **verified**  | `fix-verification.md` + `test_graphstudio_physics.py` verde                                        |
| 3   | Câmera corrigida                                       | **verified**  | `fitToView` no load/Escape/resize; e2e 3000/3000 inside após `f`                                   |
| 4   | Repulsão quadrática eliminada/limitada                 | **verified**  | Barnes–Hut θ=0,9 N>500; 25k overview settle ~6,6 s                                                 |
| 5   | Lookup repetido de arestas corrigido                   | **verified**  | `G.byId` Map; audit.md→fix-verification.md                                                         |
| 6   | Renderização não bloqueia                              | **verified**  | `SIM_MS=8` time-slice; `raf_frames≫lticks` medido                                                  |
| 7   | Layout estável                                         | **verified**  | `settled=true` em 13/13 topologias + baseline 100..25k                                             |
| 8   | Coordenadas finitas                                    | **verified**  | `non_finite=0` em todo run (harness+browser+live)                                                  |
| 9   | Loops antigos cancelados                               | **verified**  | `gen` counter + `cancelAnimationFrame`; teste de lifecycle                                         |
| 10  | Resize funciona                                        | **verified**  | `onresize` debounce → `fitToView`; teste de storm                                                  |
| 11  | SQL e projeção de arestas consistentes                 | **verified**  | `graphview.py` janela alinhada (`ORDER BY qualified_name,id` + filtro `keep`); `test_graphview.py` |
| 12  | Vértices não desaparecem silenciosamente               | **verified**  | truncamento → `#notice`; resets contados no footer; auditoria 0/inside                             |
| 13  | Modo overview existe                                   | **verified**  | `computeClusters` ≤250, auto >2000; matriz lf-0022                                                 |
| 14  | Expansão progressiva existe                            | **verified**  | `exploreSet`/`expandNode`/`x` + drill breadcrumbs; testes de modo                                  |
| 15  | Inspector de vértices e arestas                        | **verified**  | e2e click→`#ibody`; specs do portal; live Case A/B                                                 |
| 16  | Busca e filtros funcionam                              | **verified**  | `/`+Enter hits; kind checkboxes; e2e + portal specs                                                |
| 17  | Portal possui Graph Explorer integrado                 | **verified**  | rota `/graph`, `graph.page.spec.ts` 33/33, live Case B                                             |
| 18  | Graph UI e Portal dados equivalentes                   | **verified**  | paridade byte-a-byte (`test_portal_graph_parity.py` ×2 repos)                                      |
| 19  | Navegação funciona nos dois                            | **verified**  | e2e CLI (pan/zoom/inspect/search) + specs portal (canvas/inspector)                                |
| 20  | Grafos grandes testados                                | **verified**  | baseline 100..25k (overview 25k settle ~6,6 s) + live 16,6k                                        |
| 21  | Testes Playwright passaram                             | **verified**  | `test_graphstudio_e2e.py` 4/4 re-rodado nesta spec                                                 |
| 22  | Screenshots e métricas armazenados                     | **verified**  | `the-forge/e2e/artifacts/graph-studio/`, `docs/graph/*.json`, `case-*/` aqui                       |
| 23  | Recursos frontend empacotados                          | **verified**  | matriz de wheels 7/7 + guarda durável no artifact-contents                                         |
| 24  | Instalação wheel-only funciona                         | **verified**  | venv limpo + `graph ui` servindo (ver FASE 11 acima)                                               |
| 25  | CI está verde                                          | **simulated** | gates locais verdes nos repos tocados; CI real corre após push (não publicado)                     |
| 26  | Documentação atualizada                                | **verified**  | `docs/graph/*` (5 docs + este + final-report) + parity/perf docs no portal                         |
| 27  | Nenhuma regressão nas demais forjas                    | **verified**  | tabela do Caso C — 1.152 testes de grafo verdes nas 7 forjas                                       |

Itens §FASE-11 auxiliares: dependências locais ✓ (PyYAML+jsonschema);
ausência de clone ✓; ausência de CDN ✓; suporte Windows/Git Bash
**simulado** (sem Windows local; caminho portável por construção, gate de
wheel roda Windows no CI); versão do bundle ✓ (sha256 único);
compatibilidade Portal ✓ (Caso B ao vivo); reprodutibilidade ✓ (3 builds
bit-a-bit).
