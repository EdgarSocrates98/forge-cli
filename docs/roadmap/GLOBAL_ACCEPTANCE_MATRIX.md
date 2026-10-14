# Global Acceptance Matrix — §12 (spec 008)

25 critérios, evidência citada por linha. Regra §13: nenhum PASS sem evidência.
Veredito geral no rodapé.

| #   | Critério                                          | Resultado             | Evidência                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Instalação contextual funcional                   | PASS                  | `install --plan` ladder real (clone→env→configs→prereqs→script→verify) em workspace limpo `E:\tmp\forge-hom-a`; Gate C2 instalou forge-doctor-api ponta-a-ponta com `.env` preservado idempotente                                                                                        |
| 2   | Env Intelligence valida/migra com segurança       | PASS                  | `src/envintel/` inspect/plan/init/validate/migrate/doctor; `envDoctor`, `planMigration`, `rollbackEnv`; `.env` values nunca exibidos/digestados; Gate C5: `API_TOKEN` append ficou `REVIEW_REQUIRED` e não foi aplicado sem confirmação                                                  |
| 3   | Host Intelligence distingue detecção de validação | PASS                  | `src/hosts/` adapters por host; `detectAll()` → tri-state `verified                                                                                                                                                                                                                      | absent                                                    | unknown`; C4: codex verified, claude integrated/auth unknown, devin/copilot `null` — nenhuma integração inventada |
| 4   | Portal apresenta dados reais                      | PASS                  | Dashboard/explorer/studios consomem adapter `forge/PortalApi/1`; 221 ng tests + 69 pytest; F0: 12 Chromium E2E no browser real                                                                                                                                                           |
| 5   | Portal permite inspeção+operação segura           | PASS                  | Tasks center: intent→plan→confirmação→execute→receipt; read-only por default; ops mutantes exigem plan token + confirmação (api-forge `POST /tasks/plan                                                                                                                                  | execute`)                                                 |
| 6   | MCP Explorer verifica integrações reais           | PASS                  | MCP studio faz handshake real sem invocar tools (C4); Portal só exibe tools/resources/prompts quando o adapter fornece evidência; handshake/latency honestos (HTTP round-trip rotulado)                                                                                                  |
| 7   | Skills/Agents Studio refletem catálogos reais     | PASS                  | api-forge `portal_adapter.py` lê catálogo real do repo (incl. fix de block-scalars `>-`/`                                                                                                                                                                                                | `, testado); studios marcam colisões sem fundir entidades |
| 8   | Doctor identifica problemas + planos de reparo    | PASS                  | `src/doctor2/` 5 domínios, `forge/DoctorReport/v1`, health score gated (`HEALTH_MODEL.md`); Gate C5: fault real detectado, `heal` plan+receipt                                                                                                                                           |
| 9   | Execution Center registra operações+evidências    | PASS                  | Portal `/tasks` history+receipts com correlation IDs; CLI `heal` receipts `.forge-cli/receipts/` imutáveis; api-forge task records                                                                                                                                                       |
| 10  | Graph Studio federado reutiliza infra existente   | PASS                  | `src/app/core/graph/federated.ts` estende o engine existente (zero engine nova); overlay sobre views por-Forja; evidence tags + unverified marking; 19 tests                                                                                                                             |
| 11  | IA opcional, nunca requisito                      | PASS                  | `keyless-gate.test.ts` stripa todo *KEY/TOKEN/SECRET do env e prova engine/predict/context/ai-disabled; `forge ai` sem bridge → `disabled` tipado, fluxo determinístico continua                                                                                                         |
| 12  | Fluxos offline funcionam conforme documento       | PASS_WITH_LIMITATIONS | `--offline` → `fixed-ref` sem rede ou erro explícito; bundle export/verify íntegro com 0 valores de segredo; **limitação**: plan preview ainda exibe `git pull` com `--offline` (cosmético, P3)                                                                                          |
| 13  | Forjas independentes                              | PASS_WITH_LIMITATIONS | `forge-doctor-api` roda `pytest` standalone sem CLI/Portal — **862/863 pass**; program não modificou consumer Forjas. **Limitação**: defect real encontrado — `test_malformed_stdio_input_resilient` (server MCP morre em input malformado), pré-existente, P2 fora do escopo CLI/Portal |
| 14  | Sem dependência circular                          | PASS                  | CLI não importa Portal; Portal não importa CLI; adapters são fornecidos pela Forja consumida (`forge/PortalApi/1`); `independence.test.ts` + vendored module byte-parity F0                                                                                                              |
| 15  | Contratos versionados                             | PASS                  | `forge/<Name>/v1` JSON Schemas em `forge-cli/contracts/schemas/` + validator Python vendorizável (`forge_contracts.py`); `forge/DoctorReport/v1`, `forge/RepairReceipt/v1`, `forge/ForgeContext/v1`, `forge/AiProposal/v1`, `forge/IntegrityManifest/v1`, `forge-cli/Bundle/v1`          |
| 16  | Testes de segurança aprovam                       | PASS                  | `tests/test_security_c5.py` 24/24 (sessão, CSRF, origin, host-header, rate-limit, traversal, symlink, RCE-inerte, SSRF, CRLF, secrets, plan replay/expired/cross-plan, cancelamento, concorrência, payload cap); keyless-gate + ai-sanitize no CLI                                       |
| 17  | Unit + integração aprovam                         | PASS                  | CLI 598/598 (46 files); Portal 221/221 (26 files) + 69/69 pytest; api-forge adapter 22/22                                                                                                                                                                                                |
| 18  | E2E crítico com evidências                        | PASS_WITH_LIMITATIONS | `E2E_HOMOLOGATION.md` A–G com evidência real; B tem limitação (DemoAdapter + contract real via api-forge tests, sessão browser contra Forja real não re-executada)                                                                                                                       |
| 19  | Sem botões fictícios                              | PASS                  | Portal: toda ação ou executa de verdade ou mostra `UNVERIFIED`/comando copiável; CLI: `heal` sem REVIEW_REQUIRED aplicado prova que botões não fingem                                                                                                                                    |
| 20  | Sem métricas inventadas                           | PASS                  | `PERFORMANCE_BASELINE.md` — só medianas de execuções reais; health score gated por suficiência; nada afirmado sem benchmark                                                                                                                                                              |
| 21  | Sem erros silenciados                             | PASS                  | checks `unverified` explicitados; adapter failures viram `ApiError` tipados com `code`; refusal codes verbatim na UI; falhas de domínio doctor2 viram check `unverified`, não omissão                                                                                                    |
| 22  | Sem vazamento de segredos                         | PASS                  | context 3-layer hygiene (denylist→redact→SECRET_VALUE_RE); bundle recusa whitelist de chave secreta (`SecretKeysRefusedError` antes de escrever); `env-values.json` ausente no bundle real; logs+receipts via `redactSecrets`; tests `ai-sanitize`/`keyless-gate`/`secret_keys_redacted` |
| 23  | Releases preservam compatibilidade                | PASS_WITH_LIMITATIONS | `analyzeBumps`/`classifyBump` semver; `COMPATIBILITY_MATRIX.md` desde F0; `predict` emite `breaking-change` com evidência; **limitação**: sem signing de release (P2)                                                                                                                    |
| 24  | Documentação reflete comportamento real           | PASS                  | ADRs + reports por ciclo citam comandos e saídas reais; THREAT_MODEL lista o gap de sessão abertamente; PORTABILITY/LEARNING_EVAL documentam o que NÃO foi implementado                                                                                                                  |
| 25  | Cada ciclo tem relatório de homologação           | PASS                  | `CYCLE_C1_REPORT.md`, `C2`, `C4` (portal), `C5` (cli+portal), `C6` + `BASELINE_AUDIT` F0; esta matriz é o close-out                                                                                                                                                                      |

