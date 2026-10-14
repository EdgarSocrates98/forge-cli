# Performance Baseline — §10 (spec 008)

Medido em 2026-10-14, Windows 11, Node v24.16.0, Python 3.14.6, workspace
`E:\projetos\FORJAS` (8 Forjas). Método reproduzível: `node dist/index.js <cmd>`
via `execFileSync`, 3–5 medições por métrica, mediana reportada. Nenhuma
afirmação percentual sem benchmark reproduzível (§10).

## Forge CLI (c6 HEAD)

| Métrica                   | Mediana  | Amostras (ms)        | Observação                                            |
| ------------------------- | -------- | -------------------- | ----------------------------------------------------- |
| startup `--version`       | 339 ms   | 366, 333, 339        | inclui boot do Node                                   |
| startup `help`            | 335 ms   | 333, 341, 335        | render completo da ajuda                              |
| `discover --json`         | 2672 ms  | 3932, 2653, 2672     | varredura limitada (5000 entradas), probes de host    |
| `env inspect --json`      | 116 ms   | 146, 116, 110        | leitura + schema, sem rede                            |
| `predict --json`          | 10720 ms | 10720, 14303, 10448  | inclui discovery + probes de host + envintel por repo |
| `context --json`          | 6538 ms  | 6538, 5672, 10145    | discovery + doctor2 + hosts; saída 1976 B             |
| `doctor --json` (gate c5) | 1897 ms  | single               | 25 checks em workspace pequeno                        |
| bundle `dist/`            | 708 KB   | —                    | index.js 722.332 bytes                                |
| `npm test` (suite)        | ~42 s    | 46 files / 598 tests | vitest isolado                                        |

## Forge Portal (c5 HEAD)

| Métrica                   | Valor                | Método                                     |
| ------------------------- | -------------------- | ------------------------------------------ |
| bundle browser total      | 726.2 KB             | `du` sobre `dist/forge-portal-app/browser` |
| entry `main-*.js`         | 313 KB               | arquivo inicial                            |
| import `portal_core`      | 48 ms                | `import portal_core.forge_portal`          |
| `GET /api/descriptor`     | 78 ms cold → 2–10 ms | urllib no loop, DemoAdapter                |
| `GET /api/capabilities`   | 2–26 ms              | idem                                       |
| `GET /` (index)           | 1–6 ms               | idem                                       |
| `npm test`                | ~45 s                | 26 files / 221 tests                       |
| `python -m pytest tests/` | ~2.7–3.2 s           | 69 tests (incl. 24 de segurança)           |
| `npm ci`                  | ~2 min               | 278 pacotes                                |

## Leituras

- `predict`/`context` pagam o custo de probes de host e discovery completos —
  é o preço honesto de evidência real; ambos são comandos de diagnóstico,
  não hot-path.
- `env inspect` sub-150 ms — o caminho de .env é leve por design.
- Portal serve APIs em single-digit ms pós warm-up; o primeiro hit inclui
  bind+session e é uma vez por processo.
- Overhead de observabilidade (receipts, history, metrics) é I/O local de
  JSON pequeno — não medível separadamente acima do ruído (<5 ms/op).

## Pendências de medição (honestas)

- Portal cold-start em máquina sem cache npm — não medido (ambiente único).
- Memória residente sob carga concorrente — não medido; registrado como
  pendência P3, sem afirmação inventada.
