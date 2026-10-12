import type { ForgeRepo } from '../types.js';

export const FORGE_REPOS: ForgeRepo[] = [
  {
    name: 'the-forge',
    url: 'https://github.com/EdgarSocrates98/the-forge',
    description: 'Framework base e utilitários',
    verify: ['theforge', '--help'],
    nextSteps: ['theforge install apply --yes', 'theforge doctor'],
  },
  {
    name: 'spark-forge-aws',
    url: 'https://github.com/EdgarSocrates98/spark-forge-aws',
    description: 'Pipelines Spark para AWS',
    verify: ['sparkforge-aws', '--help'],
    nextSteps: ['sparkforge-aws install'],
  },
  {
    name: 'spark-forge-azure',
    url: 'https://github.com/EdgarSocrates98/spark-forge-azure',
    description: 'Pipelines Spark para Azure',
    verify: ['sparkforge-azure', '--help'],
    nextSteps: ['sparkforge-azure install'],
  },
  {
    name: 'platform-forge',
    url: 'https://github.com/EdgarSocrates98/platform-forge',
    description: 'Serviços e infra de plataforma',
    verify: ['platformforge', '--help'],
    nextSteps: ['platformforge doctor', 'platformforge init --repo .'],
  },
  {
    name: 'api-forge',
    url: 'https://github.com/EdgarSocrates98/api-forge',
    description: 'Backend central e APIs',
    verify: ['apiforge', '--help'],
    envKeys: ['APIFORGE_HOME', 'APIFORGE_CONFIG', 'APIFORGE_CACHE'],
    nextSteps: ['apiforge install --yes'],
  },
  {
    name: 'forge-doctor-api',
    url: 'https://github.com/EdgarSocrates98/forge-doctor-api',
    description: 'API de diagnóstico e telemetria',
    verify: ['forge-doctor-api', '--help'],
    nextSteps: ['forge-doctor-api install'],
  },
  {
    name: 'forge-doctor-data',
    url: 'https://github.com/EdgarSocrates98/forge-doctor-data',
    description: 'Pipeline de dados de diagnóstico',
    verify: ['forge-doctor-data', '--help'],
    nextSteps: ['forge-doctor-data install'],
  },
  {
    name: 'forge-portal',
    url: 'https://github.com/EdgarSocrates98/forge-portal',
    description: 'Frontend / Portal Web',
    verify: ['npx', '--no-install', 'ng', 'version'],
    nextSteps: ['npm start'],
  },
];
