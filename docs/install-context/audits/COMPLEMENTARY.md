# COMPLEMENTARY — auditoria dos repos read-only (Install 2.0, ciclo 1)

Spec `lf-0034` / `prompt_evo_install2.0.md` §0–§3. Cobre os repos de
audit-only: **forge-cli**, **forge-portal**, **forge-doctor-data**,
**forge-doctor-api** e **data-sentinel-forge** (referência madura).
Pergunta central: quais partes do install-2.0 já estão resolvidas por
qual repo e podem servir de referência. Somente evidência — comandos e
arquivos citados foram executados/lidos nesta auditoria (2026-10-22).
Nenhum arquivo destes repos foi modificado (este doc é a única exceção,
conforme a tarefa).

| Repo                | SHA auditado                                                                                         | Versão                             | Nota                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------- |
| forge-cli           | `e260ce8` (HEAD; spec esperava `4a12652`, ancestral — HEAD = 4a12652 + commit dos specs lf-0034..43) | `theforge-cli` 0.2.6 (npm)         | TypeScript/Node ≥20, `bin: forge-cli` |
| forge-portal        | `2dca5cf`                                                                                            | `forge-portal-app` 1.0.0 (private) | Angular; **não publicável**           |
| forge-doctor-data   | `8d41bde`                                                                                            | `forge-doctor-data` 1.0.6 (PEP440) | Python ≥3.11                          |
| forge-doctor-api    | `c7a05b2`                                                                                            | `forge-doctor-api` 0.2.6           | Python ≥3.11                          |
| data-sentinel-forge | `92f245f`                                                                                            | `data-sentinel` 0.2.1              | Python ≥3.11 — **referência**         |

---

## 1. forge-cli — orquestrador externo, não dono da inteligência

**O que é:** CLI interativa TypeScript (`package.json`: `name=theforge-cli`,
`bin=forge-cli → dist/index.js`, deps `@clack/prompts, execa, figlet,
picocolors`). O prompt-fonte (§0) é explícito: _"O Forge CLI é um
instalador/gerenciador independente. Não deve ser responsável pela
inteligência operacional das Forjas."_

### Como `forge-cli install` se relaciona com o installkit por-Forge

Duas rotas documentadas (`docs/installation.md`, 10 cenários):

1. **`forge-cli install <forja> --method registry`** (PyPI):
   `src/registry/install.ts` — cria **venv isolada por Forja em
   `~/.forge-cli/forges/<nome>/`**, `pip install <dist>==<versão>` pinado
   na versão resolvida do PyPI (`registry/pypi.ts`), verify do console
   script, launcher em `~/.forge-cli/bin/<cli>` (`registry/shims.ts`),
   cache de wheels em `~/.forge-cli/cache/wheels/`, lockfiles verificados
   (`registry/lock.ts`), receipt auditável com proveniência do intérprete
   (`PythonReceiptInfo`: source/version/executable/selection_reason).
   Recusa `FORGE-PYTHON-INCOMPATIBLE` antes de qualquer mutação.
2. **`forge-cli install <forja>`** (git): clone no workspace
   (`--dir`, default `./forge-workspace`) + `install.sh`/`install.ps1`/
   `install.windows.sh` do próprio repo — ou seja, **delega ao
   bootstrap vendored** (`scripts/forge_bootstrap.py`), não reimplementa.

Depois do runtime, a instalação no workspace do usuário é **delegada ao
instalador nativo de cada Forja**: `src/constants/repos.ts` declara por
repo `nativeInstall: { command, flags, ops }` — ex.:

```text
the-forge        → theforge install apply        flags: scope,profile,components,host
                                                 ops: update=install update, uninstall=install uninstall
sparkforge-aws   → sparkforge-aws install        flags: +gateway-profile
forge-doctor-api → {python} scripts/forge_install.py install   (argv-template)
forge-doctor-data→ forge-doctor-data install
```

`src/native-install.ts` valida `--scope project|workspace|user`,
`--profile minimal|recommended|full`, `--components` csv,
`--host claude|devin|codex|copilot|all`, `--gateway-profile
economy|balanced|deep` — **o mesmo contrato de flags do installkit** —
e roda `--dry-run` quando não há aprovação (`approve`), nunca simulando
suporte (`buildNativeInstall` retorna null se a Forja não declara
instalador).

### O que forge-cli escreve

