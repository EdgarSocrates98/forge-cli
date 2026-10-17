# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui, no
formato [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não lançado]

### Cycle 11 — instalação registry-first (PyPI)

#### Corrigido após revisão (6ª rodada)

- **Path traversal no uninstall (bloqueio)**: `name`/`dist` vindos do
  `state.json`/receipt (dado não confiável — entrada fora do catálogo é
  desinstalável por design) agora passam por `isSafeRepoName` +
  `resolveInside`, a mesma convenção do `safety.ts` para caminhos
  destrutivos. Nome inseguro = recusa nomeada com exit 2, nunca chega
  ao `rmSync`; `dist` maliciosa só impede a limpeza do wheel cache
  (venv+state ainda saem).
- **Pin não-exato**: `--version 0.1` casa a chave `0.1.0` do PyPI por
  equivalência parseada (PEP 440 zero-padding — o pip aceita `==0.1`).
- **Confirmação interativa no install**: TTY + sem `--yes` mostra o
  plano (`confirmRun`) antes de instalar, mesmo contrato do fluxo git;
  `--json`/pipes/`--yes` seguem sem perguntar.
- **`requires_python` autoritativo**: o piso `minPython` do catálogo só
  se aplica quando os metadados do PyPI não declaram spec — o release
  pode alargar o suporte sem depender de atualização do catálogo.
- **`info.requires_python` escopado**: o campo descreve a release mais
  nova; como fallback só vale quando a versão resolvida é ela (um pin
  antigo não recebe o spec novo por engano).
- **Cache e leitura defensivos**: `writeCache` atômico; cap de 16 MiB
  aplicado antes de bufar o corpo (content-length + cancel do stream);
  `state` com `forges: []` tratado como vazio.
- **Quarentena em hash-mismatch**: artefato divergente é renomeado para
  `.rejected` — preserva evidência, desbloqueia o retry e nunca é
  selecionável pelo `--find-links` (extensão fora de `.whl`/`.tar.gz`).
- **stderr redacted**: detalhes de erro de subprocesso passam por
  `redactSecrets` — credenciais de `PIP_INDEX_URL` não vazam no stdout
  JSON, no `--report` nem no log humano.

#### Corrigido após revisão (5ª rodada)

- **Dedupe pós-normalização**: `install api-forge apiforge-af` (nome +
  alias) não falha mais com `already-installed` espúrio; uninstall
  planeja uma única remoção.
- **`status` honesto sob drift**: receipt registry com venv/bin ausente
  vira `drifted` + "(bin ausente)" (antes marcava `installed` só pelo
  state). `forge-cli registry` e `status` agora concordam.
- **`--report` honrado**: escreve o documento JSON no arquivo (mesmo
  contrato do fluxo git) em vez de só desviar o modo de saída;
  `--json` sozinho continua emitindo no stdout.
- **Flags ignoradas no uninstall**: `--dir`/`--profile`/etc. agora
  avisam no uninstall também (antes só no install).
- **Uninstall completo**: remove venv + `cache/wheels/<dist>` + state —
  reclaim de disco; Forja fora do catálogo mas presente no state
  continua desinstalável (entrada removida do catálogo não trava).
- **Escritas atômicas**: `state.json` e `install.json` usam
  `writeFileAtomic` (convenção do codebase) — kill no meio não corrompe.
- **Sem dir órfão**: falha de install remove `forges/<nome>/` vazio.
- **`--find-links` só no offline**: online as deps resolvem no índice —
  wheel cache não compete desnecessariamente. Limite documentado:
  offline, deps transitivas resolvem por nome sem pin de hash.
- **Cache não envenenável**: payload 200 sem `releases` não sobrescreve
  cache sadio — cai no cache ou falha `malformed`.
- **Menu sem dead-end**: `--method registry` sozinho não abre o menu
  interativo (que só roteava o fluxo git) — recusa limpa no dispatcher.
- **`--method git` em comandos alheios**: agora avisa em vez de engolir
  (ex.: `status --method git`).
- **pip sem prompts**: `--no-input` em download/install; timeout do
  subprocesso preserva o stderr real; payload PyPI tem cap de 16 MiB;
  `available` do `version-not-found` vem ordenado.
