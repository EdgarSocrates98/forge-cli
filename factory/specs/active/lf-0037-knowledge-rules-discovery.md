# lf-0037 — Install 2.0 Cycle 4: Knowledge & Rules discovery

## Contexto
Spec-fonte: `prompt_evo_install2.0.md` §6. Depende de lf-0035 (contrato).
Cada forge já tem engines nativos (rules catalog, knowledge loader/selector —
ver audit). NÃO reimplementar; expor discovery estável e adaptadores.

## Entregáveis (por forge)
1. Operações de descoberta estáveis mapeadas para o contrato conceitual §6.2:
   `capabilities.list`, `protocol.describe`, `rules.search`, `rules.get`,
   `knowledge.search`, `knowledge.get`, `context.build`, `health.check`.
   Mapear para comandos CLI reais existentes (ex.: `knowledge select`,
   `tokensave context`, `rules`/`explain`, doctor). Documentar o mapeamento no
   manifesto `forge/context/v1` — sem aliases confusos com comandos existentes.
2. Busca de conhecimento §6.3: por palavra-chave, domínio, identificador, filtros
   versão/runtime/severidade, referências relacionadas, paginação, limites de
   saída, proveniência, hash da fonte, estado de validade. Determinística e
   OFFLINE obrigatória; semântica opcional sem serviço externo.
3. Resposta de rules §6.4: `rule_id`, área, aplicabilidade, condições,
   severidade, evidência requerida, refs de knowledge, restrições de versão,
   orientação de validação. Não copiar catálogo inteiro para o prompt.
4. Context Packs §6.5: `<forge> context pack --domain X` (ou o verbo nativo
   equivalente) → JSON com forge, tarefa/domínio, versão, regras selecionadas,
   conhecimento relevante, protocolos exigidos, limites/orçamento, refs de
   evidência, hash+proveniência. Não é dump do repositório.
5. Fallback §6.6: sem MCP → CLI local; sem CLI → registrar indisponibilidade;
   recursos locais autorizados quando existirem; nunca inventar regra; catálogo
   vazio ≠ ausência de risco. Falhas visíveis (exit codes + mensagens).
6. Packaging §6.7: recursos de recuperação disponíveis após install via PyPI —
   zero referência a arquivos do checkout Git (verificar no wheel).

## Verificação
- `rules.search`/`knowledge.search` retornam itens reais com hash/proveniência.
- Context pack gera documento válido com orçamento respeitado.
- Offline: todos os verbos funcionam sem rede (testes não abrem sockets).
- Wheel: instalar wheel em venv, rodar fora do checkout, retrieval funciona.
- Gates nativos verdes; surface locks regenerados quando a CLI muda.

## Boundary
Branches `cycle/install-context` + PR por repo. Não toca cli/portal/lens.
