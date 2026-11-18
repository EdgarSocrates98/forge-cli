import { describe, expect, it } from 'vitest';
import { childEnv, commandEnv, envAllowList, portableEnv } from '../src/utils/system.js';

/**
 * P0 wave-14: subprocessos nunca herdam `process.env` inteiro — nomes
 * credential-shaped são negados antes da allowlist de toolchain/OS, e
 * `FORGE_CLI_ENV_ALLOW` é o único escape hatch (explícito do operador).
 */
const AMBIENT: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/dev',
  LANG: 'en_US.UTF-8',
  TZ: 'UTC',
  USER: 'dev',
  // toolchain típico
  HTTP_PROXY: 'http://corp:8080',
  PIP_INDEX_URL: 'https://pypi.corp/simple',
  NPM_CONFIG_REGISTRY: 'https://npm.corp',
  PYENV_ROOT: '/home/dev/.pyenv',
  NVM_DIR: '/home/dev/.nvm',
  XDG_CACHE_HOME: '/home/dev/.cache',
  FORGE_CLI_HOME: '/home/dev/.forge-cli-test',
  VIRTUAL_ENV: '/home/dev/proj/.venv',
  SSL_CERT_FILE: '/etc/ssl/corp.pem',
  // credenciais — TODAS devem sumir
  GITHUB_TOKEN: 'ghp_secret',
  GH_TOKEN: 'gho_secret',
  AWS_SECRET_ACCESS_KEY: 'aws_secret',
  AWS_ACCESS_KEY_ID: 'AKIA...',
  AWS_SESSION_TOKEN: 'sess',
  OPENAI_API_KEY: 'sk-secret',
  ANTHROPIC_API_KEY: 'sk-ant',
  NPM_CONFIG_TOKEN: 'npm_secret',
  TWINE_PASSWORD: 'twine_secret',
  PIP_PASSWORD: 'pip_secret',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  KRB5CCNAME: 'FILE:/tmp/krb5',
  MY_CUSTOM_SECRET: 'x',
  DATABASE_URL: 'postgres://u:p@h/db',
  GIT_SSH_COMMAND: 'ssh -i /key',
  SOME_RANDOM_VAR: 'random',
};

const DENIED = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SESSION_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NPM_CONFIG_TOKEN',
  'TWINE_PASSWORD',
  'PIP_PASSWORD',
  'SSH_AUTH_SOCK',
  'MY_CUSTOM_SECRET',
  'DATABASE_URL',
  'SOME_RANDOM_VAR',
];

describe('childEnv — scrub de credenciais (P0-1)', () => {
  it('nomes credential-shaped NUNCA chegam ao filho', () => {
    const env = childEnv({ base: AMBIENT });
    for (const key of DENIED) expect(env[key], key).toBeUndefined();
  });

  it('AWS_* com cara de credencial morre; config AWS inócua passa', () => {
    const env = childEnv({ base: { ...AMBIENT, AWS_PROFILE: 'dev', AWS_REGION: 'us-east-1' } });
    expect(env.AWS_PROFILE).toBe('dev');
    expect(env.AWS_REGION).toBe('us-east-1');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
  });

  it('toolchain/OS allowlist sobrevive', () => {
    const env = childEnv({ base: AMBIENT });
    for (const key of [
      'PATH',
      'HOME',
      'LANG',
      'TZ',
      'USER',
      'HTTP_PROXY',
      'PIP_INDEX_URL',
      'NPM_CONFIG_REGISTRY',
      'PYENV_ROOT',
      'NVM_DIR',
      'XDG_CACHE_HOME',
      'FORGE_CLI_HOME',
      'VIRTUAL_ENV',
      'SSL_CERT_FILE',
      'KRB5CCNAME',
    ]) {
      expect(env[key], key).toBe(AMBIENT[key]);
    }
  });

  it('GIT_TERMINAL_PROMPT=0 sempre injetado — filho nunca pede credencial', () => {
    expect(childEnv({ base: {} }).GIT_TERMINAL_PROMPT).toBe('0');
    expect(childEnv({ base: { GIT_TERMINAL_PROMPT: '1' } }).GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('env vazio → PATH ausente (o spawn resolve pelo execa), nada inventado', () => {
    const env = childEnv({ base: {} });
    expect(env.PATH).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});

describe('commandEnv — variações por comando', () => {
  it('git recebe prefixos GIT_/SSH_ a mais (SSH_AUTH_SOCK para git@…)', () => {
    const env = commandEnv('git', {});
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    const gitEnv = childEnv({ allowPrefixes: ['GIT_', 'SSH_'], base: AMBIENT });
    expect(gitEnv.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock');
    expect(gitEnv.GIT_SSH_COMMAND).toBe('ssh -i /key');
  });

  it('não-git NÃO recebe SSH_AUTH_SOCK nem GIT_*', () => {
    const env = childEnv({ base: AMBIENT });
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
  });

  it('portableEnv mantém o scrub (não reabre process.env)', () => {
    const env = portableEnv({});
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('nome fora da allowlist não passa nem com base explícita', () => {
    const env = childEnv({ base: { X: '1' } });
    expect(env.X).toBeUndefined();
  });
});

describe('FORGE_CLI_ENV_ALLOW — escape hatch explícito', () => {
  it('re-admite nomes declarados, inclusive credential-shaped', () => {
    const base = { ...AMBIENT, FORGE_CLI_ENV_ALLOW: 'GITHUB_TOKEN,MY_CUSTOM_SECRET' };
    const env = childEnv({ base });
    expect(env.GITHUB_TOKEN).toBe('ghp_secret');
    expect(env.MY_CUSTOM_SECRET).toBe('x');
    // o que não foi pedido continua fora
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('ignora entradas malformadas na lista', () => {
    expect(envAllowList({ FORGE_CLI_ENV_ALLOW: 'ok_name,,;not a name;DROP TABLE' })).toEqual(
      new Set(['OK_NAME']),
    );
  });

  it('allow do caller por nome e por prefixo funcionam', () => {
    const env = childEnv({
      base: AMBIENT,
      allow: ['DATABASE_URL'],
      allowPrefixes: ['OPENAI_'],
    });
    expect(env.DATABASE_URL).toBe('postgres://u:p@h/db');
    expect(env.OPENAI_API_KEY).toBe('sk-secret');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