- **Banner do plano honesto**: "venv e estado não alterados" (o cache
  de metadados pode ser atualizado — mesmo modelo de `update --check`).
- Docs: `arquitetura.md` e `capabilities.md` descrevem o método
  registry; decisões registradas como diferidas — `--python`
  selecionável (§4.7), pipx/uv (§4.6), canal rc/beta (§4.1), lock de
  state.json entre processos concorrentes.

#### Corrigido após revisão (4ª rodada)

- **Membership own-property**: `--version toString` (ou qualquer membro
  do prototype) não é mais tratado como release existente — `plan`
  chegava a certificar `apiforge-af==toString` como instalável.
- **Instalação por artefato verificado**: o pip recebe o caminho local
  da wheel/sdist com sha256 conferido — um arquivo plantado no wheel
  cache com nome da dist nunca é escolhido por resolução de nome.
  Sem artefato verificável → `hash-mismatch`, não instala. (Limite
  honesto: dependências transitivas resolvem por nome em
  `--find-links`; só o artefato da dist é vinculado por hash.)
- **Reinstall sem `--clean`** recusa com `already-installed` — antes
  `python -m venv` recriava sobre a venv boa e uma falha posterior a
  destruía com o state intacto.
- **`--report`/`--verbose`**: label correto (`--report`, não
  `--report-path`) e `--verbose` entra na lista de avisados.
- **Exit code consistente**: uninstall com nome desconhecido sai 2 em
  modo humano também (antes só `--json` retornava erro).
- **Cache TTL robusto a clock skew**: `fetchedAt` futuro conta como
  stale, não como eternamente fresh.

#### Corrigido após revisão (3ª rodada)

- **PEP 440**: `XaN.postM` agora compara `post` dentro da fase de
  pre-release — antes `1.0a1.post1` empatava com `1.0a1` e `!=`
  avaliava errado.
- **Alias de dist normalizado**: `registry apiforge-af` filtra a linha
  certa e `uninstall --method registry apiforge-af` resolve o estado
  pelo nome canônico — antes passavam validação e produziam saída
  vazia/`não instalado` espúrio.
- **`--clean` limpa o `state.json`** junto com venv/receipt — falha
  posterior não deixa versão antiga registrada sem artefatos.
- **subprocessos com timeout** (venv/download/pip/verify, 5 min
  default) — antes só o fetch era limitado.
- `selectInterpreter` ordena internamente (não depende do chamador);
  `checkDistHashes` verifica **todos** os artefatos presentes;
  `--version vX.Y.Z` aceita prefixo `v` no método registry.

#### Corrigido após revisão (dispatch + integridade, 2ª rodada)

- **`--plan`/`--dry-run`/`--check` honrados no registry**: resolvem e
  mostram o plano (dist==versão, interpretador, venv, wheel cache) sem
  criar venv, baixar artefatos ou gravar estado — antes executavam uma
  instalação real.
- **`--method registry` recusado no topo do dispatch** (`versions`,
  `status`, `list`, `self update`, `doctor`, …) — antes só
  `update`/`clone`/`reinstall`/`rollback`/`pin`/`unpin` alcançavam o
  check e o resto executava o fluxo git.
- **`--json` limpo nos caminhos de erro/aviso**: nomes desconhecidos,
  skips de uninstall e a exigência de `--yes` emitem JSON estruturado
  (`error`, `planned`, `skipped`, `warnings`) — antes logs humanos
  poluíam stdout e quebravam `JSON.parse`.
- **Flags ignoradas cobertas por completo**: `--skip-scripts`,
  `--shallow`, `--fix`, `--rollback`, `--gateway-profile`,
  `--trust-custom`, `--run-after-sync-failure`, `--report`,
  `--only-changed` agora avisam também; `--clean` é honrado (recria a
  venv) e `--check` funciona como plano.
- **HTTP 5xx/429 do PyPI cai no cache local** (antes só exceções de
  transporte); sem cache continua falhando honestamente.
- **`--offline` verifica sha256 do wheel cacheado** contra o digest do
  PyPI — cache adulterado aborta com `hash-mismatch`.
- **Interpretador pré-release** só é escolhido quando nenhum estável
  satisfaz `requires_python` (alinha com `packaging`).
