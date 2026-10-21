# Reprodução do P0 — `graph ui`: vértices aparecem, se espaçam, desaparecem

Spec lf-0020, FASE 0. **Veredito: REPRODUZIDO com evidência sobre o código de
produção real.** Causa-raiz: instabilidade numérica da mola quadrática +
rajada de repulsão de curta distância em topologias com concentração de grau,
sem nenhum guarda `Number.isFinite` para interromper a divergência.

## Método (por que isto prova o código real)

1. `the-forge/scripts/graphphysics_repro.py` extrai o `<script>` inline de
   `theforge/graphstudio.py` com o mesmo regex do gate de sintaxe
   (`tests/test_graphstudio.py::test_studio_inline_script_parses`) — o texto
   executado é o código de produção, não uma reimplementação
   (`extracted_script_sha256` em cada relatório).
2. O script é embrulhado num `.mjs` gerado que stuba só o DOM (canvas 2-D,
   `document`, `requestAnimationFrame` capturado num slot, `fetch` servindo o
   fixture pelos endpoints reais `/api/graphs` e `/api/graph/<id>`) e fixa
   `Math.random` (mulberry32) — a cadeia `loadGraph → tick → draw` que roda é
   a mesma do browser.
3. O driver drena `loadGraphs()` e replaya a cadeia RAF de forma síncrona por
   N ticks, amostrando coordenadas: `non_finite` (NaN/±Inf em x/y/vx/vy),
   `max_abs_coord`, fração fora de um viewport de 10.000 px, wall-time/tick.
4. Datasets: `spark-forge-aws/tests/graph/make_fixtures.py`, determinísticos
   byte a byte (`--check` confirma), ForgeGraphView/v1 validado por
   `ForgeGraphView.from_dict`.

Ambiente da medição: node v22.23.2, Python 3.12.3, Linux x86_64, HEADs em
`audit.md`. Reports completos: `/tmp/repro_3000_*.json` na máquina da
auditoria (regenerável com o comando abaixo).

```bash
python the-forge/scripts/graphphysics_repro.py \
  --fixture spark-forge-aws/tests/graph/fixtures/graph_3000_star.json \
  --ticks 600 --out report.json
```

## Resultado na matriz 3.000 nós × 13 topologias (--ticks 600)

| Topologia                          | Veredito        | Blow tick | non_finite final | max \|coord\|    | fora 10k | tick médio |
| ---------------------------------- | --------------- | --------- | ---------------- | ---------------- | -------- | ---------- |
| chain                              | estável         | —         | 0/3000           | 488 px           | 0        | 137,5 ms   |
| **star**                           | **REPRODUZIDO** | 2         | **3000/3000**    | — (tudo NaN/Inf) | —        | 76,4 ms    |
| tree                               | estável         | —         | 0                | 474 px           | 0        | 147,9 ms   |
| mesh                               | estável         | —         | 0                | 487 px           | 0        | 193,9 ms   |
| dense-communities (18.049 arestas) | estável         | —         | 0                | 498 px           | 0        | 318,8 ms   |
| disconnected                       | estável         | —         | 0                | 485 px           | 0        | 153,5 ms   |
| **high-degree-hubs**               | **REPRODUZIDO** | 3         | **975/3000**     | 2,8×10³⁰⁵        | 2025     | 155,9 ms   |
| heterogeneous                      | estável         | —         | 0                | 410 px           | 0        | 121,8 ms   |
| isolated-components                | estável         | —         | 0                | 482 px           | 0        | 103,6 ms   |
| parallel-edges                     | estável         | —         | 0                | 486 px           | 0        | 177,5 ms   |
| cycles                             | estável         | —         | 0                | 488 px           | 0        | 153,1 ms   |
| long-labels                        | estável         | —         | 0                | 488 px           | 0        | 151,3 ms   |
| heavy-metadata                     | estável         | —         | 0                | 488 px           | 0        | 96,1 ms    |

Leitura: **não é qualquer grafo de 3k que explode — é concentração de grau**.
Estrela e hubs (a forma real de um grafo codeintel: um arquivo contém
centenas de símbolos, uma função é chamada por milhares) divergem em <10
ticks; cadeia/árvore/malha/comunidades estabilizam num raio de ~500 px.

## A linha do tempo da explosão (star, 3.000 nós)

| tick                   | max \|coord\| | non_finite | fora 10k | leitura                                                                                       |
| ---------------------- | ------------- | ---------- | -------- | --------------------------------------------------------------------------------------------- |
| 0 (fim do `loadGraph`) | 4,14×10⁴ px   | 0          | 1        | a rajada inicial de repulsão já jogou um vértice a 41k px — fora de qualquer canvas           |
| 2                      | 2,50×10¹⁷     | 0          | 3000     | todos fora do viewport de 10.000 px — "desapareceram" para o usuário                          |
| 3                      | 2,74×10³⁴     | 0          | 3000     | expoente dobrando a cada tick — mola ∝ d²                                                     |
| 4                      | 3,31×10⁶⁸     | 0          | 3000     |                                                                                               |
| 5                      | 4,81×10¹³⁶    | 0          | 3000     |                                                                                               |
| 6                      | 1,02×10²⁷³    | 0          | 3000     |                                                                                               |
| 7                      | —             | **3000**   | —        | coordenadas estouram float64 → ±Infinity → Inf−Inf → **NaN**; `ctx.arc(NaN)` não desenha nada |

