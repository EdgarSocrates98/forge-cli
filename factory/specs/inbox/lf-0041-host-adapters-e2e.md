# lf-0041 — Install 2.0 Cycle 8: host adapters & real E2E proof

## Contexto
Spec-fonte: `prompt_evo_install2.0.md` §10. Depende de lf-0035→0040.
Hosts alvo: Devin CLI, Claude Code, Codex CLI, GitHub Copilot (quando ambiente
disponível). Desktop/Cloud separado quando comportamento difere.

## Entregáveis
1. Matriz de hosts §10.1: AGENTS.md, CLAUDE.md, AGENT_PROTOCOL.md, Skills,
   Agents, MCP, Registry, Knowledge, Rules, Evals, Handoffs, Segurança,
   Context economy — por host, com evidência. Sem presumir mesmos caminhos.
2. Teste real Devin §10.2 (prioridade — reproduz problema original): projeto
   exemplo + spark-forge-aws instalado pelo WHEEL; prompt do §10.2; verificar por
   traces/logs — descobriu a Forge? protocolo? roteamento? consultou regras?
   consultou knowledge? aplicou regra? registrou evidências? executou
   verificações? evitou conclusão sem fonte? Prova por telemetria/logs, não
   resposta textual.
3. Cenários por forge §10.3: AWS (Glue 5.1, Spark, Iceberg, Lake Formation,
   performance, cross-account, validação de recomendações), Azure (Databricks,
   Delta, Unity Catalog, Event Hubs, ADF, Fabric, migração, perf), API Forge
   (OpenAPI, segurança, evolução, compat, integrações, perf, observ, mudanças
   governadas), Platform (Terraform, K8s, IAM, GitOps, segurança, SRE, FinOps,
   impacto), The Forge (descoberta especialistas, routing, ambiguidade,
   delegação, falha de provider, evidências, coordenação multi-domínio).
4. Combinados §10.4: AWS+Platform, Azure+Platform, API+Platform, AWS+Azure,
   API+AWS, todas, todas+the-forge, todas sem the-forge. Routing correto, sem
   colisões, composição de contexto.
5. Negativos §10.5: knowledge ausente, regra inexistente, manifest inválido,
   caminho quebrado, executável indisponível, MCP desconectado, host sem
   subagents, arquivo protegido, instalação incompleta, wheel sem recursos,
   registry corrompido, versões incompatíveis, path traversal, symlink fora do
   workspace, knowledge malicioso, instrução conflitante, holdout protegido,
   falha no meio da transação. Cada um → estado explícito + ação corretiva.

## Verificação
- E2E real por host disponível (Devin obrigatório; Claude/Codex conforme
  binários presentes — `devin` está na máquina, os demais verificar).
- Traces/capturas como evidência em `forge-cli/docs/install-context/e2e/`.
- Cenários negativos com saídas de recusa documentadas.
- Gates nativos verdes.

## Boundary
Branches `cycle/install-context` + PR por repo. Não toca cli/portal/lens.
