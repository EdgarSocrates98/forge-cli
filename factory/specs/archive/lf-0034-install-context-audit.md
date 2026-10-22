# lf-0034 — Install 2.0 Cycle 1: auditoria completa das mains e pacotes

## Contexto
Spec-fonte: `/home/edgar/Documentos/projetos/forjas/prompt_evo_install2.0.md` (ler §0–§3).
Ciclo anterior (lf-0026→lf-0033) já entregou: `theforge/SpecialistCapability/v1`,
`SpecialistDelegation/v1`, `EvidenceHandoff/v1`, discovery determinístico, skills/agents
de delegação, portal explorers. Os sparks já têm installkit (`install manifest`,
`forge.json`, `MANIFEST.sha256`, `install/doctor/uninstall`, alguns wheel tests).
Este spec é SOMENTE auditoria — não muda código de produção. Entrega docs.

## Escopo
Repos de implementação (baseline):
- spark-forge-aws `2230a5d`, spark-forge-azure `d35305c`, api-forge `5b3a195`,
  platform-forge `b58dc9c`, the-forge `77654a5`
Repos de audit-only: forge-cli `4a12652`, forge-portal `2dca5cf`, forge-doctor-data
`8d41bde`, forge-doctor-api `c7a05b2`, data-sentinel-forge `92f245f` (referência de
installkit maduro — 3 manifestos forge.json, MANIFEST.sha256, wheel test funcional).
NÃO modificar forge-cli/forge-portal/forge-doctor-* — auditoria read-only neles.

## Entregáveis (por repo implementado: `docs/audits/FORGE_CONTEXT_BASELINE.md`)
1. Inspeção de arquitetura (§3.1): módulos, CLI, installkit, host integration, MCP,
   packaging, schemas, manifests, assets, knowledge/rules/evals/skills/agents/protocols,
   templates, install docs, portability tests, CI/CD, config PyPI. Marcar canônico vs
   derivado e se existe gerador oficial.
2. Matriz de recursos (§3.2) — preencher com EVIDÊNCIA (comandos rodados), não suposição:
   Skills/Agents/MCP/Knowledge/Rules/Evals/Protocols/Verificadores/Políticas ×
   {na fonte, no wheel, instalado no alvo, descoberto pelo host, utilizável, verificado}.
3. Análise do instalador (§3.3): resolução do alvo, scopes project/workspace/user,
   assets copiados vs referenciados vs ignorados, merge, ownership, uninstall, repair,
   update, host selection, perfis.
4. Diagnóstico PyPI (§3.4): build wheel+sdist local, inspecionar conteúdo real
   (`unzip -l`/`tar -tf`), instalar em venv limpa, rodar install fora do checkout,
   testar descoberta. Comparar com a versão PyPI publicada (0.5.6/0.1.6). PROIBIDO
   `pip install -e .` como prova.
5. Gaps P0/P1/P2 com causa-raiz, riscos, decisões propostas, plano de migração.

Consolidar também `forge-cli/docs/install-context/audits/CONSOLIDATED.md` com a matriz
cross-forge e o diff com o que o install2.0 exige (§16 checklist) — cada item do
checklist final mapeado para gap ou evidência existente.

## Verificação
- Os 5 docs baseline existem, citam comandos executados e SHAs.
- `unzip -l` de cada wheel mostrada nos docs (prova real de conteúdo).
- Nenhuma coluna da matriz marcada sem evidência.
- Lint/prettier nos docs novos (forge-cli: `npm run format` se aplicável).

## Boundary
Não modifica código de produção. Não publica nada. Branches+PRs não necessários para
docs de auditoria — commit direto por repo (padrão dos ciclos anteriores).