- **`distArtifactFiles`** usa prefixo normalizado com separador —
  `dist_extra-…` não colide e sdists legados com `-` são encontrados.
- **Ordenação PEP 440**: `XaN.devM`/`X.postN.devM` ordenam antes do
  mesmo marco sem `.dev` (e branch morto removido).
- **`registry <nome>`** filtra o catálogo; nome fora do catálogo →
  erro 2.
- **Pós-instalação** mostra o caminho do binário instalado (venv
  isolada — PATH é decisão do usuário).

#### Corrigido após revisão (dispatch + integridade)

- **`--ref`/`--version` em multi-Forja** agora recusa como no fluxo git
  (`errRefNeedsOne`) — antes aplicava o mesmo pin a todas as Forjas.
- **`uninstall --method registry`**: dispatch movido para antes do
  branch legado (sem nomes não executa mais a remoção do PATH),
  `--all`/`--only` resolvem o conjunto instalado, e a remoção segue a
  convenção destrutiva do repo — plano visível + confirmação/`--yes`.
- **`--method registry` em comandos não suportados** (`update`, `clone`,
  `reinstall`, `rollback`, …) é recusado em vez de cair no fluxo git.
- **Offline real**: instalação online baixa artefatos para
  `cache/wheels/<dist>/`; `--offline` instala com
  `--no-index --find-links` e recusa com o artefato faltante nomeado
  (nunca finge instalar sem rede).
- **Integridade**: sha256 do artefato da dist é conferido byte a byte
  após o download e gravado como `verifiedHash` no receipt; divergência
  aborta antes do pip.
- **Yanked/empty releases** não entram na escolha automática
  (PEP 592); pin explícito instala e marca `yanked` no receipt.
- **`status`** mostra Forjas instaladas via registry (fase
  `installed`, `pypi dist==ver`) em vez de `not-installed`.
- **`registry`** marca `(verify falhou)` em installs que não passaram
  no verify; `--json` expõe `verifyOk`.
- **`--json` no install/uninstall registry** emite JSON limpo (banner,
  spinner e logs suprimidos); flags do fluxo git ignoradas viram aviso
  explícito (`--dir`, `--profile`, `--scope`, `--components`,
  `--host`, `--native`, `--skip-verify`, `--timeout`, `--jobs`,
  `--retry-failed`).
- **`requires_python` por arquivo**: prefere o da wheel (o que o pip
  instala) ao do sdist/`info`.
- **Especificador fora do subconjunto** (`===`, `~=X`, wildcard com
  operador errado) vira `specifier-unknown`, não `python-incompatible`.
- **Interpretador pré-release** (`Python 3.14.0a1`) parseia com sufixo.
- **`state.json` corrompido** é preservado em `.corrupt` antes de ser
  ignorado — nunca clobber silencioso.
- **Venv órfã** removida em falha de venv/download/pip.
- **Pisos do catálogo** corrigidos para o `requires_python` real
  publicado (`apiforge-af` ≥3.12, doctors ≥3.11).

#### Added

- **`install --method registry`**: instala Forjas direto do PyPI sem
  exigir clone do repositório nem o The Forge instalado. Cada Forja vai
  para uma venv isolada em `~/.forge-cli/forges/<nome>/`, com
  `pip install <dist>==<versão>` pinado e verify do console script.
- **`forge-cli registry`**: lista o catálogo PyPI (7 dists), a versão
  instalada e o binário de cada Forja; `--json` exporta.
- **`uninstall --method registry`**: remove a venv e o receipt de uma
  Forja instalada via registry.
- **Resolver PyPI** (`src/registry/`): consulta o índice JSON do PyPI,
  escolhe a estável mais nova (pré-releases ignoradas), honra
  `--version`/`--ref` como pin e registra `source` no receipt
  (`pinned|latest-stable|cache`).
- **Compatibilidade Python pré-install**: `requires_python` do release é
  avaliado por um subconjunto PEP 440 (`~=`, `==`/`!=` com `.*`, `>=`,
  `>`, `<=`, `<`) contra os interpretadores detectados — o mais novo que
  satisfaz a faixa vence, e falta de interpretador compatível é erro
  honesto antes de qualquer mutação.
