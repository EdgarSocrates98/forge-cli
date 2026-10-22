# lf-0043 — Install 2.0 Cycle 10: homologação final, CI/CD & release prep

## Contexto
Spec-fonte: `prompt_evo_install2.0.md` §12. Depende de TODOS os anteriores.
Último spec antes da onda de release (minor bumps + tags + PyPI/npm).

## Entregáveis
1. Quality gates §12.1 por repo — usar gates OFICIAIS existentes (não improvisar):
   lint, format, type, unit, integration, contract, install, wheel, sdist,
   multi-forge, host conformance, security, docs, release checks.
2. Testes de conformidade compartilhados §12.2 — cada forge roda individualmente:
   `test_context_manifest_schema`, `test_context_discovery`,
   `test_protocol_access`, `test_rules_retrieval`, `test_knowledge_retrieval`,
   `test_wheel_resource_availability`, `test_install_idempotency`,
   `test_multi_forge_merge`, `test_uninstall_ownership`,
   `test_offline_operation`, `test_host_bootstrap`. Adaptar aos padrões de cada
   projeto — a suite deve ser copiável/adaptável por forge.
3. Matriz §12.3: Linux, Windows, Python mínimo/estável, instalação de usuário,
   venv, wheel, sdist, workspace com Git, workspace sem Git, caminhos com
   espaços, workspace com arquivos preexistentes. Evidência do que rodou.
4. Documentação PT-BR §12.4: 12 itens (o que é Forge Context Runtime; como cada
   forge instala; como hosts descobrem; onde knowledge/rules; como evals
   executam; multi-forge; diagnóstico; repair; update; uninstall; PyPI;
   verificação sem checkout). Exemplos reais, sem comandos inexistentes.
   `forge-cli/docs/install-context/` + docs por repo onde couber.
5. Publicação prep §12.5: por pacote — verificar versão, construir, validar
   wheel+sdist, metadata, recursos, testes limpos, release notes, gates de
   publicação autorizada. Sem acesso → release bloqueada, NUNCA simular sucesso.
6. Relatório final §12.6: `docs/audits/FORGE_CONTEXT_FINAL_HOMOLOGATION.md`
   (por repo implementado + consolidado em `forge-cli/docs/install-context/`):
   SHAs antes/depois, PRs, commits, arquivos, gaps corrigidos/restantes,
   testes executados, resultados, evidências Devin/Claude/Codex, matriz PyPI,
   compat, segurança, performance, recomendações, status por forge.
7. Checklist §16 preenchido item a item com evidência — cada checkbox marcado
   só com prova real ou explicitamente N/A/bloqueado.

## Verificação
- Todas as CIs verdes nos commits de release.
- Checklist §16 completo (provas ou bloqueios documentados).
- Docs gerados sem comandos inexistentes (verificar com exec real).
- twines/builds limpos.
- PRs mergeados; tags prontas (o bump/publicação real vai na onda de release
  final comandada pelo orquestrador, não neste spec).

## Boundary
Branches `cycle/install-context` + PR por repo. Não toca cli/portal/lens.
Release/publish real: só na onda final.
