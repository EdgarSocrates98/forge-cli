# lf-0035 — Install 2.0 Cycle 2: contrato `forge-context/v1`

## Contexto
Spec-fonte: `/home/edgar/Documentos/projetos/forjas/prompt_evo_install2.0.md` §4.
Depende do audit lf-0034 (`docs/audits/FORGE_CONTEXT_BASELINE.md` por repo).
Ecossistema já tem: `forge/v1` protocol (EnvReport/TaskSpec/TaskResult),
`theforge/SpecialistCapability/v1` (schema em the-forge, vendored nos providers),
`theforge/McpRegistryDocument`, `forge/EcosystemCompatibility/v1`. O padrão
estabelecido: schema canônico + vendor cópias por repo + `schema validate`.

## Entregáveis
1. Schema `forge/context/v1` (nome final validado contra conflitos nos repos):
   manifesto de capacidades por Forge com campos do §4.1 — identificador estável,
   nome, versão do pacote, versão do protocolo, domínios, capabilities,
   comandos de descoberta, interfaces de recuperação, skills/agents/rules/
   knowledge providers/evals/protocols, hosts suportados, modos de instalação,
   localização de recursos, requisitos de runtime, restrições de segurança,
   perfil instalado, disponibilidade offline, comprovação de integridade.
   Tipagem rigorosa, versionamento, validação de paths/comandos, hashes,
   política de opcionais, estado degradado, referência ao executável, health checks.
2. Registry do workspace `.forge/context/`:
   - `registry.json` — forjas instaladas; determinístico, idempotente, versionado,
     schema-validated, multi-instalador seguro, resiliente a interrupção
     (escrita atômica + lock + journal/repair), sem The Forge, sem segredos.
   - `capabilities/<forge-id>.json` — manifesto por forge.
   - `ROUTING.md` — roteamento humano-legível (domínio→forge, escopo, ambiguidade).
3. Ownership model (§4.3): fully-managed / shared / managed-block / user /
   preexisting / foreign-installer — nenhuma Forge apaga recurso de outra.
4. Compatibilidade §4.4: examinar manifests estáveis existentes (platform-forge
   `forge manifest`, `manifest.json`, `parity.yaml`, `forge.json` installkit) —
   evolução compatível/adaptadores, não substituição.
5. Biblioteca compartilhada de leitura/escrita do registry: stdlib-only, vendored
   ou duplicada-intencionalmente por forge (seguir o padrão que o audit mostrar;
   preferir um `_forgecontext.py` vendored com byte-parity como `_graphview.py`).

## Implementação
Decidir o repo canônico do schema: the-forge é o dono de contratos `theforge/*`,
mas `forge/*` é namespace do ecossistema (ver como `forge/PortalApi/1` e
`forge/EcosystemCompatibility/v1` estão organizados). Implementar no the-forge
(se for o padrão) e vendor nos 4 especialistas; ou implementar self-contained por
forge se o padrão existente assim indicar.

## Verificação
- Schema valida manifestos reais das 5 forges (fixtures válidos + inválidos).
- Registry round-trip: install→reinstall→uninstall sem corrupção.
- Testes de interrupção: kill durante escrita → repair recupera.
- `ruff`/`mypy`/`pytest` verdes por repo; CI gates nativos (`check_surface_lock`,
  `check_claims`, `agents lint`, `sdd check`) regenerados/verdes.

## Boundary
Implementação em branches `cycle/install-context` por repo + PR (spec §0.1.5).
Não modifica forge-cli/portal/lens.