- **Cache offline**: `--offline` resolve apenas pelo cache local
  (`~/.forge-cli/cache/pypi/`, TTL 1h); falha de rede cai no cache
  automaticamente quando existe.
- **Receipts auditáveis**: `install.json` por Forja + `state.json`
  consolidado registram dist, versão, `requires_python`, interpretador
  escolhido, digests sha256 dos artefatos e o verify (comando + ok) —
  incluindo installs que falharam no verify, para diagnóstico.

#### Fixed

- `install` sem nomes no modo registry agora recusa com orientação
  explícita em vez de cair no fluxo interativo do git.

### Hardening pós-release

#### Fixed

- **`update --check` sem upstream**: repositório sem remote configurado
  (ou sem tracking no branch) reportava `não foi possível verificar
(unknown)` — implicando falha transitória onde o estado honesto é
  `no-upstream`. Novo literal em `SyncFailure`; `updateCheck` resolve
  `@{u}` **antes** do fetch (cobre `branch.<name>.remote` apontando para
  `.` ou URL sem remote nomeado) e só então classifica `no-upstream`;
  o texto mostra `sem upstream configurado` e o JSON propaga
  `failure: "no-upstream"`.

#### Changed

- **`planActionsFor` exportado** (`src/wizard.ts`): o construtor das
  ações do plano revisado no wizard vira superfície testável, junto a
  `renderOperationPlan` — o fluxo interativo (@clack/prompts) continua
  fronteira de TUI não simulada.

#### Tests

- `tests/wizard.test.ts` (novo, 15 casos): renderização do plano
  (hash truncado, expiração, passos, marcador de não-reversível,
  truncamento de arquivos em 8) e `planActionsFor` (clone vs pull,
  gating por passo, `.env` e `verify` sempre presentes).
- `tests/hosts.test.ts` (+12 casos): adapter **cursor** completo
  (detect absent→installed→configured→integrated, merge-json com
  preview e sem copyable, manual quando integrado, JSON inválido
  recusado sem clobber, dry-run), **copilot** (detect via `gh copilot`
  - `.config/gh`, plan gated por `mcp-config.json` existente) e
    **devin** (detect via `.config/devin`, apply/validate recusam com
    `hostUnsupported`).
- `tests/config.test.ts` (+6 casos): bloco `ai` do `loadConfig` —
  chaves válidas, limites (512–262144 bytes, 1000–300000 ms,
  0–86400000 ms TTL), tipos errados descartados, `ai` não-objeto
  ignorado sem erro.
- `tests/ai-cache.test.ts` (novo, 8 casos): chave canônica (ordem de
  chaves irrelevante, tipos distintos não colidem), TTL (expirado,
  timestamp futuro, `ttl<=0`), entrada corrompida/shape inválido →
  miss, eviction bounded por idade com tiebreak por nome.
- `tests/git-revs.test.ts` (+6 casos): `updateCheck` reporta
  `no-upstream` com e sem remote configurado, tracking local
  (`branch.<name>.remote=.`, `git remote` vazio) resolve `@{u}` e não é
  `no-upstream`, fetch falho classificado sem throw, `remoteTags` em
  remote `file://` real (ordem semver, `--limit`, remote inacessível →
  `null`).
- `tests/e2e-cli.test.ts` (+1 caso): `update --check` ponta a ponta
  reporta `no-upstream`/`sem upstream configurado` sem pendência.
- `tests/doctor2.test.ts` (+4 casos): helpers de contexto (`listDir`
  ordenado/nulo, `readJson` ok/erro, `boundEntries` com flag de
  truncamento, `mkCheck`/`errMsg`).

### Programa ecosystem-2026 (cyc8-05)

#### Added

- **Compatibilidade com o manifesto do ecossistema**: `src/compat.ts`
  consome `forge/EcosystemCompatibility/v1` (the-forge
  `ecosystem-compatibility.json`) — `update --check` reporta
  `installed_compat: certified|incompatible|unknown` por repositório e o
  banner do manifesto (release + sha256) na saída texto.
- **Validação estrita do manifesto**: `manifestProblems()` espelha
  `load_manifest(strict=True)` do Python — release `YYYY.MM`, `created_at`
  ISO, ids de componente/família/contrato, versão pinada (rejeita
  `latest`/`""`) no scheme declarado, `source` obrigatório, janelas
  `min_major`/`max_major`, famílias únicas. Manifesto inválido → `null`
  (nunca certifica silenciosamente).

