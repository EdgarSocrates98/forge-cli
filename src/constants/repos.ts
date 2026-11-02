import type { ForgeRepo } from '../types.js';

export const FORGE_REPOS: ForgeRepo[] = [
  {
    name: 'the-forge',
    url: 'https://github.com/EdgarSocrates98/the-forge',
    description: 'Framework base e utilitários',
    kind: 'python',
    verify: ['theforge', '--help'],
    nativeInstall: {
      command: ['theforge', 'install', 'apply'],
      flags: ['scope', 'profile', 'components', 'host'],
      ops: {
        update: ['theforge', 'install', 'update'],
        uninstall: ['theforge', 'install', 'uninstall'],
      },
    },
    nextSteps: ['theforge install apply --yes', 'theforge doctor'],
  },
  {
    name: 'spark-forge-aws',
    url: 'https://github.com/EdgarSocrates98/spark-forge-aws',
    description: 'Pipelines Spark para AWS',
    kind: 'python',
    verify: ['sparkforge-aws', '--help'],
    nativeInstall: {
      command: ['sparkforge-aws', 'install'],
      flags: ['scope', 'profile', 'components', 'host', 'gateway-profile'],
      ops: { update: ['sparkforge-aws', 'update'], uninstall: ['sparkforge-aws', 'uninstall'] },
    },
    nextSteps: ['sparkforge-aws install'],
  },
  {
    name: 'spark-forge-azure',
    url: 'https://github.com/EdgarSocrates98/spark-forge-azure',
    description: 'Pipelines Spark para Azure',
    kind: 'python',
    verify: ['sparkforge-azure', '--help'],
    nativeInstall: {
      command: ['sparkforge-azure', 'install'],
      flags: ['scope', 'profile', 'components', 'host', 'gateway-profile'],
      ops: {
        update: ['sparkforge-azure', 'install', 'update'],
        uninstall: ['sparkforge-azure', 'install', 'uninstall'],
      },
    },
    nextSteps: ['sparkforge-azure install'],
  },
  {
    name: 'platform-forge',
    url: 'https://github.com/EdgarSocrates98/platform-forge',
    description: 'Serviços e infra de plataforma',
    kind: 'python',
    verify: ['platformforge', '--help'],
    nativeInstall: {
      command: ['platformforge', 'install'],
      flags: ['scope', 'profile', 'components'],
      ops: { update: ['platformforge', 'upgrade'], uninstall: ['platformforge', 'uninstall'] },
    },
    nextSteps: ['platformforge doctor', 'platformforge init --repo .'],
  },
  {
    name: 'api-forge',
    url: 'https://github.com/EdgarSocrates98/api-forge',
    description: 'Backend central e APIs',
    kind: 'python',
    verify: ['apiforge', '--help'],
    nativeInstall: {
      command: ['apiforge', 'install'],
      flags: ['scope', 'profile', 'components', 'host', 'gateway-profile'],
      ops: {
        update: ['apiforge', 'install', 'update'],
        uninstall: ['apiforge', 'install', 'uninstall'],
      },
    },
    envKeys: ['APIFORGE_HOME', 'APIFORGE_CONFIG', 'APIFORGE_CACHE'],
    nextSteps: ['apiforge install --yes'],
  },
  {
    name: 'forge-doctor-api',
    url: 'https://github.com/EdgarSocrates98/forge-doctor-api',
    description: 'API de diagnóstico e telemetria',
    kind: 'python',
    verify: ['forge-doctor-api', '--help'],
    nativeInstall: {
      command: ['{python}', 'scripts/forge_install.py', 'install'],
      flags: ['scope', 'profile', 'components', 'host', 'gateway-profile'],
      ops: {
        update: ['{python}', 'scripts/forge_install.py', 'update'],
        uninstall: ['{python}', 'scripts/forge_install.py', 'uninstall'],
      },
    },
    nextSteps: ['forge-doctor-api install'],
  },
  {
    name: 'forge-doctor-data',
    url: 'https://github.com/EdgarSocrates98/forge-doctor-data',
    description: 'Pipeline de dados de diagnóstico',
    kind: 'python',
    verify: ['forge-doctor-data', '--help'],
    nativeInstall: {
      command: ['forge-doctor-data', 'install'],
      flags: ['scope', 'profile', 'components', 'gateway-profile'],
      ops: {
        update: ['forge-doctor-data', 'install', 'update'],
        uninstall: ['forge-doctor-data', 'install', 'uninstall'],
      },
    },
    nextSteps: ['forge-doctor-data install'],
  },
  {
    name: 'forge-portal',
    url: 'https://github.com/EdgarSocrates98/forge-portal',
    description: 'Frontend / Portal Web',
    kind: 'node',
    verify: ['npx', '--no-install', 'ng', 'version'],
    nextSteps: ['npm start'],
  },
  {
    // Instalação via fonte até existir uma distribuição oficial no registry.
    name: 'data-sentinel-forge',
    url: 'https://github.com/EdgarSocrates98/data-sentinel-forge',
    description: 'Diagnóstico de runtime (logs/plans Spark, doctor-bundles)',
    kind: 'python',
    verify: ['data-sentinel', '--help'],
    nativeInstall: {
      command: ['data-sentinel', 'install'],
      flags: ['scope', 'profile', 'components', 'host'],
      ops: {
        update: ['data-sentinel', 'install', 'update'],
        uninstall: ['data-sentinel', 'install', 'uninstall'],
      },
    },
    nextSteps: ['data-sentinel install', 'data-sentinel doctor'],
  },
  {
    name: 'forge-lens',
    url: 'https://github.com/EdgarSocrates98/forge-lens',
    description: 'Observabilidade, traces, custos e avaliação de agentes',
    kind: 'python',
    verify: ['forge-lens', '--help'],
    nativeInstall: {
      command: ['forge-lens', 'install'],
      flags: ['scope', 'profile', 'components', 'host'],
      ops: {
        update: ['forge-lens', 'install', 'update'],
        uninstall: ['forge-lens', 'install', 'uninstall'],
      },
    },
    nextSteps: ['forge-lens install', 'forge-lens doctor'],
  },
  {
    name: 'code-atlas-forge',
    url: 'https://github.com/EdgarSocrates98/code-atlas-forge',
    description: 'Índice e exploração estrutural de código',
    kind: 'python',
    verify: ['code-atlas', '--help'],
    nextSteps: ['code-atlas doctor', 'code-atlas status'],
  },
  {
    name: 'product-forge',
    url: 'https://github.com/EdgarSocrates98/product-forge',
    description: 'Workspace de PM/PA, produtos, tarefas e agentes',
    kind: 'python',
    verify: ['productforge', '--help'],
    nativeInstall: {
      command: ['productforge', 'install'],
      flags: ['scope', 'profile', 'components', 'host'],
      ops: {
        update: ['productforge', 'update'],
        uninstall: ['productforge', 'uninstall'],
      },
    },
    nextSteps: ['productforge install', 'productforge portal'],
  },
  {
    name: 'forge-agent-bridge',
    url: 'https://github.com/EdgarSocrates98/forge-agent-bridge',
    description: 'Bridge local para Claude, Codex, Devin e GitHub Copilot',
    kind: 'python',
    verify: ['forge-bridge', '--help'],
    nativeInstall: {
      command: ['forge-bridge', 'install'],
      flags: ['scope', 'profile', 'components', 'host'],
      ops: {
        update: ['forge-bridge', 'install', 'update'],
        uninstall: ['forge-bridge', 'uninstall'],
      },
    },
    nextSteps: ['forge-bridge install', 'forge-bridge doctor'],
  },
];
