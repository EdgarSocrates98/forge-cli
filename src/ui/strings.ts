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
  warnPullFailed: 'Pull falhou — seguindo com a versão local',
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
  customReposLoaded: 'Repositórios extras carregados de forge-cli.repos.json',
  logSaved: 'Log salvo em',
  reportSaved: 'Relatório JSON salvo em',
  doctorTitle: 'Diagnóstico — verificação dos repositórios',
  doctorNoCheckout: 'sem checkout neste diretório',
  doctorNoVerify: 'sem comando de verificação',
  usage: `forge-cli — instalador do ecossistema Forge

Uso:
  forge-cli [opções]            Modo interativo (padrão)
  forge-cli --all --yes         Instala tudo sem perguntar
  forge-cli --only a,b --yes    Instala uma seleção sem perguntar
  forge-cli --plan              Mostra o plano por repositório e sai
  forge-cli doctor [--dir ..]   Verifica repositórios já instalados

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
  -h, --help         Mostra esta ajuda

Extras:
  forge-cli.repos.json no diretório alvo adiciona repositórios ao catálogo.
  Artefatos (logs, estado, relatórios) ficam em <dir>/.forge-cli/
`,
};
