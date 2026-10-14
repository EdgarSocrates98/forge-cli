# Cycle 2 — Completion Report

Spec: `003-c2-cli-intelligence` · Gate C2
Data: 2026-10-14

## Baseline

- Repositório: `forge-cli` (único repo modificado).
- Commit inicial: `763f036` (branch `cycle/c2-cli-intelligence`, sobre C1).
- Capacidades existentes: C1 contracts + 331 testes; install flow
  plan→confirm→execute, native-install, lifecycle, doctor, artifacts.

## Implementação

- **Descoberta limitada** `src/discovery.ts`: `forge-cli/EnvReport/v1` —
  OS/shell/arch, 8 tool probes com orçamento de tempo, markers de
  workspace (package.json, pyproject, requirements*, pom.xml, gradle,
  Dockerfile/compose, \*.tf, .github/workflows, forge.json/agentic),
  hosts de IA, sinais derivados de conteúdo (≤256 KiB, NUL-check),
  estados via `resolveDiscovery` (C1). Limites declarados+enforced:
  depth 3, 500/dir, 5000 total, 2000ms, 12 skipDirs.
- **Recomendações explicáveis** `src/recommend.ts`: 9 regras
  declarativas (`RULES`), score determinístico base×cobertura, `why[]`
  com evidência por sinal, `already_present[]` separa forjas já
  detectadas, `questions[]` quando confiança <0.5 ou top-2 empatados.
- **Wizard 7 passos** `src/wizard.ts` + entrada no menu: detect →
  recommend → customize (forjas + 6 passos selecionáveis + profile/scope)
  → review (plano hasheado renderizado) → install (delega ao fluxo
  comprovado) → validate/summarize (fases pós-install). Cancelamento
  seguro em todo passo, zero efeito colateral antes do passo 5.
- **Env intelligence** `src/envintel/` + `forge-cli env
inspect|plan|init|validate|migrate|doctor`: parser .env com round-trip
  byte-exato (comentários/ordem/quotes/CRLF/export), schema derivado de
  `.env.example`+`envKeys`+`forge.env.schema.json` (não-confiável),
  findings missing/obsolete/conflict/insecure/duplicate/invalid,
  validação por kind (port/url/path/bool/number/secret), migração
  aditiva com backup+dry-run+rollback byte-idêntico; remoção só com
  autorização explícita; valores de segredo NUNCA exibidos/logados.
- **Hosts** `src/hosts/` + `forge-cli hosts
list|plan|register|validate|rollback`: adapters claude/codex/devin/
  cursor/copilot; seis estados distintos (absent→installed→configured→
  authenticated→integrated→validated), auth NUNCA inferida (só probe
  real — codex tem `codex login status`, demais ficam `unknown`);
  merge-json/TOML sem clobber, backup antes de escrever, comandos
  copiáveis (`claude mcp add …`), host sem superfície documentada →
  `null` (honesto).
- **Planner hasheado** `src/planner.ts`: `ForgeOperationPlan/v1` com
  sha256 de JSON canônico, TTL 15min, `verifyPlan` (expired/hash-
  mismatch/malformed), 6 passos selecionáveis, `predictedChanges`.
- **Lifecycle §2.7** `src/maintenance.ts`: env lockfile (digest de
  arquivos-schema, nunca valores), `lock write|check`, profile
  export/import (`forge-cli/Profile/v1`), `recover` (runs interrompidas),
  breaking-change analysis (`classifyBump`/`analyzeBumps`), managed-file
  inventory. Drift: `status.ts` existente; rollback por-efeito:
  `reversible`/`non_reversible_effects` nas ações do plano.
- Comandos novos: `discover`, `recommend`, `env`, `hosts`, `wizard`,
  `lock`, `profile`, `recover` — todos com `--json` limpo.
- Arquivos: 18 novos módulos + 6 test files + wiring (commands,
  cli-args `--rollback`, index dispatch, menu, strings, usage).

## Testes

- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `npm run format:check` — PASS.
- `npx vitest run` — PASS, **436/436 testes / 33 arquivos** (+105 sobre
  C1: envintel 32, hosts 26, discovery 17, recommend 10, planner 10,
  maintenance 9, menu +1).
