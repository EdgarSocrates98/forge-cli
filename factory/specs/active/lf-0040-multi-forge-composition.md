# lf-0040 — Install 2.0 Cycle 7: multi-forge composition engine

## Contexto
Spec-fonte: `prompt_evo_install2.0.md` §9. Depende de lf-0035/0036 (registry+templates).
Cenário obrigatório: `sparkforge-aws install`, `apiforge install`,
`platformforge install`, `sparkforge-azure install`, `theforge install` — todas
as ordens relevantes, no mesmo workspace.

## Entregáveis
1. Invariantes §9.1: instalação nunca apaga outra; ownership por forge; registry
   incremental; protocolo consolidado válido; instruções do usuário intactas;
   reinstall não duplica; repair só do que é próprio; uninstall só do que é
   próprio; registry sem the-forge.
2. Transações §9.2: preflight → leitura/validação do registry → lock → planejamento
   → detecção de conflitos → backup → escrita transacional → verificação →
   commit → rollback em falha. Recuperação de lock interrompido e de operações
   parciais. Implementar na biblioteca compartilhada do registry (lf-0035).
3. Merge seguro §9.3: AGENTS.md, CLAUDE.md, AGENT_PROTOCOL.md, registry, MCP
   configs, manifests, arquivos por host. Blocos gerenciados + ownership. Sem
   substituições frágeis. Conflito ambíguo → recusar com correção segura.
4. IDs estáveis §9.4: `<forge-id>:<resource-id>` — ex. `spark-forge-aws:glue-performance`.
   NÃO renomear skills/agents existentes sem avaliar compatibilidade/referências.
5. Roteamento §9.5: domínio, escopo, capacidade, evidência, runtime, risco,
   disponibilidade, permissões, ambiguidade. NUNCA ordem de instalação como
   prioridade de domínio. Sem the-forge, composição básica funciona; com ele,
   roteamento avançado pelos contratos de provider já existentes
   (SpecialistCapability/SpecialistDelegation). Registry não vira orquestrador.

## Verificação
- Instalar as 5 em todas as ordens relevantes (script parametrizável): estado
  final equivalente.
- Dois installs seguidos: sem duplicação.
- Uninstall de uma: outras intactas.
- Kill no meio do install: repair recupera; lock interrompido recuperado.
- AGENTS.md/CLAUDE.md do usuário preservados em todas as sequências.
- Registry sem the-forge funciona.
- Gates nativos verdes por repo.

## Boundary
Branches `cycle/install-context` + PR por repo. Não toca cli/portal/lens.
