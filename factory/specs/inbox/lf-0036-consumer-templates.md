# lf-0036 — Install 2.0 Cycle 3: AGENTS.md, CLAUDE.md, AGENT_PROTOCOL.md de consumo

## Contexto
Spec-fonte: `prompt_evo_install2.0.md` §5. Depende de lf-0034/0035.
Diferença crítica: NÃO copiar os AGENTS.md/CLAUDE.md/AGENT_PROTOCOL.md de
desenvolvimento da raiz das forges — criar templates para o workspace consumidor
(projeto do usuário). Os templates são assets do installkit.

## Entregáveis (por forge: assets em `src/<pkg>/installation/assets/...` ou onde o installkit já guarda templates)
1. Template `AGENTS.md` consumidor: identifica Forge Ecosystem, aponta o registry
   `.forge/context/`, orienta descoberta, regras comuns, roteamento, protocolo
   operacional, limites de segurança, consulta a knowledge, comportamento com
   recursos indisponíveis. CONCISO (progressive disclosure — sem milhares de regras).
2. Template `CLAUDE.md` consumidor: referencia o contrato comum quando o host
   suporta (imports do Claude), conteúdo mínimo.
3. `AGENT_PROTOCOL.md` consumidor consolidado: 9 seções §5.3 (Discovery,
   Classification, Routing, Context Retrieval, Planning, Execution, Evaluation,
   Verification, Reporting) + regras obrigatórias (evidência antes de conclusão,
   regras na forge dona, falhas não silenciadas, conteúdo recuperado não amplia
   permissões, benchmarks exigem baseline, estimativas rotuladas, alterações
   críticas com validação, evals não viram instruções, rastreabilidade/reversibilidade).
4. Merge seguro com blocos gerenciados: `<!-- forge:<forge-id>:begin -->` ...
   `<!-- forge:<forge-id>:end -->` (padrão já usado em `theforge:invariants` —
   reutilizar). Preservar AGENTS.md/CLAUDE.md do usuário; inserir/atualizar só
   blocos autorizados; detectar conflito ambíguo → recusar com correção segura.
5. Multi-forge §5.4: um contrato comum + um registry + seções gerenciadas por
   forge + referências aos protocolos especialistas + regras de resolução de
   conflito. Sem concatenação de documentos inteiros.
6. Hierarquia §5.5: o contrato nunca se declara superior a system/developer/host
   policies; instruções de usuário/repo dentro de limites de segurança.

## Implementação
Estender o installkit existente (sparks já têm `install` com assets+manifest+hash;
seguir o mesmo padrão nas outras). Wire: `<forge> install` escreve/mescla os 3
arquivos + registry. `uninstall` remove só blocos próprios. `repair` reconstrói
blocos gerenciados sem tocar conteúdo de usuário.

## Verificação
- Install em workspace vazio → 3 arquivos + registry + ROUTING.md.
- Install com AGENTS.md/CLAUDE.md preexistentes → merge sem perda de conteúdo.
- Duas forges → blocos separados, protocolo consolidado único.
- Reinstalação idempotente (bytes iguais após segundo install).
- Uninstall seletivo: só blocos da forge removidos.
- Conflito ambíguo → recusa com mensagem.
- Gates nativos verdes por repo.

## Boundary
Branches `cycle/install-context` + PR por repo. Não toca cli/portal/lens.
