---
id: cyc8-05
title: cli-release-management
status: active
created: 2026-10-15
owner: forge-cli
scope: repo
cycle: 8
wave: 1
priority: p0
risk: high
agent: codex
source: prompt_evo_cycles.md §8.5
verification: []
---

# Forge CLI — gerenciamento de releases

## Outcome

CLI gerencia o ciclo de vida versionado das Forjas instaladas: instalar estável ou versão específica, descobrir atualizações, preview, compatibility check, breaking changes, update seletivo/em lote, rollback e verificação de integridade — sempre com o usuário no controle.

## Grill gate

- Problema observado: instalação existe (state.json mostra setup.sh), mas operações de atualização/rollback ainda não são gerenciadas.
- Usuário afetado: usuário do CLI atualizando o ecossistema.
- Falha concreta: update cego quebra combinação certificada; falha parcial deixa estado inconsistente.
- Decisão: implementar ausentes do §8.5 — install latest/specific, update preview+discovery, compat check contra o manifesto (cyc8-01), detecção de breaking changes, update seletivo/em lote, rollback, integridade de artefatos, deps ausentes, idempotência, recovery de falha parcial.
- Fora de escopo: update silencioso de todos os repos; segunda fonte de verdade de compatibilidade (consome o manifesto).
- Critério de parada: cada operação idempotente, com preview e recuperação segura, validada contra manifesto.

## Acceptance

- `install` aceita versão específica e "latest estável".
- `update --preview` e discovery de updates disponíveis, sem aplicar.
- Compatibility check consulta o manifesto antes de aplicar; breaking changes sinalizados.
- Rollback suportado com estado anterior restaurável.
- Verificação de integridade de artefatos (hash do §8.8) antes de instalar.
- Operações idempotentes; falha parcial deixa estado recuperável e relatado.
- Testes cobrindo caminho feliz + falha parcial + rollback.

## Constraints

- Usuário no controle: nada de update automático em bloco.
- Não adicionar dependências obrigatórias aos especialistas.
- Sem publicação real de pacotes.

## Verificação

- Confirmar comandos no dispatch: `npm test` / `npm run build` / suíte do repo (a definir no grill).

## Rejected

- CLI atualizando silenciosamente todos os repositórios.
- Lógica de compatibilidade duplicada no frontend do Portal.

## Pending

- ⚠ Stack exata do CLI (Node? scripts existentes) — confirmar na baseline.
- ⚠ Depende do formato do manifesto (cyc8-01) para compat check.
