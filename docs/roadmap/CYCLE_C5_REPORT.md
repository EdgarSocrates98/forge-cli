# Cycle C5 Report — Operations & Observability (forge-cli)

Spec: `factory/specs/active/006-c5-operations-observability.md` · Branch: `cycle/c5-operations`

## Resumo

Doctor 2.0 (5 domínios, score de saúde com gate), self-healing com 4 classes de risco e
fluxo de 8 passos, execução aprovada com receipts/correlation-ids, observabilidade local,
version manager offline-safe. Todas as decisões §5.x implementadas no CLI; Portal cobre
observe/versions/federated-graph/security-matrix no seu próprio report.

## O que mudou

- `src/doctor2/` — modelo `forge/DoctorReport/v1`, contexto determinístico, 5 domínios
  (system, installation, environment, hosts, operations), render PT-BR, health score
  gated (só emitido com dados suficientes + pesos documentados em `HEALTH_MODEL.md`).
- `src/heal/` — risk classes `SAFE_AUTOMATIC | REVIEW_REQUIRED | MANUAL_ONLY | UNSUPPORTED`,
  fluxo Diagnose→Identify→Plan→Assess→Confirm→Apply→Verify→Receipt, plan tokens com
  hash + expiração (TOCTOU/replay protection), receipts `forge/RepairReceipt/v1` em
  `.forge-cli/receipts/`.
- `src/cmd/doctor2.ts` + wiring em `commands.ts`/`index.ts` — `forge doctor` (upgrade
  in-place) e `forge heal [--plan|--yes|--apply <id>]`. `--yes` aplica **apenas**
  SAFE_AUTOMATIC; REVIEW_REQUIRED exige `--apply` explícito (proven in gate).
- `tests/doctor2.test.ts`, `tests/heal.test.ts` — 47 novos testes (483 total).
- `docs/roadmap/HEALTH_MODEL.md` — pesos e condição de suficiência do score.

## Verificação (spec frontmatter)

| Comando                  | Resultado                   |
| ------------------------ | --------------------------- |
| `npm run typecheck`      | ✅ clean                    |
| `npx eslint src/ tests/` | ✅ clean                    |
| `npx prettier --check`   | ✅ clean                    |
| `npm test`               | ✅ 36 files / **483 tests** |

## Gate C5 — evidência real (workspace `E:\tmp\forge-c5-gate`)

Falhas injetadas: `.forge-cli/` ausente + `API_TOKEN` declarada no schema mas ausente no `.env`.

1. `forge doctor` → `environment.env.missing-key warn`, `installation.forge-dir.absent fail`,
   host auth `unverified`, lockfile drift `unverified`. Score **94** (não 100 — honesto).
2. `forge heal --plan` → plano com `API_TOKEN=` como **REVIEW_REQUIRED**, criação de
   diretórios `.forge-cli` como **SAFE_AUTOMATIC**.
3. `forge heal --yes` → 5 diretórios criados e verificados; `.env` **skipped** aguardando
   confirmação; receipt `heal-2026-10-14T04-02-35-209Z.json` gravado com ambos os outcomes.
4. `forge doctor` pós-repair → score **97**, `forge-dir.absent pass`, `API_TOKEN` ainda
   ausente — provando que o gate de revisão foi honrado.

## Riscos restantes

- Health score depende de checks `unverified` honestos — documentado em HEALTH_MODEL.md.
- `MANUAL_ONLY`/`UNSUPPORTED` são diagnosticados mas nunca aplicados (by design).
- Telemetria remota: nenhuma — métricas são locais-only por padrão (off switch trivial).
