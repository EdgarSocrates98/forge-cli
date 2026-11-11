import os from 'node:os';
import { discoverEnvironment } from '../env/discover.js';
import { commandOutput } from '../utils/system.js';
import type { EnvironmentCapabilities, CapabilityState } from './contracts.js';

export type EnvironmentProfile = EnvironmentCapabilities['profile'];

function state(found: boolean, reason?: string | null): CapabilityState {
  return found ? 'AVAILABLE' : reason ? 'UNAVAILABLE' : 'UNKNOWN';
}

/** Maps the existing environment discovery contract to the adaptive contract. */
export async function resolveCapabilities(
  options: {
    workspace?: string;
    profile?: EnvironmentProfile;
    offline?: boolean;
  } = {},
): Promise<EnvironmentCapabilities> {
  const report = await discoverEnvironment({
    workspace: options.workspace,
    offline: options.offline,
  });
  const npmVersion = await commandOutput('npm', ['--version']);
  const capabilities = [
    {
      name: 'git',
      state: state(report.git.present, report.git.present ? null : 'git ausente'),
      version: report.git.version,
      executable: report.git.executable,
      reason: report.git.present ? null : 'git não encontrado',
    },
    {
      name: 'node',
      state: state(Number(process.versions.node.split('.')[0]) >= 20),
      version: process.version,
      executable: process.execPath,
      reason:
        Number(process.versions.node.split('.')[0]) >= 20 ? null : 'Node.js >=20 é necessário',
    },
    {
      name: 'npm',
      state: state(npmVersion !== null),
      version: npmVersion?.trim() ?? null,
      executable: npmVersion ? 'npm' : null,
      reason: npmVersion ? null : 'npm não encontrado',
    },
    {
      name: 'python',
      state: state(report.python.present, report.python.refusal?.cause),
      version: report.python.version,
      executable: report.python.exe,
      reason: report.python.present
        ? null
        : (report.python.refusal?.cause ?? 'Python não encontrado'),
    },
    {
      name: 'network',
      state: options.offline ? ('BLOCKED' as const) : ('UNKNOWN' as const),
      version: null,
      executable: null,
      reason: options.offline ? 'perfil offline estrito' : 'rede não sondada por segurança',
    },
    {
      name: 'admin',
      state: 'BLOCKED' as const,
      version: null,
      executable: null,
      reason: 'o CLI não solicita elevação administrativa',
    },
  ];
  const shellAvailable = report.route.selected !== 'none';
  const selectedProfile = options.profile ?? (options.offline ? 'offline-strict' : 'auto');
  const operations: EnvironmentCapabilities['operations'] = {
    scan: { state: 'AVAILABLE', route: 'node', reasons: [] },
    plan: { state: 'AVAILABLE', route: 'node', reasons: [] },
    activate: {
      state: shellAvailable ? 'AVAILABLE' : 'BLOCKED',
      route: report.route.selected,
      reasons: shellAvailable ? [] : ['nenhuma shell suportada'],
    },
    install: {
      state: report.git.present || report.python.present || npmVersion ? 'AVAILABLE' : 'BLOCKED',
      route: report.route.selected,
      reasons: [],
    },
    update: {
      state: report.git.present ? 'AVAILABLE' : 'BLOCKED',
      route: report.git.present ? 'git' : null,
      reasons: report.git.present ? [] : ['git ausente'],
    },
    publish: {
      state: 'BLOCKED',
      route: null,
      reasons: ['publicação exige autorização explícita e não é automática'],
    },
  };
  const restrictions = [
    ...(options.offline ? ['offline: nenhuma operação de rede deve ser executada'] : []),
    ...(report.route.selected === 'none'
      ? ['Windows sem PowerShell/Git Bash: scripts nativos bloqueados']
      : []),
    'comandos declarados por manifests não são executados automaticamente',
  ];
  return {
    schema: 'forge/EnvironmentCapabilities/v1',
    generated_at: new Date().toISOString(),
    platform: process.platform,
    arch: os.arch(),
    profile: selectedProfile,
    shell: {
      selected: report.route.selected === 'none' ? null : report.route.selected,
      candidates: (
        [
          ['powershell', report.shells.powershell],
          ['pwsh', report.shells.pwsh],
          ['git_bash', report.shells.git_bash],
        ] as [string, { present: boolean }][]
      )
        .filter(([, shell]) => shell.present)
        .map(([name]) => name),
    },
    capabilities,
    operations,
    restrictions,
  };
}