## Maturidade final (§16) — baseline F0 → agora

| Capacidade    | F0 baseline                     | Pós-programa                                           |
| ------------- | ------------------------------- | ------------------------------------------------------ |
| Descoberta    | inexistente                     | bounded walk + sinais + probes (2.7 s medido)          |
| Recomendação  | inexistente                     | determinística explicável, confidence score            |
| Instalação    | plan→confirm→execute já existia | +wizard 7 passos + native dispatch + plan hash         |
| `.env`        | preservação apenas              | schema/inspect/plan/migrate/rollback/doctor            |
| Hosts/MCP     | inexistente                     | adapters por host, lifecycle ladder, validate+rollback |
| Doctor        | checks esparsos                 | 5 domínios, score gated, repair flow 8 passos          |
| Portal        | 12 páginas, dados limitados     | 16 rotas, studios, tasks, observe, versions, fed-graph |
| IA            | inexistente                     | opt-in BYOK, zero-execução, sanitize tripla            |
| Portabilidade | inexistente                     | bundle+integridade+reinstall plan                      |
| Segurança     | boa base server                 | +24-test security suite + threat model + plan tokens   |
| Testes        | 296 CLI / 11+45+12 portal       | 598 CLI / 221+69 portal / 22 api-forge adapter         |

## Veredito §13

**PASS_WITH_LIMITATIONS**.

P0: nenhum.
P1: nenhum.
P2: cross-process run lock (cenário G); TTL de sessão Portal (threat #19);
signing de release (threat #17); defect MCP-boundary do
forge-doctor-api (`test_malformed_stdio_input_resilient` — server morre
em input malformado; escopo do especialista, spec própria recomendada).
P3: preview de plano não reflete `--offline` cosmeticamente; resiliência de
memory sob carga não medida (baseline honesto sem afirmação).

Todos os P2/P3 estão registrados — nenhum escondido.