- `npm run build` — PASS, 587.93 KB (C1: 488.62 KB).
- `npm run pack` — PASS, 8 arquivos.
- **Evidência real no workspace E:\projetos\FORJAS**:
  - `discover`: signals [azure, ci, claude-host, codex-host, devin-host,
    env, forge-manifest, mcp, observability, python-app]; 7 Forjas
    `declared`, forge-portal `detected`; `truncated:true` (bound 5000
    provado em ambiente real); 2591ms.
  - `hosts list`: claude integrated/2.1.296/auth `unknown` (sem probe —
    honesto), codex integrated/0.160.0/`verified` (probe real), devin
    configured, cursor absent, copilot configured.
  - `recommend`: the-forge @ 0.5 conf com why[] citando markers reais.
- **Gate C2 (real)**: `forge-cli install forge-doctor-api --yes` em
  workspace temporário → clone+prereqs+setup.ps1+.env stub+verify
  `forge-doctor-api --help` OK em 24.5s; relatório JSON+log gravados.
  Reinstall: `.env já existia` (preservado), verify OK — **idempotente**.
  `env inspect` → state complete; `lock write/check` → match;
  `recover` → sem runs interrompidas.
- Matriz §2.8 coberta em testes: deep-tree/huge-dir bounds, .env
  absent/partial/secrets, host absent/dup/rollback, unicode+espaços,
  traversal rejection, cancel-safe wizard, expired/mutated plans,
  malformed manifests, idempotent reinstall, offline-capable parsing.

## Segurança

- Segredos nunca saem: mascaramento total em findings/JSON/logs
  (`envSecretHidden`); `.env` só contado por caminho na discovery;
  migração backup'd+atômica; remoção exige `--yes` explícito.
- Scan provado limitado (truncated=true real no workspace grande);
  nenhuma leitura fora de targetDir; links/junctions não seguidos.
- Planos: mutação pós-aprovação → `hash-mismatch` recusado; expiração
  → `expired` recusado.
- Host: sem probe de auth o estado para em `configured`/`integrated`
  com `auth:'unknown'` — nunca `authenticated` por inferência.
- Pendências: `PlanAction.to` carrega segredos gerados para aplicação
  interna (documentado; máscara em toda saída) — candidato a
  endurecimento se revisão exigir zero material em memória de plano.

## Interoperabilidade

- CLI: 8 comandos novos, `--json` em todos, exit codes 0/1/2; modo
  não-interativo preservado (wizard recusa flags de seleção).
- Portal: nenhuma mudança; contratos C1 reutilizados (resolveDiscovery,
  ForgeOperationPlan).
- Forjas: zero modificações; `forge.json`/`forge.agentic.json` reais
  alimentam discovery (`declared`) e host planning (`mcp_command`).
- Independência: CLI funciona sem Portal e sem The Forge instalado —
  provado no gate (workspace só com forge-doctor-api).

## Performance

- Baseline: vitest ~33s→38s (+105 testes), build ~200ms, bundle +99 KB.
- Discovery no workspace real: 2.6s até o bound de 5000 entradas —
  dentro do orçamento (timeout 2000ms de probes em paralelo ao walk).
- Install gate: 24.5s primeira vez / 13.3s reinstall (cache npm/pip).

## Release readiness

- **PASS** — todas as ACs implementadas, verificadas e evidenciadas em
  ambiente real; Gate C2 cumprido com artefatos reproduzíveis.

## Pendências

- P0: nenhuma.
- P1: `npm`/`powershell` podem estourar o orçamento de probes em
  Windows lento — reporta `found:false` honesto; considerar budget
  por-probe separado do total (observado no smoke).
- P1: `devin`/`copilot` sem superfície MCP documentada →
  `planIntegration: null` — revisitar quando Forjas documentarem o
  contrato de integração desses hosts (C4).
- P2: wizard não é exercitável em CI sem TTY — cobertura via testes de
  unidades (planActionsFor/renderOperationPlan); E2E TTY fica para a
  homologação com pseudo-terminal.
- P2: `env validate`/`doctor` cobrem schema derivado; schemas explícitos
  `forge.env.schema.json` ainda raros no ecossistema (0/7 Forjas hoje) —
  incentivar adoção via C4/C5.
- P3: `forge-cli env migrate` não registra receipt `ForgeOperationReceipt`
  — integrar em C5 (execution center unifica recibos).
