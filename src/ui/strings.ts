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
  errCloneNeedsNames: 'clone exige nomes de Forjas (ou --all/--only)',
  errUnknownCommand: 'Comando desconhecido',
  errRefDirty: 'Working tree com alterações locais — não é seguro trocar de revisão',
  refCheckedOut: 'Revisão',
  errRefNeedsOne: '--ref/--version exigem exatamente uma Forja',
  errRefExclusive: 'Use apenas um entre --ref e --version',
  errRefInvalid: 'Revisão/versão inválida',
  updateCheckTitle: 'Verificação de atualizações',
  updateCheckFailed: 'não foi possível verificar',
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
  menuInstallHint: 'clona e executa os instaladores',
  menuUpdate: 'Atualizar Forjas',
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
  usage: `forge-cli — instalador do ecossistema Forge

Uso:
  forge-cli [opções]            Modo interativo (padrão)
  forge-cli --all --yes         Instala tudo sem perguntar
  forge-cli --only a,b --yes    Instala uma seleção sem perguntar
  forge-cli --plan              Mostra o plano por repositório e sai
  forge-cli doctor [--fix]      Diagnostica; --fix repara os que falharem
  forge-cli list                Lista o catálogo e o último estado conhecido
  forge-cli install [forjas]    Instala uma ou mais Forjas (sem nomes: interativo)
  forge-cli clone <forjas>      Só clona/sincroniza; não executa scripts
  forge-cli update [forjas]     Atualiza (pull + setup); --check só verifica
  forge-cli versions [forjas]   Lista tags/versões e revisão atual
  forge-cli reinstall <forjas>  Reexecuta o setup mantendo a revisão atual; --clean recria o clone
  forge-cli pin <forja> --version <tag>   Fixa a versão (update/install respeitam)
  forge-cli unpin <forja>       Remove a fixação
  forge-cli rollback <forja>    Volta o checkout ao HEAD anterior registrado
  forge-cli uninstall <forjas>  Remove clones limpos (backup de .env/configs; exige --yes)
  forge-cli status [forjas]     Estado local (clonado, versão, alterações)
  forge-cli self install        Registra forge-cli no PATH do usuário
  forge-cli self uninstall      Remove o registro do PATH
  forge-cli self update         Atualiza o próprio CLI conforme o método de instalação
  forge-cli uninstall           Sem nomes: remove o registro do PATH (legado)

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
  --clean            Com 'reinstall': remove e reclona na mesma revisão (com backup)
  --profile <p>      Instalador nativo da Forja: minimal|recommended|full
  --scope <s>        Instalador nativo da Forja: project|workspace|user
  --components <a,b> Instalador nativo da Forja: ex. skills,agents,mcp
  --check            Com 'update': só verifica atualizações, sem alterar nada
  --trust-custom     Executa scripts de repositórios do forge-cli.repos.json
  --run-after-sync-failure  Executa scripts mesmo após falha de pull/remote divergente
  -h, --help         Mostra esta ajuda

Extras:
  forge-cli.repos.json no diretório alvo adiciona repositórios ao catálogo.
  forge-cli.config.json no diretório alvo define padrões (only, timeout,
  json, shallow, jobs) — flags explícitas sempre vencem o arquivo.
  Artefatos (logs, estado, relatórios) ficam em <dir>/.forge-cli/
`,
};
