# lf-0038 — Install 2.0 Cycle 5: Evals, verification & agent protocols

## Contexto
Spec-fonte: `prompt_evo_install2.0.md` §7. Depende de lf-0035.
Cada forge tem evals nativos (`evals run`, `lab`, corpora, holdouts,
baselines). NÃO reimplementar — classificar, expor, proteger.

## Entregáveis (por forge)
1. Inventário e classificação §7.1 dos evals existentes em 4 categorias:
   Developer Evals (testes internos de skills/agents/routing/economia),
   Runtime/Decision Evals (decisões operacionais), Output Verification
   (validação do resultado), Host Conformance Evals (integração host↔forge).
   Persistir a classificação no manifesto `forge/context/v1` + doc `docs/`
   do repo (ex.: `docs/evals-taxonomy.md`).
2. Contratos conceituais §7.2 mapeados para verbos reais: `evals.list`,
   `evals.describe`, `evals.run`, `evals.result`, `verification.plan`,
   `verification.run`. Expor via CLI nativa — documentar no manifesto.
3. Segurança §7.3: holdouts nunca expostos ao agente executor; executor≠avaliador
   quando aplicável; baselines protegidos contra alteração não autorizada
   (hash, gating); sem testes destrutivos; sem cloud mutation sem gate;
   simulado ≠ prova de ambiente real (marcar nos resultados).
4. Comportamento §7.4 — para uma mudança relevante: selecionar verificações
   aplicáveis → plano de validação → executar autorizadas → registrar evidências
   → falhas/inconclusivos explícitos → conclusão proporcional às evidências.
   Garantir que o fluxo existe e é invocável pelo host (verbs + docs).
5. Agentes §7.5: verificar contratos dos agents (`agents/*.md`, roster)
   mencionam protocolos, rule lookups, knowledge retrieval, validadores,
   ferramentas, handoff, persistência de casos, escalonamento, restrições de
   risco. Referência canônica ao protocolo — sem duplicar protocolo em cada
   agente. Regenerar mirrors host (`agents sync`, `agents lint`).

## Verificação
- `evals.list` classificado aparece no manifesto (4 categorias marcadas).
- Holdout: caso de teste tenta expor gabarito → recusado/não incluído.
- `verification.plan`/`verification.run` invocáveis e registram evidências.
- `agents lint`/`agents audit` verdes; mirrors regerados.
- Gates nativos verdes.

## Boundary
Branches `cycle/install-context` + PR por repo. Não toca cli/portal/lens.