#### Changed

- **`update --check --json`**: o payload passa de array puro de
  repositórios para envelope `{manifest: {release, sha256, path} | null,
repos: [...]}` — a identidade do manifesto avaliado agora é evidência no
  JSON. Consumidores do array anterior devem ler `payload.repos`.
- **`compat:` → `installed_compat:`** no texto e no JSON: o veredito se
  refere à versão **instalada**, não ao update pendente (repos `behind`
  não sugerem mais que a atualização é certificada).

### Programa evo-cli-portal (F0→C6, ciclos `audit/f0-baseline`→`cycle/c6-intelligence`)

#### Added

- **Contratos canônicos (C1)**: família `forge/<Name>/v1` como JSON Schemas
  em `contracts/schemas/` (Descriptor, Capability, EnvironmentSchema,
  HostDescriptor, InstallContract, OperationPlan, OperationReceipt,
  HealthReport), validator Python vendorizável (`contracts/forge_contracts.py`,
  stdlib-only), política de descoberta com os sete estados
  (`declared/detected/configured/integrated/validated/degraded/unknown`) e
  precedência explícita (`src/discovery/negotiate.ts`).
- **Descoberta e recomendação (C2)**: `forge-cli discover` (walk bounded por
  budget, sinais de stack, probes de host, `truncated` honesto) e
  `forge-cli recommend` (recomendações explicáveis com confidence).
- **Wizard de instalação (C2)**: fluxo interativo de 7 passos + planner que
  emite `forge/ForgeOperationPlan/v1` com hash sha256 canônico verificável.
- **Env Intelligence (C2)**: `forge-cli env inspect|plan|init|validate|
migrate|doctor` — valores nunca exibidos, migração com rollback.
- **Host Intelligence (C2/C4)**: adapters por host (`forge-cli hosts
list|plan|register|validate|rollback`) — detecção ≠ validação
  (`verified|absent|unknown`), comando copiável em vez de escrita opaca.
- **Ciclo de vida (C2)**: `lock`, `profile`, `recover`, análise de
  breaking-changes, estado persistido.
- **Doctor 2.0 + self-healing (C5)**: `forge-cli doctor` cobre 5 domínios
  (`forge/DoctorReport/v1`, health score gated — `HEALTH_MODEL.md`);
  `forge-cli heal` com classificação `SAFE_AUTOMATIC`/`REVIEW_REQUIRED`/
  `MANUAL_ONLY`/`UNSUPPORTED`, fluxo de reparo em 8 passos, receipts
  imutáveis (`forge/RepairReceipt/v1`) com correlation IDs.
- **Observabilidade e versões (C5)**: métricas locais, `versions`,
  overhead medido (PERFORMANCE_BASELINE.md).
- **Forge Intelligence Engine (C6)**: `forge-cli ask <domínio>`
  (discovery/recommendation/repair — respostas com evidência, confidence,
  ordenação estável), `forge-cli predict` (compatibilidade preditiva com
  evidência/versão/certainty — silêncio honesto sem evidência),
  `forge-cli context` (`forge/ForgeContext/v1`, 8 KiB bounded).
- **Modo IA opcional (C6)**: `forge-cli ai <task>` — opt-in, BYOK via
  bridge configurável (`ai.command`), sanitize tripla de segredos,
  propostas schema-validadas (`forge/AiProposal/v1`) com refs
  re-validados e rechecagem determinística; **zero execução** de conteúdo
  do modelo; fallback tipado para determinístico (`AI_MODE_POLICY.md`).
- **Portabilidade (C6)**: `forge-cli bundle export|import|verify`
  (`forge-cli/Bundle/v1`) — profile, env lock + check, pins, manifesto de
  integridade sha256 (`forge/IntegrityManifest/v1`); valores de segredo
  excluídos por default (`env-values.json` só com whitelist explícita e
  recusa fail-closed de chaves secretas); `planReinstall` gera plano
  verificável (`PORTABILITY.md`).
