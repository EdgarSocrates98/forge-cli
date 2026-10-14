# Cycle C6 Report — Advanced Intelligence (forge-cli)

Spec: `factory/specs/active/007-c6-advanced-intelligence.md` · Branch: `cycle/c6-intelligence`

## Resumo

Forge Intelligence Engine de 3 domínios sobre o core determinístico, modo IA
opcional (opt-in/BYOK/sem provider embutido), contexto estruturado limitado
à prova de segredos, compatibilidade preditiva com evidência+versão+certeza,
portabilidade completa (bundle + integridade + reinstall) e aprendizado local
opt-in avaliado. Nada exige chave, rede ou modelo.

## O que mudou

- `src/intel/engine.ts` — 12 respostas §6.1 (5 discovery, 4 recommendation,
  3 repair), cada uma com `evidence[]`, `confidence`, `explanation[]` (rule IDs)
  e `limitations[]`; ordenação por comparator determinístico.
- `src/intel/context.ts` — `forge/ForgeContext/v1`: stack, runtimes,
  capabilities declaradas, forjas, hosts (auth tri-state), config não-secreta,
  diagnósticos top-N, planos ativos (hash+expiry verificados) e budget.
  Higiene tripla de segredos: denylist de chave → `redactSecrets` →
  `SECRET_VALUE_RE` (sk-live/ghp_/JWT/AKIA/xox sob chaves inocentes).
- `src/intel/predict.ts` — §6.5: `schema-change`, `breaking-change`,
  `runtime-incompat`, `host-version`, `renamed-var`, `obsolete`,
  `install-conflict` — silêncio sem evidência; `version{from,to}`+`certainty`.
- `src/ai/` — `sanitize.ts` (denylist+redact+assertNoSecrets),
  `proposal.ts` (`forge/AiProposal/v1` parse + re-validação determinística
  de refs contra catálogo — zero capacidade de execução),
  `bridge.ts` (spawn injetável, byte cap, timeout, `{context}` arg),
  `cache.ts` (digest-keyed, ttl, evicção). Config `ai.*` em `config.ts`.
- `src/portability/` — `manifest.ts` (`forge/IntegrityManifest/v1`, sha256,
  recusa de traversal antes do read), `bundle.ts` (`forge-cli/Bundle/v1`
  dir bundle: profile+env.lock+env-keys+env-values(whitelist)+pins+integrity;
  `SecretKeysRefusedError` fail-closed antes de qualquer escrita;
  `planReinstall` → `forge/ForgeOperationPlan/v1` real).
- `src/intel/learning.ts` — store local `.forge-cli/learning.json`,
  consent gate (`recordObservation` recusa quando disabled), report
  read-only; NUNCA altera política/plano/config.
- `src/cmd/intel2.ts` + wiring — `ask`, `predict`, `context`, `ai`,
  `bundle`, `learning`; `forge-cli.config.json` documenta `ai.*`.
- Docs: `AI_MODE_POLICY.md`, `PORTABILITY.md`, `LEARNING_EVAL.md`.

## Verificação (spec frontmatter)

| Comando                                      | Resultado                   |
| -------------------------------------------- | --------------------------- |
| `cd forge-cli && npm run typecheck`          | ✅ clean                    |
| `cd forge-cli && npm test`                   | ✅ 46 files / **598 tests** |
| `cd forge-portal && npm run build`           | ✅ clean                    |
| `cd forge-portal && npm test`                | ✅ 26 files / 221 tests     |
| `cd forge-portal && python -m pytest tests/` | ✅ 69 passed                |
| eslint + prettier + build                    | ✅ clean / 705 KB           |

## Gate C6 — evidência real (keyless, `env -i` no workspace FORJAS)

1. `ask discovery` → 5 respostas com evidência (forjas declared, stack
   azure/ci/mcp/observability, hosts honestamente `low` — probe zerado).
2. `predict` → **0 predições** — silêncio correto sem evidência.
3. `context` → `forge/ForgeContext/v1`, 1976 bytes, `truncated:false`,
   8 forjas/5 hosts/10 diagnostics — nenhum segredo serializado.
4. `ai summarize-diagnosis` → `Modo IA desativado — comportamento
determinístico em vigor (disabled)` — sem bridge configurada, sem key.
5. `bundle export` → `forge-cli/Bundle/v1`: 8 pins, env-keys só nomes,
   **env-values.json ausente** (zero valores de segredo exportados),
   integrity manifest 6 entradas. `bundle verify` → íntegro.
6. `learning status` → opt-in desativado por padrão.
7. Teste `keyless-gate.test.ts` prova em CI: env sem _KEY_/TOKEN/SECRET →
   engine+predict+context+ai-disabled todos funcionam.

## Riscos restantes

- AI bridge é subprocesso local configurado pelo usuário — a qualidade da
  saída depende do bridge; todo output é validado deterministicamente.
- `host-version` só dispara quando `min_host_versions` é declarado no
  manifest — convenção ainda não usada pelas Forjas (silêncio correto).
- Question strings §6.1 em PT-BR (voz do repo); sem strings canônicas na
  spec — estrutura independente dos textos.
- Aprendizado é observacional apenas — evolução para política exigiria
  novo fluxo de consentimento (documentado em LEARNING_EVAL.md).
