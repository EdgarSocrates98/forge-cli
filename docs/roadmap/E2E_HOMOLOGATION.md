# E2E Homologation — Scenarios A–G (§9.4, spec 008)

Ambiente: Windows 11, Node v24.16.0, Python 3.14.6, git disponível, rede
disponível (exceto onde bloqueada explicitamente). Regra §14.3: resultado
real ou `UNVERIFIED`+causa — nunca mock para parecer verde.

## Scenario A — primeira instalação (máquina limpa)

**Passos executados** (workspace `E:\tmp\forge-hom-a`, vazio):

1. `forge-cli --dir E:/tmp/forge-hom-a --plan --yes --only forge-doctor-api --json`
   → preflight (git/node/python/powershell ✓) → plano em 7 passos
   (clone → .env modelo → configs → prereqs python>=3.11 → setup.ps1 →
   npm skip → `forge-doctor-api --help`).
2. Instalação real completa executada no Gate C2 (evidência arquivada):
   clone + bootstrap + `.env` preservado em re-run idempotente +
   verificação + receipt. `E:\tmp\forge-c5-gate` manteve estado: re-run de
   `doctor` em 2026-10-14 → 25 checks, **0 fail**.
3. Host integration: `hosts list`/`hosts plan claude` produzem comando
   copiável + merge plan (C2/C4 evidência).

**Resultado: PASS** — fluxo detect→select→plan→bootstrap→env→verify
comprovado em workspace limpo; evidência em `CYCLE_C2_REPORT.md` +
`CYCLE_C5_REPORT.md`.

## Scenario B — Portal (descriptor→capabilities→receipt)

**Passos executados**:

1. `PortalServer(DemoAdapter)` servido em thread real (stdlib http.server):
   `GET /` 1–6 ms, `GET /api/descriptor` 78 ms cold→2 ms, `GET /api/capabilities`
   2–26 ms — latências reais medidas (PERFORMANCE_BASELINE.md).
2. Suite `tests/test_forge_portal.py` + `test_portal_e2e_harness.py`
   (69 pytest) cobre descriptor→capabilities→op→receipt com plan tokens.
3. Adapter real de api-forge: 22 tests passando (`tests/test_portal_adapter.py`,
   PR api-forge#75) — contract `forge/PortalApi/1` validado fora do mock.
4. 12 testes Chromium E2E do F0 (plan→apply via browser real).

**Resultado: PASS_WITH_LIMITATIONS** — ponta-a-ponta provado com DemoAdapter

- contract do adapter real via pytest de api-forge; uma sessão de browser
  real contra a Forja api-forge em produção não foi repetida nesta homologação
  (evidence histórica existe).

## Scenario C — independência das Forjas

**Passos executados**: `cd forge-doctor-api && python -m pytest tests/ -q` —
suite própria do especialista, sem forge-cli/forge-portal no caminho,
sem instalação via CLI, sem adapter envolvido.

**Resultado real**: **862 passed, 1 failed** em 192 s.

Falha reproduzível (2ª ocorrência — também observada na run interrompida
em ~47%): `tests/test_mcp_boundary.py::test_malformed_stdio_input_resilient`
(linha 322) — o servidor MCP stdio do especialista **morre ao receber input
malformado** em vez de responder com erro; `queue.Empty` após 90 s de
espera pela resposta. Defeito pré-existente de robustez no boundary MCP
do forge-doctor-api — este programa não tocou esse repo (working tree:
`ahead 99, behind 2`, deleções não relacionadas a este trabalho).

**Registro**: pendência **P2** — defect encontrado durante homologação,
escopo do especialista (não bloqueia release do CLI/Portal, que são os
artefatos deste programa); follow-up recomendado como spec própria no
repo forge-doctor-api. Não corrigido aqui por §14.3.

**Resultado: PASS_WITH_LIMITATIONS** — invariante §0.3 provado: 862/863
testes do toolchain próprio executam standalone sem qualquer CLI/Portal
no caminho; a limitação é o defect real acima, registrado, não escondido.

## Scenario D — recovery (falha parcial → plano → repair → receipt)

**Passos executados** (Gate C5, `E:\tmp\forge-c5-gate`):

1. Falha injetada: `.forge-cli/` ausente + `API_TOKEN` faltando no `.env`.
2. `doctor` → score 94, checks fail/warn/unverified estruturados.
3. `heal --plan` → `SAFE_AUTOMATIC` (dirs) + `REVIEW_REQUIRED` (.env append).
4. `heal --yes` → só SAFE_AUTOMATIC aplicado; `.env` skipped aguardando
   revisão; receipt `heal-2026-10-14T04-02-35-209Z.json` gravado.
5. Re-`doctor` → score 97, diretórios verificados, segredo não tocado.

**Resultado: PASS** — repair parcial cirúrgico, gate de revisão honrado,
receipt imutável.

## Scenario E — offline

**Passos executados**:

1. `syncRepo` com `--offline`: clone existente → `fixed-ref` sem fetch/pull;
   ausente → erro explícito `modo offline: não está clonada localmente`
   (zero rede, honesto).
2. `bundle export` (workspace FORJAS) → `forge-cli/Bundle/v1`: 8 pins,
   env-keys só nomes, `env-values.json` **ausente** — zero segredos.
3. `bundle verify` → integrity sha256 verificado, íntegro.
4. `planReinstall` → `forge/ForgeOperationPlan/v1` real dos pins.

**Limitação observada**: o plan preview mostra `git pull --ff-only` mesmo
com `--offline` (preview genérico; a execução honra offline) — pendência P3.

**Resultado: PASS_WITH_LIMITATIONS** — offline real p/ componentes já em
cache/clones; bundle offline completo com integridade; preview cosmeticamente
não reflete a flag.

## Scenario F — compatibilidade (capabilities divergentes)

**Passos executados** (C4, `hosts list` real):

- codex `verified` via probe real; claude `integrated` auth `unknown`;
  devin/copilot `null`/UNVERIFIED — nenhuma capacidade inventada.
- Portal: operações não suportadas renderizam `UNVERIFIED`; refusal codes
  verbatim; colisões de nome marcadas sem merge.

**Resultado: PASS** — nenhuma ação é oferecida onde o adapter não expõe
evidência (padrão fail-closed em todos os studios).

## Scenario G — concorrência

**Passos executados / evidência**:

- `--jobs` bounded 1–8, pool de workers sobre fila — repos disjuntos dentro
  de uma run, nunca dois workers no mesmo repo (runner.ts:290+).
- Escritas atômicas (`writeFileAtomic` pid+tmp), receipts imutáveis,
  plan tokens hash+expiry.
- **Não existe lock cross-process** — dois processos CLI no mesmo target
  podem colidir (atomic writes reduzem corrupção, não há mutex).

**Resultado: PASS_WITH_LIMITATIONS** — intra-run bounded+disjoint provado;
cross-process lock ausente → pendência P2 registrada (não corrigida na
homologação por §14.3 — homologação descobre, não remenda).

## Resumo

| Cenário           | Resultado             |
| ----------------- | --------------------- |
| A install limpa   | PASS                  |
| B portal          | PASS_WITH_LIMITATIONS |
| C independência   | PASS_WITH_LIMITATIONS |
| D recovery        | PASS                  |
| E offline         | PASS_WITH_LIMITATIONS |
| F compatibilidade | PASS                  |
| G concorrência    | PASS_WITH_LIMITATIONS |

Nenhum BLOCKED, nenhum cenário pulado por falta de ferramenta sem causa
registrada.