- **Aprendizado local (C6)**: `forge-cli learning status|enable|disable|
report` — opt-in, `.forge-cli/learning.json` bounded a 1000
  observações, redacted, FIFO, nunca altera política (`LEARNING_EVAL.md`).

#### Changed

- `forge.json` passa a ser validado contra `ForgeDescriptor/v1` quando o
  campo `schema` é declarado — fail-closed, aditivo.
- Ordenações em intel/predict usam comparação por code-unit (estável,
  independente de locale).
- `bundle export` aceita chaves não-secretas posicionais para inclusão
  explícita de valores.

#### Fixed

- `doctor`/`env`/`hosts`/`discover`/`recommend`/`context`/`predict`
  respeitam `--json` sem banner (via `JSON_QUERY_COMMANDS`).
- `bundle export` captura `SecretKeysRefusedError` e exibe recusa clara.
- Heal: `REVIEW_REQUIRED` nunca é aplicado por `--yes` — aguarda revisão
  por chave (Gate C5).

#### Security

- Logs, receipts e erros mascaram segredos (`redactSecrets`); contexto de
  IA usa denylist de chave + redact + detecção de valor-secret-shaped
  (`sk-live-`, `ghp_`, JWT, `AKIA`, `xox*`).
- `assertNoSecrets` devolve paths ofensores ordenados; cache de IA bounded
  (32 entradas, TTL, anti clock-skew, chave sha256 de JSON canônico).
- Bridge de IA tem boundary injetável único, timeout, cap de contexto e
  nenhum payload de comando na saída do modelo.
- `npm ci` auditado, zero vulnerabilidades; runtime deps congeladas.

#### Compatibility

- Sem novas dependências de runtime desde F0; Node >= 20, npm >= 10.
- Contratos são aditivos: `forge/PortalApi/1` intocado; Forjas
  consumidoras não requerem mudança.
- `--offline` usa apenas clones locais; clone ausente → recusa explícita
  (sem tentativa de rede).

#### Migration

- Nenhuma migração obrigatória. `forge.json` legado continua válido
  (campos desconhecidos ignorados); `env migrate` oferece plano+rollback.

#### Known limitations

- Preview de plano exibe `git pull` mesmo com `--offline` (cosmético —
  execução honra a flag; P3).
- Sem lock cross-process entre dois CLIs no mesmo target (P2).
- Manifests de Forja (`forge/SpecialistAgenticManifest/v1`) ainda não
  emitidos pelos repos consumidores — engine reporta silêncio correto.
- Defect pré-existente em `forge-doctor-api`
  (`test_malformed_stdio_input_resilient`) descoberto na homologação —
  escopo do especialista, P2.

### Adicionado

- Licença MIT (`LICENSE`, campo `license`), alinhada às demais Forjas.
- `forge-doctor-api`: `update`/`uninstall` nativos e `--host`/`--gateway-profile`
  confirmados em `scripts/forge_install.py`.
- Testes de TUI com teclas reais simuladas (menu e seleção com busca) e fluxo
  do menu testável sem TTY (`applyMenu`).

### Corrigido

- Ajuda da seleção de Forjas dizia "espaço marca"; a tecla correta é Tab.
- Instaladores nativos (itens 6/7/9/10): `forge-doctor-api` via
  `scripts/forge_install.py` (Python resolvido em runtime), `--host` e
  `--gateway-profile` repassados onde a Forja suporta, `--native` em
  `update` e `uninstall`, e `forge.json` opcional (campos validados)
  para derivar a verificação de Forjas sem `verify` no catálogo.
- `--json` em `status`, `list`, `versions`, `components`, `update --check`
  e `doctor`: só JSON no stdout, sem banner.
- TUI: seleção de Forjas com busca (digite para filtrar) e dica de fase/versão
  por Forja; `--verbose` para saída completa dos comandos; logs com
  timestamp. Código de saída 1 quando alguma Forja falha.

### Corrigido

- O log da execução (`.forge-cli/logs`) agora mascara segredos e URLs com
  credenciais; antes só relatórios e mensagens de erro eram mascarados.
- Aprovação e estados (pós-roadmap): resumo de execução (origem, revisão,
  confiança, comandos exatos) antes da confirmação, aprovação por
  repositório customizado, e fases persistidas (`cloned`, `prepared`,
  `installed`, `validated`, `partial`, `failed`, `drifted`) no `status`.