| Destino                                        | Escritor                                             | Conteúdo                                                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.forge-cli/bin/`                            | `src/install.ts` (self-install)                      | shims `forge`/forges + bloco `GUARD_START/END` em `.bashrc/.zshrc/.profile/config.fish`                                                 |
| `~/.forge-cli/forges/<nome>/`                  | `registry/install.ts`                                | venvs por Forja + receipts                                                                                                              |
| `~/.forge-cli/cache/wheels/`                   | idem                                                 | wheelhouse offline                                                                                                                      |
| Host configs (`~/.claude.json`, `~/.codex`, …) | `src/hosts/*.ts`                                     | merge-json de `mcpServers[forge_id]` + backups com rollback (`types.ts:285-391`) + `copyable_command` manual honesto quando não escreve |
| `~/.forge/installations/`                      | **lê** (`doctor2/domains.ts:407`), **não escreve**   | o registry do bootstrap pertence às Forjas                                                                                              |
| Workspace do usuário (skills/agents)           | **não escreve** — delega ao `nativeInstall` da Forja |

`src/contracts/schemas.ts` embute validadores `forge/*` para consumo:
`ForgeDescriptor/v1` (o `forge.json`), `ForgeInstallContract`,
`ForgeEnvironmentSchema`, `ForgeHostDescriptor`, `ForgeOperationPlan`,
`ForgeOperationReceipt`, `ForgeHealthReport`, `LocalForgeSourceDetection`.
`src/manifest.ts` lê `forge.json` fail-closed (schema errado → descarta
inteiro; `SAFE_TOKEN` em cli/mcp_command). `contracts/negotiate.ts:87`
reconhece `'manifest'` = `forge.json`/`~/.forge/installations` como fonte
verificada. Módulos adjacentes: `heal/` (repair flows), `intel/`,
`source/` (detecção local/zip/pasta), `doctor2/` (diagnóstico).

**Gap relativo ao install-2.0:** forge-cli mantém um registry paralelo
(`~/.forge-cli/forges`) que converge com `~/.forge/installations` só por
leitura — o registry de contexto do ciclo 2 (`.forge/context/registry.json`
por workspace) é um terceiro plano que nenhum dos dois cobre.

---

## 2. forge-portal — componente vendored, não pacote

**O que é:** SPA Angular (`package.json private, name=forge-portal-app`,
v1.0.0). **Não é publicável** — seu papel no install-2.0 é como _fonte
canônica de assets que fluem para os pacotes Python_:

- `portal_core/forge_portal.py` + `telemetry.py` — servidor portal
  canônico (stdlib), vendored **byte-idêntico** para cada Forja:
  `scripts/vendor.py` copia para `<repo>/src/<pkg>/_forge_portal.py`
  (+`_portal_telemetry.py`); `forge-doctor-api` recebe via `scripts/`
  (flat — package boundary proíbe imports de rede em `src/`).
- `scripts/vendor.py` também copia `dist/forge-portal-app/browser/*` →
  `<repo>/portal/assets/` e escreve `<repo>/portal/manifest.json` com
  **sha256+size por arquivo** — o contrato `forge/PortalAssets/1`
  (verificável; `<cli> portal` valida antes de servir).
- Mapa `FORGES` cobre 7 repos (the-forge, aws, azure, api, platform,
  doctor-data `src/forge_doctor_data/portal_assets`, doctor-api scripts).
- `--check` = drift gate de paridade.
- Versão única da verdade: `PORTAL_VERSION` em `portal_core/forge_portal.py`
  (package.json validado por teste contra ela).

**Contribuição ao install-2.0:** padrão de _assets de frontend
distribuídos dentro do wheel_ já resolvido (the-forge carrega 46
`portal_assets` no wheel; doctor-data idem). Sem verbo de install
próprio — é componente, não Forja instalável.

---

## 3. forge-doctor-data — installkit vendored, sem mirrors de host

- `forge.json` (root): `forge_id`, `package=forge_doctor_data`,
  `distribution=forge-doctor-data`, `cli`, `python>=3.11`,
  `mcp_server_name=forge-doctor-data`, `mcp_command=[forge-doctor-data,
mcp]`, `extras=[]`, `lab.command` — o driver declarativo do bootstrap.
- `forge.agentic.json` — manifesto `forge/SpecialistAgenticManifest/v1`
  (idêntico em espírito ao do doctor-api; lido por
  `theforge/discovery.py` como "bundled-manifest").
- **Installkit:** `src/forge_doctor_data/_installkit.py` (vendored,
  `_SOURCE_SHA256`-stamped; `pyproject.toml:130,133` isenta as duas
  cópias vendored do lint) + `scripts/forge_installkit.py` +
  `scripts/forge_bootstrap.py` + `install.sh/install.ps1/install.windows.sh/
setup.sh/setup.ps1` — o pacote completo do vendor.
- **Verbo:** `forge-doctor-data install` existe
  (`cli/install_cmd.py` — typer sub-app: apply/status/doctor/repair/
  uninstall/update/mcp-verify) sobre `install/service.py`.
- **O que instala:** `install/service.py:52-62` — _"publishes no host
  skill/agent mirrors today — all profiles install the managed MCP key
  plus AGENTS.md/CLAUDE.md marker blocks"_ (`render_assets` retorna `{}`).
  Scopes project/workspace/user, profiles minimal/recommended/full,
  gateway profiles economy/balanced/deep, `mcp_verify_tool=
get_execution_baseline`.
- **Wheel real** (`dist/forge_doctor_data-1.0.6-py3-none-any.whl`, 820
  arquivos): `_installkit.py`, `install/`, `cli/install_cmd.py`,
  **`knowledge/` 102 arquivos** (26 domínios — glue, spark, iceberg,
  kafka, neptune, terraform…), `portal_assets/` — **0 skills/0 agents**
  (coerente com o design declarado).
- **Contribuição ao install-2.0:** prova de que o conhecimento extenso
  viaja **dentro do pacote** (modelo "referenciar" do §2.3: knowledge no
  wheel, alcançável por runtime — não copiada por workspace).

---

## 4. forge-doctor-api — install por argv-template + verbo no wheel

- `forge.json` (root): mesma família + `extras=[mcp]`,
  `mcp_command=[forge-doctor-api, mcp]`,
  **`install_command: ["{python}","-m","forge_doctor_api","install"]`** —
  o mecanismo de delegação por argv-template que
  `theforge install auto` honra (`install/service.py:_delegated_cmd`).
- `forge.agentic.json` — `forge/SpecialistAgenticManifest/v1`:
  `workflows` (scan/diagnose, `read_only`, `DIAGNOSTIC_ONLY`),
  `skills:[]`, `agents:[]`, `coordinators:[]`, `host_adapters:
[claude,devin,codex,copilot]`, `requires_network/credentials:false`,
  `read_only_default:true`.
- **Dupla superfície de install:** `scripts/forge_install.py`
  (checkout-level, `import forge_installkit as kit`) **e**
  `forge-doctor-api install` / `python -m forge_doctor_api install`
  dentro do wheel — _"since cyc11.2 (ADR-0006, recorded RC exception)
  … backed by the byte-identical vendored engine …
  `test_package_carries_install_surface` guards parity"_
  (docstring do script).
- **Wheel real** (`dist/forge_doctor_api-0.2.6-py3-none-any.whl`, 404
  arquivos): `_installkit.py`, `install/service.py`,
  `cli/install_cmd.py`, `knowledge/` 29 arquivos, `portal_assets` —
  0 skills/0 agents.
- **Nota de drift doc:** `the-forge/docs/portable-installation/README.md`
  ainda diz "doctor-api | `scripts/forge_install.py` | CLI verb
  deliberately absent" — desatualizado; o verbo existe no wheel desde
  cyc11.2. (Evidence for the CONSOLIDATED doc.)
- **Contribuição ao install-2.0:** `install_command` argv-template é a
  resposta já implementada para "forge cuja boundary proíbe o engine no
  pacote" — padrão reutilizável.

---

## 5. data-sentinel-forge — a referência madura

O installkit **mais completo** do ecossistema observado nesta auditoria:

- **Engine vendored:** `src/data_sentinel/_installkit.py` — _"Vendored
  canonical installkit — byte-identical to the-forge/scripts/installkit
  (drift-checked via \_SOURCE_SHA256)"_ (`pyproject.toml:95-97`,
  `exclude = ["data_sentinel._installkit"]` no mypy/ruff).
- **Camada própria:** `src/data_sentinel/installation/` —
  `service.py` (494), `contracts.py` (198), `hosts.py` (534),
  `ownership.py` (103), `planner.py` (167), `assets.py` (128). `ForgeSpec`
  com `mcp_command` resolvido dinamicamente (`_resolve_mcp_command`),
  `mcp_verify_tool`, `environment()` com knobs declarados.
- **Assets DENTRO do pacote** — o padrão que falta parcialmente no
  the-forge: `src/data_sentinel/installation/assets/`
  - `skills/` — 5 (`data-sentinel-investigate`, `-quality-drift`,
    `-report`, `-spark-plan`, `-sql-review`)
  - `agents/` — 3 (`sentinel-investigator`, `-reviewer`,
    `-spark-specialist`)
  - `manifest/forge.json` — manifesto completo com
    `mcp_server_name`, `mcp_command`, `extras`, `install_command`
  - **`MANIFEST.sha256`** — hash por arquivo de todos os assets
    (integridade verificável pós-instalação — o "comprovação de
    integridade" do §4.1 do prompt-fonte).
- **Verbo:** `data-sentinel install` (typer `app`,
  `install_command` em forge.json).
- **Manifestos `forge.json`:** 2 encontrados (root +
  `installation/assets/manifest/forge.json`); mais
  `fixtures/doctor-data/diagnostic-manifest.json` (fixture, outra
  família). `forge.agentic.json` na raiz.
- **Testes — a matriz E2E de referência**
  (`tests/e2e/test_install_matrix.py`, "ds-0118 §13.3 — E2E installation
  matrix… items that cannot be homologated locally are covered by the CI
  matrix or declared NOT APPLICABLE — never silently skipped"):
  scopes project/workspace/user (user com HOME fake),
  profiles ×3, gateway profiles ×3 + recusa de `off`, **5 hosts incl.
  `cursor`**, components skills-only/agents-only, full install, env
  preexistente intocado, arquivos de usuário preservados,
  uninstall preservando usuário, reinstall idempotente, status+doctor,
  host desconhecido recusado sem writes, dry-run→real, MCP config +
  handshake entry, **sem segredos em receipt/ledger**
  (`test_matrix_no_secrets_in_receipt_or_ledger`).
  Mais `tests/e2e/test_install_golden.py` e `tests/unit/installation/`.
- **Contribuição ao install-2.0:** é a prova de que o modelo completo —
  assets versionados dentro do wheel + manifesto com hashes + ciclo de
  vida governado + MCP real — funciona de ponta a ponta. Onde o spec pede
  "comprovação de integridade" e "localização dos recursos",
  `MANIFEST.sha256` + `manifest/forge.json` dentro do pacote são o
  precedente direto.

---

## 6. Quem já resolve o quê (mapa para o install-2.0)

| Requisito install-2.0                                                                                                                                | Já resolvido por                                                                                                                                                                  | Evidência                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Engine de install governado (ledger sha256, locks, markers, `.mcp.json` gerenciado, scopes, profiles, receipts, rollback, recusas `FORGE-INSTALL-*`) | **the-forge** (`scripts/installkit/forge_installkit.py`, canônico)                                                                                                                | vendored byte-idêntico em doctor-data, doctor-api, data-sentinel (`_SOURCE_SHA256` drift check) |
| Bootstrap de conta (venv+wheel+shim+registry `~/.forge/installations`)                                                                               | the-forge `forge_bootstrap.py` + `vendor.py`                                                                                                                                      | `install.sh/setup.sh` em the-forge, doctor-data, doctor-api                                     |
| Assets versionados dentro do wheel                                                                                                                   | **data-sentinel** (`installation/assets/` c/ skills+agents+`MANIFEST.sha256`+`manifest/forge.json`); the-forge parcial (skills+portal+knowledge, **sem agents**)                  | `unzip -l` nos wheels                                                                           |
| Manifesto agentic descobrível (`forge.agentic.json`, `SpecialistAgenticManifest/v1`)                                                                 | doctor-data, doctor-api, data-sentinel                                                                                                                                            | lido por `theforge/discovery.py:466-530`                                                        |
| Orquestração cross-forge da instalação                                                                                                               | forge-cli (`nativeInstall` argv + catálogo PyPI); the-forge `install auto`                                                                                                        | `constants/repos.ts`; `install/service.py:495-712`                                              |
| Delegação por argv-template (`install_command`)                                                                                                      | forge.json dos doctors + `forge_doctor_api`                                                                                                                                       | `service._delegated_cmd` honra `{python}`/`{checkout}`                                          |
| Integração MCP nos hosts (merge-json + rollback + comando manual)                                                                                    | forge-cli `src/hosts/*.ts`                                                                                                                                                        | claude/codex/cursor/copilot/devin adapters                                                      |
| Registry de instalações de conta                                                                                                                     | `~/.forge/installations/` (bootstrap) — lido por the-forge e forge-cli doctor                                                                                                     | 7 manifests ativos nesta máquina                                                                |
| Wheel E2E/matrix de portabilidade                                                                                                                    | data-sentinel `test_install_matrix.py`; the-forge `test_installkit*.py` + `test_install_e2e.py` + `test_installkit_schemas.py`                                                    | —                                                                                               |
| Integrity manifest de assets (`MANIFEST.sha256`, `forge/PortalAssets/1`)                                                                             | data-sentinel; forge-portal `vendor.py`                                                                                                                                           | —                                                                                               |
| Assets de UI no wheel (`portal_assets` + manifest sha256)                                                                                            | forge-portal → todas as Forjas                                                                                                                                                    | `vendor.py`, force-include                                                                      |
| Registry de contexto por workspace (`.forge/context/*`, `forge-context/v1`)                                                                          | **ninguém** — gap aberto                                                                                                                                                          | —                                                                                               |
| Entry points completos AGENTS.md/CLAUDE.md/AGENT_PROTOCOL.md no consumidor                                                                           | **parcial**: só marker blocks (the-forge, doctors); templates completos em ninguém                                                                                                | —                                                                                               |
| Handles instalados para knowledge/rules/evals/protocols                                                                                              | **parcial**: knowledge viaja no pacote (sentinel 102 arquivos, doctors, the-forge `forge_knowledge`) mas sem handle no workspace; rules/evals como artefatos instaláveis: ninguém | —                                                                                               |
| Instalação offline/wheelhouse                                                                                                                        | forge-cli (`--method registry --offline`, `cache/wheels`)                                                                                                                         | `docs/installation.md` cenário 10                                                               |
| Skills/agents com formato nativo por host no install                                                                                                 | **ninguém** — data-sentinel copia md único; the-forge copia mirror codex para todos                                                                                               | —                                                                                               |

### Observações finais

- **Dois registries de instalação coexistem**: `~/.forge/installations/`
  (installkit/bootstrap, das Forjas) e `~/.forge-cli/forges/` (venv
  manager do forge-cli). O registry de contexto do ciclo 2 deve decidir
  se projeta, consolida ou referencia — nunca um terceiro dono.
- **Drift doc encontrado**: tabela de status em
  `the-forge/docs/portable-installation/README.md` desatualizada para
  forge-doctor-api (verbo já existe no wheel).
- **A divisão de trabalho é clara e estável**: forge-cli orquestra
  aquisição e integração MCP de conta; cada Forja é dona do próprio
  installkit vendored e dos seus assets — exatamente o princípio §2.1/2.2
  do prompt-fonte. O que falta no install-2.0 é a camada de _contexto no
  workspace_ (registry, entry points ricos, handles de conhecimento) —
  não o motor de instalação, que já existe e está provado.

### Comandos executados nesta auditoria (repos read-only)

```text
# forge-cli
git log -1 --format='%H %s'            → e260ce8 (4a12652 é ancestral)
cat package.json                       → theforge-cli 0.2.6, bin forge-cli
sed -n '1,140p' src/constants/repos.ts → nativeInstall por Forja
head -80 src/install.ts; head -60 src/native-install.ts
head -70 src/registry/install.ts       → ~/.forge-cli/forges/<nome>
grep -rn '.forge-cli\|.forge/installations' src/ → escrita vs leitura
head -50 src/manifest.ts; grep schemas src/contracts/schemas.ts
head -60 docs/installation.md          → 10 cenários

# forge-portal
git log -1 … → 2dca5cf; cat package.json → private 1.0.0
head -60 scripts/vendor.py             → FORGES map + manifest sha256

# forge-doctor-data / forge-doctor-api
git log -1 … → 8d41bde / c7a05b2
cat forge.json forge.agentic.json      → manifests completos
head -80 src/forge_doctor_data/install/service.py → "no host mirrors"
python3 -c zipfile … dist/*.whl        → 820/404 arquivos; knowledge 102/29;
                                         skills 0; agents 0

# data-sentinel-forge
git log -1 … → 92f245f (0.2.1)
ls src/data_sentinel/installation{,/assets{,/skills,/agents,/manifest}}
cat MANIFEST.sha256; grep -n 'def test_' tests/e2e/test_install_matrix.py
```
