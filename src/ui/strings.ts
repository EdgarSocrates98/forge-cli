export const S = {
  intro: ' forge-cli — instalador do ecossistema Forge ',
  bannerWord: 'FORGE',
  askDir: 'Onde os repositórios devem ser instalados?',
  askDirDefault: './forge-workspace',
  askRepos: 'Selecione os repositórios para instalar',
  summaryTitle: 'Resumo',
  confirmRun: 'Confirmar e iniciar a instalação?',
  cancelled: 'Operação cancelada pelo usuário.',
  interrupted: 'Operação interrompida (Ctrl+C).',
  preflightTitle: 'Verificando ambiente',
  preflightGit: 'Git disponível',
  preflightNode: 'Node.js >= 20',
  preflightPwsh: 'powershell.exe disponível',
  preflightPython: 'Python 3 disponível (recomendado)',
  preflightNpm: 'npm disponível',
  preflightPyTool: 'pip/pipx/uv (pacotes Python)',
  preflightPath: '~/.forge-cli gravável (shims/PATH)',
  preflightOsArch: 'SO/arquitetura',
  preflightExisting: 'Instalações registry existentes',
  preflightHintGit: 'instale git (apt/brew/winget) e repita',
  preflightHintNode: 'instale Node >= 20 via nvm/fnm ou nodejs.org',
  preflightHintNpm: 'npm vem com o Node — reinstale Node completo',
  preflightHintPwsh: 'instale PowerShell 7+ (winget install PowerShell)',
  preflightHintPython: 'método registry precisa de Python >= 3.10',
  preflightHintPyTool: 'instale pipx/uv ou `python -m ensurepip`',
  preflightHintPath: 'ajuste permissões de ~ ou defina FORGE_CLI_HOME',
  pythonNotFound: 'não encontrado',
  preflightFailed: 'Ambiente incompleto — instale as dependências acima e tente novamente.',
  phaseClone: 'Sincronizando',
  phaseEnv: 'Provisionando .env',
  phaseConfigs: 'Copiando configs de exemplo',
  phasePrereqs: 'Verificando pré-requisitos',
  prereqsFailed: 'Pré-requisitos não atendidos',
  prereqFound: 'encontrado',
  prereqNotDeclared: 'não declarado',
  phaseInstall: 'Executando script',
  phaseVerify: 'Verificando',
  reportTitle: 'Relatório final',
  nextStepsTitle: 'Próximos passos',
  totalTime: 'Tempo total',
  slowestRepo: 'Mais lento:',
  askRetry: 'Retentar repositórios com erro?',
  outroOk: 'Tudo pronto! Bom código.',
  outroWithErrors: 'Instalação concluída com pendências — verifique os erros acima.',
  labelOk: '[OK]',
  labelWarn: '[AVISO]',
  labelErr: '[ERRO]',
  envCopied: '.env criado a partir de .env.example',
  envStub: '.env criado (modelo vazio — preencha os valores)',
  envExists: '.env já existia',
  envFailed: 'Falha ao provisionar .env',
  noSetupSteps: 'Nenhum passo de setup detectado (script ou package.json)',
  nonGitDir: 'Diretório existe e não é um repositório Git — pulado',
  warnDirtyTree: 'Alterações locais detectadas',
  clonedOnly: 'Clonado (nenhum script executado)',
  syncedOnly: 'Já clonado — sincronizado (nenhum script executado)',
  statusTitle: 'Estado local',
  statusNotInstalled: 'não clonado',
  statusCloned: 'clonado',
  statusInstalled: 'instalado',
  statusFailed: 'falha',
  statusPrepared: 'preparada (scripts não executados)',
  statusValidated: 'validada',
  statusPartial: 'instalação parcial',
  statusDrifted: 'alterada fora do forge-cli (revisão difere do registro)',
  errCloneNeedsNames: 'clone exige nomes de Forjas (ou --all/--only)',
  errYesNeedsSelection:
    '--yes nunca pergunta — informe a seleção explicitamente (--all, --only ou nomes)',
  errUnknownCommand: 'Comando desconhecido',
  errRefDirty: 'Working tree com alterações locais — não é seguro trocar de revisão',
  refCheckedOut: 'Revisão',
  errRefNeedsOne: '--ref/--version exigem exatamente uma Forja',
  errMethodUnsupported:
    '--method registry só é suportado em install|uninstall|update|reinstall|rollback|pin|unpin',
  errRegistryReinstallNeedsNames:
    'reinstall --method registry exige nomes, --only ou --all (Forjas instaladas via registry)',
  errRegistryRollbackNeedsNames:
    'rollback --method registry exige nomes, --only ou --all (Forjas instaladas via registry)',
  errRegistryPinNeedsNames:
    'pin --method registry exige nomes, --only ou --all (Forjas instaladas via registry)',
  errRegistryUnpinNeedsNames:
    'unpin --method registry exige nomes, --only ou --all (Forjas instaladas via registry)',
  registryPinnedAt: 'fixada em',
  errRegistryNeedsNames:
    'informe as Forjas (ex.: forge-cli install api-forge --method registry) ou --all',
  errRegistryUninstallNeedsNames:
    'uninstall --method registry exige nomes, --only ou --all (Forjas instaladas via registry)',
  registryUninstallConfirm: 'remover venvs e receipts das Forjas instaladas via PyPI',
  registryUninstallNeedsYes: 'Nada foi removido. Reexecute com --yes para confirmar.',
  registryIgnoredFlags: 'flags ignoradas no método registry',
  registryStaleCache: 'cache do PyPI expirado — metadados podem estar desatualizados',
  registryOfflineMissing: 'artefato ausente no cache local — instalação offline impossível',
  registryHashMismatch: 'digest sha256 diverge do publicado no PyPI — instalação abortada',
  registryVerifyFailed: '(verify falhou)',
  errRefExclusive: 'Use apenas um entre --ref e --version',
  errRefInvalid: 'Revisão/versão inválida',
  updateCheckTitle: 'Verificação de atualizações',
  updateCheckFailed: 'não foi possível verificar',
  updateNoUpstream: 'sem upstream configurado',
  updateCommitsBehind: 'commit(s) disponíveis',
  updateUpToDate: 'atualizado',
  updateNothing: 'Nenhuma Forja clonada neste diretório — nada para atualizar',
  versionsTitle: 'Versões',
  versionsRevision: 'revisão',
  versionsTags: 'tags',
  versionsUnavailable: 'indisponível (offline?)',
  pinDone: 'Fixada em',
  unpinDone: 'Fixação removida',
  unpinNone: 'não estava fixada',
  errPinNeedsVersion: 'pin exige uma Forja e --version/--ref',
  errNeedsOneName: 'Informe exatamente uma Forja',
  rollbackDone: 'Checkout revertido para',
  rollbackNote:
    'Apenas o checkout Git foi revertido; efeitos do instalador (dependências, configs) não são desfeitos.',
  rollbackNoPrevious: 'sem revisão anterior registrada',
  rollbackNotCloned: 'não clonada',
  rollbackDirty: 'working tree com alterações locais',
  uninstallPlanTitle: 'Plano de remoção',
  uninstallAbsent: 'não clonada — nada a remover',
  uninstallReady: 'será removida',
  uninstallBackups: 'backup de',
  uninstallRefused: 'recusado',
  uninstallReasonInvalid: 'nome inválido',
  uninstallReasonSymlink: 'destino é link simbólico/junction',
  uninstallReasonNonGit: 'diretório não é um clone Git (arquivos desconhecidos)',
  uninstallReasonRemote: 'remote origin difere do catálogo',
  uninstallReasonDirty: 'alterações locais não commitadas',
  uninstallNeedsYes: 'Nada foi removido. Reexecute com --yes para confirmar.',
  uninstallBackupAt: 'Backup de configurações em',
  uninstallRemoved: 'removida',
  errReinstallNeedsNames: 'reinstall exige nomes de Forjas (ou --all/--only)',
  warnLegacyUninstall:
    'uninstall sem nomes remove o PATH (legado); prefira: forge-cli self uninstall',
  menuTitle: 'Como podemos ajudar?',
  menuInstall: 'Instalar Forjas',
  menuInstallHint: 'registry (PyPI + venv) ou git',
  menuInstalled: 'Forjas instaladas',
  menuInstalledHint: 'receipts registry + estado local',
  menuWizard: 'Assistente inteligente',
  menuWizardHint: 'descobrir → recomendar → instalar',
  menuUpdate: 'Atualizar Forjas',
  menuHosts: 'Integrações de host',
  menuHostsHint: 'claude/devin/codex/copilot',
  menuMcp: 'Servidores MCP',
  menuMcpHint: 'comando MCP por Forja',
  menuSkills: 'Skills e agents',
  menuSkillsHint: 'componentes nativos por Forja',
  menuAdvanced: 'Avançado',
  menuAdvancedHint: '.env e verificação MCP profunda',
  menuEnv: 'Assistente de .env',
  menuEnvHint: 'inspect/validar/migrar variáveis',
  menuMcpVerify: 'Verificação MCP completa',
  menuMcpVerifyHint: 'handshake + tools/call allowlisted',
  menuReinstall: 'Reinstalar Forjas',
  menuReinstallHint: 'mantém a revisão atual',
  menuRepair: 'Reparar instalação',
  menuRepairHint: 'doctor --fix',
  menuVersions: 'Consultar versões',
  menuStatus: 'Estado local',
  menuUninstall: 'Desinstalar Forjas',
  menuUninstallHint: 'plano + backup de configs',
  menuDoctor: 'Diagnosticar ambiente',
  menuExit: 'Sair',
  askConfirmUninstall: 'Remover as Forjas listadas (com backup de configurações)?',
  selfUpdateTitle: 'Atualização do forge-cli',
  selfUpdateMethod: 'Método de instalação detectado',
  selfUpdateRun: 'Comando',
  selfUpdateNeedsYes: 'Nada foi executado. Reexecute com --yes para atualizar.',
  selfUpdateDone: 'forge-cli atualizado',
  selfUpdateFailed: 'Falha ao atualizar o forge-cli',
  phaseNative: 'Instalador nativo da Forja',
  nativeUnsupported:
    'Forja sem instalador nativo documentado para --profile/--scope/--components — use o método oficial do repositório',
  nativeFlagIgnored: 'Flag não suportada por esta Forja (ignorada)',
  nativeDryRun: 'instalador nativo (--dry-run)',
  nativeApplied: 'instalador nativo',
  nativeNeedsYes: 'Plano nativo exibido sem escrever; reexecute com --yes para aplicar',
  nativeFailed: 'Instalador nativo falhou',
  componentsTitle: 'Instaladores nativos (flags suportadas)',
  errOfflineNoNetwork: 'Esta operação exige rede e não é compatível com --offline',
  planOrigin: 'Origem',
  planRevision: 'Revisão',
  planTrust: 'Confiança',
  planScriptsAfterClone: '(script de setup e npm serão detectados após o clone)',
  trustBuiltin: 'catálogo oficial',
  trustCustom: 'repositório customizado (forge-cli.repos.json)',
  approvalTitle: 'Execução planejada',
  askTrustCustom: 'Executar os scripts do repositório customizado',
  warnScriptsDenied: 'Scripts não executados: não aprovados pelo usuário',
  askReposHelp: '(digite para pesquisar · setas + Espaço marca · Enter confirma)',
  askReposPlaceholder: 'Pesquisar Forjas…',
  verboseLimit: 'Saída completa dos comandos habilitada (--verbose)',
  nativeNoPython: 'Python não encontrado (python3, python, py) para o instalador nativo',
  nativeUninstallFailed: 'Desinstalação nativa falhou — clone preservado',
  nativeUninstallPlan: 'desinstalação nativa',
  warnPullFailed: 'Pull falhou — seguindo com a versão local',
  warnPullDiverged: 'Branch local divergente do remoto (pull --ff-only não aplicável)',
  warnPullNetwork: 'Falha de rede ao atualizar o repositório',
  warnPullAuth: 'Falha de autenticação ao atualizar o repositório',
  warnRemoteMismatch: 'Remote origin difere do catálogo — repositório não atualizado',
  warnScriptsSkippedSync:
    'Scripts não executados após falha de sincronização (use --run-after-sync-failure)',
  warnScriptsSkippedUntrusted: 'Repositório customizado: scripts não executados sem --trust-custom',
  configCopied: 'Config de exemplo copiada',
  configFailed: 'Falha ao copiar configs de exemplo',
  verifyOk: 'Verificação OK',
  verifyFailed: 'Verificação não confirmada',
  npmFailed: 'Falha no npm',
  cloneFailed: 'Falha no clone/pull',
  installFailed: 'Falha na execução do script',
  installedVia: 'Instalado via',
  planTitle: 'Plano de execução',
  planSync: 'Sincronizar',
  planDetectAfter: 'detectado após clone',
  planEnvKeep: 'manter .env existente',
  planEnvCopy: 'copiar .env.example',
  planEnvStub: 'criar .env (modelo)',
  planNone: 'nenhum',
  selectedRepos: 'Repositórios selecionados',
  errUnknownRepos: 'Repositórios desconhecidos',
  validAre: 'válidos',
  errTimeoutInvalid: '--timeout deve ser um inteiro positivo (segundos)',
  errNoState: 'Nenhum estado anterior encontrado neste diretório',
  noFailedRepos: 'Nenhum repositório com erro registrado',
  customReposInvalid: 'forge-cli.repos.json inválido — usando catálogo padrão',
  customReposRejected: 'Repositórios customizados rejeitados (nome ou URL inválidos)',
  customReposLoaded: 'Repositórios extras carregados de forge-cli.repos.json',
  logSaved: 'Log salvo em',
  reportSaved: 'Relatório JSON salvo em',
  doctorTitle: 'Diagnóstico — verificação dos repositórios',
  doctorNoCheckout: 'sem checkout neste diretório',
  doctorNoVerify: 'sem comando de verificação',
  doctorPrereqsFail: 'pré-reqs falhos',
  doctorAllOk: 'Tudo saudável — nada a reparar.',
  doctorNeedsInstall: 'Sem checkout — instale com o modo normal',
  doctorFixing: 'Reparando',
  healTitle: 'Plano de reparo',
  healNoFindings: 'Nada a reparar — nenhum diagnóstico com falha ou aviso.',
  healAskReview: 'Aplicar os reparos que exigem revisão?',
  healPickBackup: 'Escolha o backup a restaurar',
  healDryRun: 'Simulação — nada foi aplicado',
  healRiskLabel: 'Risco',
  healUnsupportedNote: 'sem reparo suportado — somente diagnóstico',
  healReceiptSaved: 'Recibo de reparo',
  healAllVerified: 'Todos os reparos verificados',
  healPending: 'Reparos pendentes ou recusados',
  doctor2NotReversible: 'irreversível',
  configInvalid: 'forge-cli.config.json inválido — ignorando',
  errJobsInvalid: '--jobs deve ser um inteiro entre 1 e 8',
  jobsIgnored: '--jobs ignorado no modo interativo',
  unchanged: 'Sem mudanças — HEAD inalterado',
  listTitle: 'Catálogo e último estado',
  listNever: 'nunca executado',
  installDone: 'forge-cli instalado em',
  installPathAlready: 'O PATH do usuário já aponta para a instalação.',
  installNewTerminal: 'Abra um terminal novo para usar forge-cli de qualquer lugar.',
  uninstallDone: 'forge-cli removido do PATH do usuário.',
  uninstallProfiles: 'Blocos removidos dos profiles',
  doctorPathMissing:
    'forge-cli não está no PATH — rode forge-cli install ou npm i -g para usá-lo de qualquer terminal',
  discoverTitle: 'Descoberta de ambiente',
  discoverToolFound: 'encontrado',
  discoverToolMissing: 'não encontrado',
  discoverTruncated: 'Varredura limitada atingida — resultados parciais',
  discoverSignals: 'Sinais detectados',
  discoverForges: 'Forjas no workspace',
  discoverHosts: 'Hosts de IA',
  recommendTitle: 'Recomendações',
  recommendWhy: 'Por quê',
  recommendConfidence: 'confiança',
  recommendLowConfidence: 'Confiança insuficiente — confirme antes de prosseguir',
  recommendNone: 'Nenhuma recomendação automática — seleção manual',
  wizardStepDetect: 'Detectar ambiente',
  wizardStepRecommend: 'Recomendar',
  wizardStepCustomize: 'Personalizar',
  wizardStepReview: 'Revisar plano',
  wizardStepInstall: 'Instalar',
  wizardStepValidate: 'Validar',
  wizardStepSummary: 'Resumo',
  wizardCancelSafe: 'Cancelamento seguro — nada foi alterado',
  wizardStepPrefix: 'Passo',
  wizardPlanSteps: 'Passos do plano',
  wizardMethodAsk: 'Método de instalação',
  wizardMethodRegistry: 'registry (PyPI + venv isolada)',
  wizardMethodRegistryHint: 'recomendado — fora do workspace, receipt auditável',
  wizardMethodGit: 'git (clone + setup no workspace)',
  wizardMethodGitHint: 'código-fonte local, atualização via pull',
  wizardMethodDistless: 'sem dist no catálogo registry — ficam de fora',
  wizardRegistryPlan: 'Plano registry-first (dist/venv — sem hash de plano git)',
  envTitle: 'Ambiente (.env)',
  envInspectTitle: 'Inspeção de .env',
  envFileAbsent: 'sem .env',
  envFilePartial: '.env parcial',
  envSecretHidden: '(valor oculto)',
  envVarMissing: 'ausente',
  envVarObsolete: 'obsoleta',
  envVarConflict: 'conflitante',
  envVarInsecure: 'insegura',
  envVarDuplicate: 'duplicada',
  envVarSecret: 'segredo',
  envPlanTitle: 'Plano de mudanças de .env',
  envPlanNone: 'Sem mudanças necessárias',
  envInitDone: '.env criado',
  envInitExists: '.env já existe — nada alterado',
  envValidateOk: '.env válido',
  envValidateFail: '.env inválido',
  envMigrateDryRun: 'Simulação — nada foi escrito (remova --dry-run para aplicar)',
  envMigrateDone: '.env migrado',
  envMigrateNeedsYes: 'Remoção de variáveis exige autorização explícita — reexecute com --yes',
  envBackupAt: 'Backup em',
  envRollbackDone: '.env restaurado a partir do backup',
  envRollbackNone: 'Nenhum backup de .env encontrado',
  envDoctorTitle: 'Diagnóstico de .env',
  envValueNeverShown: 'valores nunca são exibidos',
  envWizardNonInteractive:
    'env wizard é interativo — para não-interativo use `env init` ou `env migrate --yes`',
  envWizardRequired: '[obrigatória]',
  envWizardOptional: '[opcional]',
  envWizardKeep: '(Enter = manter o valor atual)',
  envWizardRequiredMsg: 'valor obrigatório — informe ou Ctrl+C para sair',
  envWizardInvalid: 'formato inválido para esta variável',
  envWizardNothing: 'Nada a alterar — todos os valores já estavam definidos',
  envWizardDone: '.env atualizado (backup .env.bak)',
  hostsTitle: 'Hosts de IA',
  hostAbsent: 'ausente',
  hostInstalled: 'instalado',
  hostConfigured: 'configurado',
  hostAuthenticated: 'autenticado',
  hostIntegrated: 'integração presente',
  hostValidated: 'integração validada',
  hostAuthUnknown: 'autenticação não verificada',
  hostVersionUnknown: 'versão não identificada',
  hostPlanTitle: 'Plano de integração',
  hostNeedsYes: 'Nada foi escrito — reexecute com --yes para aplicar',
  hostRegistered: 'integração registrada',
  hostAlreadyIntegrated: 'integração já presente',
  hostCopyCommand: 'Comando para executar no host (copie):',
  hostUnsupported: 'host sem integração documentada',
  hostRollbackDone: 'integração revertida',
  planHashLabel: 'Hash do plano (sha256)',
  planExpiresAt: 'Expira em',
  planStepsLabel: 'Passos selecionados',
  planPrecondLabel: 'Pré-condições',
  planExpired: 'Plano expirado — gere um novo plano',
  planHashMismatch: 'Plano alterado após aprovação — recusado',
  planSavedAt: 'Plano salvo em',
  lifecycleDriftTitle: 'Deriva detectada',
  lockfileWritten: 'Lockfile de ambiente gravado em',
  lockfileMismatch: 'Ambiente diverge do lockfile',
  profileExportDone: 'Perfil exportado para',
  profileImportDone: 'Perfil importado',
  profileImportInvalid: 'Arquivo de perfil inválido',
  repairTitle: 'Reparo',
  recoveredRun: 'Execução anterior interrompida recuperada do estado persistido',
  breakingTitle: 'Análise de breaking changes',
  rollbackScopeNote: 'Rollback cobre apenas efeitos reversíveis documentados',
  usage: `forge-cli — instalador do ecossistema Forge

Uso:
  forge-cli [opções]            Modo interativo (padrão)
  forge-cli --all --yes         Instala tudo sem perguntar
  forge-cli --only a,b --yes    Instala uma seleção sem perguntar
  forge-cli --plan              Mostra o plano por repositório e sai
  forge-cli doctor [--fix]      Diagnostica; --fix repara os que falharem
  forge-cli list                Lista o catálogo e o último estado conhecido
  forge-cli install [forjas]    Instala uma ou mais Forjas (sem nomes: interativo)
                                --method registry instala do PyPI em venv isolada
  forge-cli clone <forjas>      Só clona/sincroniza; não executa scripts
  forge-cli update [forjas]     Atualiza (pull + setup); --check só verifica
                                --method registry: mais nova no PyPI; respeita pin; --check plano
  forge-cli versions [forjas]   Lista tags/versões e revisão atual
  forge-cli reinstall <forjas>  Reexecuta o setup mantendo a revisão atual; --clean recria o clone
                                --method registry: reinstala a mesma versão do receipt (drift)
  forge-cli pin <forja> --version <tag>   Fixa a versão (update/install respeitam)
  forge-cli unpin <forja>       Remove a fixação
  forge-cli rollback <forja>    Volta o checkout ao HEAD anterior registrado
                                --method registry: desempilha a versão anterior do receipt
  forge-cli uninstall <forjas>  Remove clones limpos (backup de .env/configs; exige --yes)
  forge-cli components [forjas] Mostra o instalador nativo e as flags suportadas por Forja
  forge-cli help                Mostra esta ajuda
  forge-cli status [forjas]     Estado local (clonado, versão, alterações)
  forge-cli discover            Descoberta limitada do ambiente + sinais
  forge-cli recommend           Recomendações explicáveis a partir dos sinais
  forge-cli env <verbo> [forja] Inteligência de .env: inspect|plan|init|validate|migrate|doctor
                                wizard: assistente interativo (máscara, default, validação, .env.bak)
  forge-cli hosts [verbo]       Hosts de IA: list|plan|register|validate|rollback
  forge-cli mcp [forja…]        Comando MCP por Forja (clone ou venv registry)
                                --verify: handshake + tools/list + tools/call da
                                tool allowlisted do catálogo (níveis cumulativos)
  forge-cli self install        Registra forge-cli no PATH do usuário
  forge-cli self uninstall      Remove o registro do PATH
  forge-cli self update         Atualiza o próprio CLI conforme o método de instalação
  forge-cli ask <domínio>       Inteligência determinística: discovery|recommendation|repair
  forge-cli predict             Compatibilidade preditiva (evidência + versão + certeza)
  forge-cli context             Contexto estruturado limitado (base do modo IA)
  forge-cli ai <tarefa>         Modo IA opcional (opt-in via forge-cli.config.json)
  forge-cli bundle <verbo>      Portabilidade: export [chaves-não-secretas...]|import|verify
  forge-cli learning <verbo>    Observações locais opt-in: status|enable|disable|report
  forge-cli uninstall           Sem nomes: remove o registro do PATH (legado)
  forge-cli registry            Lista o catálogo PyPI e o que está instalado via registry
  forge-cli registry lock <f>   Gera <forja>.offline-lock.json (fecho transitivo,
                                sha256 + tags; online uma vez, exige pip >= 23)
  forge-cli registry install <f> --offline --lock <arquivo>
                                Instala travado: fecho verificado + --no-index
  forge-cli --version           Versão do forge-cli

Opções:
  --dir <caminho>    Diretório de instalação (padrão: ./forge-workspace)
  --all              Seleciona todos os repositórios do catálogo
  --only a,b         Seleciona repositórios por nome
  -y, --yes          Não pede confirmação
  --plan, --dry-run  Só mostra o que seria executado
  --skip-scripts     Pula scripts de setup e npm
  --skip-verify      Pula a verificação pós-setup
  --timeout <seg>    Timeout por comando (padrão: 900)
  --json             Grava relatório JSON em .forge-cli/reports/
  --report <path>    Grava relatório JSON em caminho próprio
  --retry-failed     Reexecuta só os repositórios que falharam antes
  --jobs <n>         Processa até n repositórios em paralelo (1-8; só não-interativo)
  --only-changed     Pula repositórios cujo HEAD não mudou desde o último ok
  --shallow          Clona com git clone --depth 1 (só clones novos)
  --ref <rev>        Fixa a Forja (uma só) em commit/tag (checkout destacado)
  --version <tag>    Fixa a Forja (uma só) em uma versão (tag, com ou sem 'v')
  --method <m>       Método de instalação: git (clone+setup) ou registry (PyPI+venv)
  --offline          Sem rede: registry resolve pelo cache PyPI + wheel cache;
                     no método git só usa clones já existentes (cache parcial)
  --lock <arquivo>   Com --offline: instalação travada por offline-lock.json
  --out <path>       Com 'registry lock': destino do lock (arquivo ou dir)
  --no-color         Desativa ANSI (NO_COLOR no ambiente também vale)
  --clean            Com 'reinstall': remove e reclona na mesma revisão (com backup)
  --profile <p>      Instalador nativo da Forja: minimal|recommended|full
  --scope <s>        Instalador nativo da Forja: project|workspace|user
  --components <a,b> Instalador nativo da Forja: ex. skills,agents,mcp
  --verbose          Mostra a saída completa dos comandos (e não só as últimas linhas)
  --host <h>         Instalador nativo: claude|devin|codex|copilot|all (onde suportado)
  --gateway-profile <g>  Instalador nativo: economy|balanced|deep (onde suportado)
  --native           Com update/uninstall: aciona também a operação nativa da Forja
  --check            Com 'update': só verifica atualizações, sem alterar nada
  --trust-custom     Executa scripts de repositórios do forge-cli.repos.json
  --run-after-sync-failure  Executa scripts mesmo após falha de pull/remote divergente
  -h, --help         Mostra esta ajuda

Extras:
  forge-cli.repos.json no diretório alvo adiciona repositórios ao catálogo.
  forge-cli.config.json no diretório alvo define padrões (only, timeout,
  json, shallow, jobs, ai) — flags explícitas sempre vencem o arquivo.
  Artefatos (logs, estado, relatórios) ficam em <dir>/.forge-cli/
`,
  askTitle: 'Inteligência Forge',
  intelBadDomain: 'Domínio desconhecido — use discovery|recommendation|repair',
  intelNoEvidence: 'sem evidência registrada',
  intelLimits: 'limites:',
  predictTitle: 'Compatibilidade preditiva',
  predictNone: 'Nenhuma incompatibilidade prevista — sem evidência de risco',
  contextTitle: 'Contexto Forge (limitado, sem segredos)',
  aiTitle: 'Modo IA (opcional)',
  aiBadTask: 'Tarefa de IA desconhecida',
  aiDisabled: 'Modo IA desativado — comportamento determinístico em vigor',
  aiFailed: 'Modo IA falhou',
  aiCached: 'resposta do cache local',
  bundleNeedsPath: 'Informe o caminho do bundle',
  bundleExported: 'Bundle exportado (sem segredos)',
  bundleImported: 'Bundle importado e verificado',
  bundlePins: 'pins',
  bundleInvalid: 'Bundle inválido',
  bundleTampered: 'Integridade violada — arquivos divergentes',
  bundleIntact: 'Integridade verificada — bundle íntegro',
  bundleSecretRefused: 'Exportação recusada — chaves parecem secretas',
  bundleBadVerb: 'Verbo desconhecido — use export|import|verify',
  learningTitle: 'Observações locais (opt-in)',
  learningEnabled: 'Aprendizado local ativado — só observações, nunca altera política',
  learningDisabled: 'Aprendizado local desativado',
  learningOn: 'ativado',
  learningOff: 'desativado',
  learningEmpty: 'Nenhuma observação registrada',
};