A sequência reproduz 1:1 o relato: vértices **aparecem** (caixa inicial
±300 px) → **se espaçam violentamente** (rajada de repulsão + recuo da mola)
→ **desaparecem** (coordenadas além do viewport em 2 ticks, NaN em ~7). A
~76-137 ms/tick isso é <1 s de tela — consistente com "abre, espaça, some".

Em high-degree-hubs a mesma assinatura: blow no tick 3, max 1,1×10⁴³ →
2,4×10⁸⁴ → 1,1×10¹⁶⁷ → 2,8×10³⁰⁵, 975 nós já NaN no tick 8 (o resto segue).

## Saturação da main thread (todas as topologias)

Mesmo quando estabiliza, o tick é O(N²): 4,5M pares a 3.000 nós.

| n (chain) | tick médio                | fps equivalente    |
| --------- | ------------------------- | ------------------ |
| 100       | 0,8 ms                    | ~60                |
| 500       | 3,2 ms                    | ~60                |
| 1.000     | 10,3 ms                   | ~60                |
| 3.000     | 96–319 ms (por topologia) | **3–13**           |
| 10.000    | 1.117 ms                  | **<1**             |
| 25.000    | 13.224 ms (13,2 s)        | **0,08** — travada |

Cada tick redesenha com `G.nodes.find()` por aresta (O(E·N) extra) — em
dense-communities (18k arestas) o tick médio sobe a 319 ms. Em browser real o
RAF roda "o mais rápido possível", mas cada frame continua custando isso —
interação congela durante a explosão. `draw()` ainda realoca o canvas quando
`cv.width` compara com fração (linha 113 do canônico).

## Veredito por causa candidata (§0.1)

| Causa candidata                                  | Veredito                      | Evidência                                                                                                                                               |
| ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instabilidade numérica (NaN/±Infinity)           | **PROVADA**                   | 3000/3000 non_finite no tick 7 (star); 975 no tick 8 (hubs)                                                                                             |
| Coordenadas extremas / explosão de layout        | **PROVADA**                   | 2,5×10¹⁷ no tick 2; expoente dobra por tick                                                                                                             |
| Vértices fora do viewport sob câmera fixa        | **PROVADA**                   | 3000/3000 fora da caixa de 10k px já no tick 2; studio não tem fit-to-view                                                                              |
| Expansão progressiva dos vértices                | **PROVADA** (mesmo mecanismo) | amostras por tick mostram a fuga contínua                                                                                                               |
| Saturação da main thread                         | **PROVADA**                   | 137 ms médio/tick a 3k (≤7 fps); 1.117 ms a 10k                                                                                                         |
| Interrupção do RAF                               | descartada                    | `raf_starved=false` em todos os runs                                                                                                                    |
| Erros JS não tratados                            | descartada                    | nenhuma exceção alcançou o driver                                                                                                                       |
| Reinicialização indevida do layout               | não medida                    | run único; empilhamento de RAF por `loadGraph` é contribuinte conhecido (`running` nunca desarma) mas não necessário — a explosão ocorre num único load |
| Canvas fora da área / resize / perda de contexto | não medida                    | sem DOM real no harness                                                                                                                                 |
| Limites de memória                               | não medida                    | não instrumentado                                                                                                                                       |

## Limite honesto do harness

Headless cobre física e sanidade de coordenadas — não cobre compositor,
zoom/pan real, memória do browser ou resize. O que o relato do usuário exige
(aparecer → espaçar → sumir) está integralmente coberto e **reproduzido duas
vezes em topologias distintas**, com controle negativo (chain/árvore/malha
estabilizam no mesmo harness).

## Como refazer

```bash
# datasets (byte-idênticos; --check verifica)
python spark-forge-aws/tests/graph/make_fixtures.py          # matriz inteira
python spark-forge-aws/tests/graph/make_fixtures.py --check  # confere bytes

# reprodução
python the-forge/scripts/graphphysics_repro.py \
  --fixture spark-forge-aws/tests/graph/fixtures/graph_3000_star.json --ticks 600

# gate de regressão (skips sem node)
python -m pytest the-forge/tests/test_graphstudio_physics.py
```

Sem correção de produção nesta spec — lf-0021 corrige `graphstudio.py` e faz
flip do assert `non_finite > 0` para exigir coordenadas finitas.
