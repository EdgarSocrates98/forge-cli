# lf-0042 — Install 2.0 Cycle 9: economy, performance & observability

## Contexto
Spec-fonte: `prompt_evo_install2.0.md` §11. Depende de lf-0035→0041.
Objetivo: NÃO pesar a inicialização dos agentes. Economia de tokens é prioridade.

## Entregáveis (por forge + consolidado)
1. Progressive disclosure §11.1: carregar só índice de forjas + contrato curto +
   metadados de capacidades + referências; detalhes sob demanda. Revisar os
   templates de lf-0036 e o ROUTING.md — conferir orçamento.
2. Medições §11.2: bytes adicionados ao workspace, nº de arquivos, tamanho de
   AGENTS.md/CLAUDE.md/AGENT_PROTOCOL.md, latência de descoberta, latência de
   recuperação, nº de chamadas, cache hit, tokens (observados vs estimados
   SEPARADOS), consultas de knowledge, taxa de uso correto de regras, falhas de
   descoberta, cobertura de verificadores. SEM valores inventados — medir e
   documentar em `docs/install-context/economy/` do forge-cli.
3. Cache §11.3 (quando necessário): versionado, invalidation, limitado, íntegro,
   sem segredos, respeitando alterações de versões/regras.
4. Eventos §11.4 opcionais, estáveis, versionados, redigidos:
   `forge.discovery.started/completed`, `forge.rules.lookup`,
   `forge.knowledge.retrieved`, `forge.protocol.loaded`, `forge.agent.routed`,
   `forge.eval.executed`, `forge.verification.completed`,
   `forge.context.unresolved`. Forge Lens NÃO é dependência — events prontos
   para consumo futuro.

## Verificação
- Baseline medida: bytes/arquivos por install em workspace limpo.
- Latências medidas de descoberta/recuperação com e sem cache.
- Eventos emitidos quando habilitados, inertes quando não.
- Tokens: observados (transcript) vs estimados separados; sem número sem fonte.
- Gates nativos verdes.

## Boundary
Branches `cycle/install-context` + PR por repo. Não toca cli/portal/lens.