- `help`, `components [forjas]` (flags do instalador nativo por Forja),
  `doctor <forja>` e `--offline` (usa só clones existentes; nunca clona
  nem faz pull/fetch).
- Adaptadores leves (Cycle 0/6): `--profile`, `--scope` e `--components`
  acionam o instalador nativo da Forja (`<cli> install ...`) depois do
  bootstrap, somente para Forjas que o documentam; sempre `--dry-run`
  salvo `--yes`. Matriz de capacidades real em `docs/capabilities.md`.
- Portabilidade/distribuição (Cycle 8/9): `self update` respeitando o
  método de instalação (npm global automático com `--yes`; shim e
  código-fonte mostram o passo manual), CI em Linux/Windows/macOS e
  testes dos cenários de independência A–F.
- TUI (Cycle 2): menu principal ao rodar `forge-cli` em terminal
  interativo (instalar, atualizar, reinstalar, reparar, versões, estado,
  desinstalar, diagnosticar, sair). Sem TTY ou com comando/flags de
  seleção, o comportamento anterior é mantido. `uninstall` pede
  confirmação interativa quando não há `--yes`.
- Ciclo de vida (Cycle 4/5/7): `pin`/`unpin` (install/update respeitam a
  fixação), `rollback` (só o checkout Git, ao HEAD anterior registrado),
  `reinstall` (mantém a revisão atual; `--clean` remove e reclona com
  backup) e `uninstall <forjas>` (plano por padrão, exige `--yes`; recusa
  tree suja, remote diferente, symlink e diretórios sem .git; faz backup
  de `.env`/configs em `.forge-cli/backups`).
- Versões e revisões (Cycle 3/5): `update [forjas]` (sem nomes: todas as
  clonadas), `update --check` (só fetch, sem alterar), `versions`,
  `--ref <sha|tag>` e `--version <tag>` (checkout destacado; recusa
  working tree modificada; exige uma única Forja).
- Subcomandos (Cycle 3): `install [forjas]`, `clone <forjas>` (sem
  scripts), `status [forjas]`, `self install|uninstall`. **Mudança:**
  `forge-cli install` sem nomes agora abre o fluxo interativo; o
  registro no PATH é `forge-cli self install`.
- Sync Git (Cycle 1): detecta remote divergente do catálogo e classifica
  falhas de pull (divergente/rede/autenticação). Scripts não rodam após
  falha de sync sem `--run-after-sync-failure`; repositórios de
  `forge-cli.repos.json` só executam scripts com `--trust-custom`.
- Segurança (Cycle 1): validação de nomes/URLs de repositórios (bloqueia
  path traversal, `--opção`, `ext::`, `file://` e credenciais embutidas),
  recusa de destino symlink/junction, `git clone --`, redação de
  segredos em logs/relatórios/erros e escrita atômica de estado.
- Provisionamento de `.env` por repositório antes do script de
  instalação: copia `.env.example`, cria modelo comentado ou preserva
  `.env` existente (lf-0002).
- Verificação de ambiente (preflight): `git`, Node.js >= 20 e
  `powershell.exe` no Windows, com saída `exit 1` antes dos prompts.
- UI/UX: banner animado, tema de cores centralizado, ícones emoji,
  spinners com cronômetro, tempo por repositório e relatório final
  enriquecido.

### Alterado

- Refatoração interna: `index.ts` reduzido a orquestrador; novos
  módulos `prompts`, `runner`, `report`, `env`, `preflight` e
  `ui/{theme,strings}` (lf-0002).

## [0.1.0] - 2026-10-11

### Adicionado

- CLI interativa que clona/atualiza os 8 repositórios do ecossistema
  Forge e executa `install.ps1` (Windows) ou `install.sh`
  (Linux/macOS) (lf-0001).
- Fluxo `@clack/prompts`: diretório de destino (padrão
  `./forge-workspace`), multiseleção, confirmação, spinners e
  relatório `[OK]`/`[AVISO]`/`[ERRO]`.
- Cancelamento limpo via `isCancel()` e `SIGINT`.
- Testes `vitest` para o catálogo e utilitários de sistema.
