# Cycle 1 — Completion Report

Spec: `002-c1-foundation-contracts` · Gate C1
Data: 2026-10-14

## Baseline

- Repositório: `forge-cli` (único repo modificado no ciclo).
- Commit inicial: `f893bb0308f2c4016e024d7e21a2e9e79f09c64a` (main, F0).
- Branch: `cycle/c1-foundation-contracts` (sobre `audit/f0-baseline`).
- Capacidades existentes: plan→confirm→execute, native-install dry-run,
  trust model, `.env` preservation, prereq engine, rollback, doctor,
  logs/reports redigidos — 296 testes verdes no baseline.

## Implementação

- Oito contratos canônicos `forge/<Name>/v1` como JSON Schema draft-07
  subset, com cobertura de campos de §1.1:
  `ForgeDescriptor`, `ForgeCapability`, `ForgeInstallContract`,
  `ForgeEnvironmentSchema`, `ForgeHostDescriptor`, `ForgeOperationPlan`,
  `ForgeOperationReceipt`, `ForgeHealthReport`.
- Validador TS interno (`src/contracts/validator.ts`) — zero deps,
  erros estruturados `CONTRACT-*`, `$ref` interno-only, unknown fields
  tolerados, `schema` divergente = `CONTRACT-VERSION` (fail-closed).
- Validador Python stdlib vendorizável (`contracts/forge_contracts.py`),
  byte-parity com os schemas embarcados, `--selftest` offline.
- Negociação explicável de capabilities
  (`negotiateCapabilities`): `granted | granted_unverified | refused |
unknown` + razão por item; `unverified` nunca conta como grant pleno.
- Política de discovery §1.3 (`resolveDiscovery`): precedência
  manifest > forja-discovery > catalog > remote-registry > fallback e
  sete estados distintos (integrated/validated/configured/declared/
  detected/degraded/unknown).
- Integração real: `manifest.ts` valida `forge.json` com `schema`
  declarado contra `ForgeDescriptor/v1` (fail-closed), mantendo
  comportamento legado para manifests sem `schema`.
- Arquivos principais: `contracts/schemas/*.json` (8),
  `contracts/forge_contracts.py`, `contracts/CONTRACTS.md`,
  `contracts/fixtures/*.json` (4), `src/contracts/{validator,schemas,
negotiate,index}.ts`, `src/manifest.ts` (1 bloco aditivo),
  `tests/{contracts,manifest}.test.ts`.
- ADRs: `ARCHITECTURE_DECISIONS.md` — ADR-C1-001 (home canônica),
  ADR-C1-002 (`forge.json` = descriptor on-disk), ADR-C1-003 (formato
  JSON Schema subset), ADR-C1-004 (modelo de discovery). Resolve
  ADQ-001/002/004/006 do F0.
- Migrações: nenhuma necessária — extensão aditiva; `forge.json`
  legado continua válido.

## Testes

- `npm run typecheck` — PASS.
- `npm run lint` — PASS (0 erros).
- `npm run format:check` — PASS (prettier aplicado aos arquivos novos).
- `npx vitest run` — PASS, 331 testes / 27 arquivos (296 baseline +
  35 novos: 33 contracts + 2 manifest).
- `npm run build` — PASS, bundle 488.62 KB (baseline 472 KB).
- `npm run pack` — PASS, tarball 540.2 kB unpacked / 8 arquivos
  (artefato npm não inclui `contracts/` — consumo Forja é via repo).
- `python contracts/forge_contracts.py --selftest` — PASS.
- Cobertura §1.5: schema validation ✓, contract compat ✓, golden
  fixtures ✓, schema evolution (wrong-version + unknown-field) ✓,
  serde round-trip ✓, capability negotiation ✓, legacy-Forja fixture
  (`descriptor.legacy.json`) ✓, dependency-absence (stdlib-only,
  zero deps — verificado por ausência de novos imports/deps) ✓,
  malformed manifests ✓, path traversal (shape-only validation,
  fixture `descriptor.hostile.json`) ✓, untrusted data ✓.
- Evidências: `tests/contracts.test.ts` (34 casos), fixtures em
  `contracts/fixtures/`, parity test disco↔embarcado.

## Segurança

- Testes: hostile manifest (command injection strings, traversal),
  wrong-version schema, non-object docs, oversized manifest (64 KiB cap
  existente mantido), external `$ref` recusado.
- Riscos residuais: nenhum vetor novo — validação é shape-only e nunca
  desreferencia strings como paths/comandos (path safety continua em
  `safety.ts:resolveInside`).
- Mitigações: fail-closed no `schema` declarado; erros estruturados
  nunca lançam exceção em input hostil; zero deps novas = zero superfície
  de supply-chain adicionada.
- Pendências: nenhuma de segurança no escopo C1.

## Interoperabilidade

- CLI: `src/contracts/` exportado via `index.ts`; `manifest.ts` consome
  sem mudar assinatura pública.
- Portal: `forge/PortalApi/1` intocado; contratos são superset
  documental dos payloads existentes (derivation mapeada em
  `CONTRACTS.md`).
- Forjas: consumo via JSON schemas puros ou `_forge_contracts.py`
  vendorizado (mesmo modelo de byte-parity de `_forge_portal.py`) —
  zero dependências de runtime novas.
- Independência: nenhuma Forja modificada; nenhuma dependência circular.

## Performance

- Baseline: vitest suite ~27s, build ~160ms.
- Resultado: vitest ~24s (+38 testes), build ~163ms, bundle +16 KB
  (schemas embarcados + validators) — dentro do orçamento; validação de
  manifest é O(schema pequeno) por arquivo, sem I/O adicional.
- Limitações: validator é interpretador de subset, não JIT — irrelevante
  para payloads <64 KiB.

## Release readiness

- **PASS_WITH_LIMITATIONS** — todas as ACs implementadas e verificadas;
  limitações listadas abaixo são de rollout, não de correção.

## Pendências

- P0: nenhuma.
- P1: publicar/vendar `contracts/` nas Forjas quando um ciclo precisar
  de consumo Forja-side (C4 decidirá o mecanismo — ADR-C1-001 já define
  forge-cli como fonte canônica de edição).
- P2: `forge/ForgeOperationPlan/v1.hash` exige sha256 — o emissor de
  planos hash (C2) deve preencher com o hash canônico do plano.
- P3: se Forjas passarem a propor mudanças de contrato upstream, reabrir
  ADR-C1-001 (home dedicada).
