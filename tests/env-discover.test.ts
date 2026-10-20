/**
 * lf-0016 — descoberta de ambiente (`forge/EnvironmentDiscovery/v1`),
 * rota de shells Windows, matriz de alvos de escrita e preflight agregado.
 * Nenhum spawn real de PowerShell: toda sonda é injetada (ProbeRun fake)
 * ou responde por arquivos-fixture — POSIX nunca toca powershell.exe.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contractValidator } from '../src/contracts/index.js';
import {
  discoverEnvironment,
  ENVIRONMENT_DISCOVERY_SCHEMA,
  type DiscoverDeps,
} from '../src/env/discover.js';
import { resolveWriteTargets } from '../src/env/paths.js';
import {
  discoverShells,
  SHELL_PROBE_TIMEOUT_MS,
  windowsRoute,
  type ProbeRun,
  type ShellDiscovery,
} from '../src/env/shells.js';
import { localInstall, type LocalDeps } from '../src/source/install.js';
import { parseCliArgs } from '../src/cli-args.js';
import { runEnvCommand } from '../src/cmd/env.js';
import type { ForgeState } from '../src/registry/install.js';
import { findSetupScript } from '../src/utils/system.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'env-disc-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** ProbeRun fake — chave = `cmd args…`; ausente = falha silenciosa. */
function fakeRun(
  responses: Record<string, string | { ok?: boolean; output?: string | null; timed_out?: boolean }>,
): ProbeRun {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    const hit = responses[key];
    if (hit === undefined) return { ok: false, output: null, timed_out: false };
    if (typeof hit === 'string') return { ok: true, output: hit, timed_out: false };
    return {
      ok: hit.ok ?? hit.output != null,
      output: hit.output ?? null,
      timed_out: hit.timed_out ?? false,
    };
  };
}

const PS_PROBE = '-NoProfile -Command $PSVersionTable.PSVersion.ToString()';

function winRun(partial: Record<string, string> = {}): ProbeRun {
  return fakeRun(partial);
}

/** exists() que aceita sufixos — separadores variam entre os testes e o OS real. */
function existsMatching(...needles: string[]): (target: string) => boolean {
  const norm = (p: string) => p.toLowerCase().replace(/\//g, '\\');
  return (target) => {
    const t = norm(target);
    return needles.some((n) => t.endsWith(norm(n)) || t === norm(n));
  };
}

describe('shell discovery — powershell vs pwsh separados', () => {
  it('reporta powershell.exe e pwsh como capacidades independentes', async () => {
    const shells = await discoverShells({
      platform: 'win32',
      run: winRun({
        [`powershell.exe ${PS_PROBE}`]: '5.1.22621.4391',
        [`pwsh ${PS_PROBE}`]: '7.4.6',
        'bash --version': 'GNU bash, version 5.2.26(1)-release (x86_64-pc-msys)',
        'where.exe bash': 'C:\\Program Files\\Git\\bin\\bash.exe',
      }),
      exists: existsMatching('Git\\bin\\bash.exe'),
      env: {},
    });
    expect(shells.powershell.present).toBe(true);
    expect(shells.powershell.version).toContain('5.1');
    expect(shells.pwsh.present).toBe(true);
    expect(shells.pwsh.version).toContain('7.4');
    expect(shells.powershell.executable).not.toBe(shells.pwsh.executable);
    // probes carregam a evidência do comando exato
    expect(shells.powershell.probes.version.command).toContain('powershell.exe');
  });

  it('powershell.exe ausente com pwsh presente → rota pwsh', async () => {
    const shells = await discoverShells({
      platform: 'win32',
      run: winRun({ [`pwsh ${PS_PROBE}`]: '7.4.6' }),
      exists: () => false,
      env: {},
    });
    expect(shells.powershell.present).toBe(false);
    expect(windowsRoute(shells).route).toBe('pwsh');
    expect(windowsRoute(shells).ps).toBe('pwsh');
  });
});

describe('shell discovery — Git Bash executado, não adivinhado', () => {
  it('bash.exe do Git verificado por --version + exec -lc', async () => {
    const bashExe = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const shells = await discoverShells({
      platform: 'win32',
      run: winRun({
        'bash --version': 'GNU bash, version 5.2.26(1)-release',
        'where.exe bash': `${bashExe}\nC:\\Windows\\System32\\bash.exe`,
        'git --exec-path': 'C:/Program Files/Git/mingw64/libexec/git-core',
        [`${bashExe} --version`]: 'GNU bash, version 5.2.26(1)-release',
        [`${bashExe} -lc echo forge-gitbash-ok`]: 'forge-gitbash-ok',
      }),
      exists: existsMatching(bashExe),
      env: {},
    });
    expect(shells.git_bash.present).toBe(true);
    expect(shells.git_bash.executable).toBe(bashExe);
    expect(shells.git_bash.kind).toBe('git-bash');
    // evidência de execução no probes{}
    expect(shells.git_bash.probes[`exec:${bashExe}`]?.ok).toBe(true);
    expect(shells.bash.kind).toBe('git-bash');
  });

  it('bash.exe existe no disco mas não executa → ausente (unavailable)', async () => {
    const bashExe = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const shells = await discoverShells({
      platform: 'win32',
      run: winRun({}),
      exists: existsMatching(bashExe),
      env: {},
    });
    expect(shells.git_bash.present).toBe(false);
    // existe no disco mas nenhuma sonda executou → candidato quebrado
    expect(shells.git_bash.probes[`exists:${bashExe}`]?.ok).toBe(true);
  });

  it('POSIX nunca reporta git_bash/cygwin/msys2/wsl stubs', async () => {
    const shells = await discoverShells({
      platform: 'linux',
      run: fakeRun({ 'bash --version': 'GNU bash 5.2' }),
      exists: () => true,
      env: {},
    });
    expect(shells.git_bash.present).toBe(false);
    expect(shells.cygwin.present).toBe(false);
    expect(shells.msys2.present).toBe(false);
    expect(shells.bash.kind).toBe('native');
  });
});

describe('shell discovery — distinções WSL/Cygwin/MSYS2', () => {
  it('bash do System32 classifica como wsl-bash', async () => {
    const shells = await discoverShells({
      platform: 'win32',
      run: winRun({
        'bash --version': 'GNU bash, version 5.1.16(1)-release',
        'where.exe bash': 'C:\\Windows\\System32\\bash.exe',
      }),
      exists: () => false,
      env: {},
    });
    expect(shells.bash.kind).toBe('wsl-bash');
    // stub do WSL nunca alimenta os candidatos do Git Bash
    expect(shells.git_bash.present).toBe(false);
  });

  it('wsl.exe reportado; MSYSTEM só evidência, não presença de msys2', async () => {
    const shells = await discoverShells({
      platform: 'win32',
      run: winRun({
        'where.exe wsl.exe': 'C:\\Windows\\System32\\wsl.exe',
        'wsl.exe --status': 'Default Distribution: Ubuntu',
      }),
      exists: () => false,
      env: { MSYSTEM: 'MINGW64' },
    });
    expect(shells.wsl.present).toBe(true);
    expect(shells.wsl.version).toContain('Ubuntu');
    expect(shells.msys2.present).toBe(false);
  });

  it('dentro do WSL (env) reporta inside-wsl', async () => {
    const shells = await discoverShells({
      platform: 'linux',
      run: fakeRun({}),
      exists: () => false,
      env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' },
    });
    expect(shells.wsl.present).toBe(true);
    expect(shells.wsl.kind).toBe('inside-wsl');
  });

  it('cygwin e msys2 verificados por arquivos candidatos próprios', async () => {
    const cyg = 'C:\\cygwin64\\bin\\bash.exe';
    const msys = 'C:\\msys64\\usr\\bin\\bash.exe';
    const shells = await discoverShells({
      platform: 'win32',
      run: winRun({
        [`${cyg} --version`]: 'GNU bash, version 5.2.21(1)-release (cygwin)',
        [`${msys} --version`]: 'GNU bash, version 5.2.26(1)-release (msys2)',
      }),
      exists: existsMatching(cyg, msys),
      env: {},
    });
    expect(shells.cygwin.present).toBe(true);
    expect(shells.cygwin.kind).toBe('cygwin');
    expect(shells.msys2.present).toBe(true);
    expect(shells.msys2.kind).toBe('msys2');
    // nunca colapsam em Git Bash
    expect(shells.git_bash.present).toBe(false);
  });
});

describe('rota Windows — as quatro células', () => {
  const shellsWith = (p: Partial<ShellDiscovery>): ShellDiscovery => {
    const absent = { present: false, version: null, executable: null, kind: null, probes: {} };
    return {
      powershell: absent,
      pwsh: absent,
      bash: absent,
      git_bash: absent,
      wsl: absent,
      cygwin: absent,
      msys2: absent,
      ...p,
    };
  };
  const present = (executable: string): ShellDiscovery['bash'] => ({
    present: true,
    version: 'v',
    executable,
    kind: 'git-bash',
    probes: {
      version: { command: `${executable} --version`, ok: true, output: 'v', timed_out: false },
    },
  });

  it('powershell + git bash → rota powershell (bash fica de fallback)', () => {
    const route = windowsRoute(
      shellsWith({
        powershell: present('powershell.exe'),
        git_bash: present('C:\\Git\\bin\\bash.exe'),
      }),
    );
    expect(route.route).toBe('powershell');
    expect(route.ps).toBe('powershell.exe');
    expect(route.bash).toBe('C:\\Git\\bin\\bash.exe');
    expect(route.refusal).toBeUndefined();
  });

  it('powershell sem git bash → rota powershell', () => {
    const route = windowsRoute(shellsWith({ powershell: present('powershell.exe') }));
    expect(route.route).toBe('powershell');
    expect(route.bash).toBeUndefined();
  });

  it('powershell ausente + git bash executando → rota git_bash', () => {
    const route = windowsRoute(shellsWith({ git_bash: present('C:\\Git\\usr\\bin\\bash.exe') }));
    expect(route.route).toBe('git_bash');
    expect(route.bash).toBe('C:\\Git\\usr\\bin\\bash.exe');
  });

  it('nenhuma shell → FORGE-SHELL-NOT-FOUND com remédio acionável', () => {
    const route = windowsRoute(shellsWith({}));
    expect(route.route).toBe('none');
    expect(route.refusal?.code).toBe('FORGE-SHELL-NOT-FOUND');
    expect(route.refusal?.remedy).toContain('Git for Windows');
  });

  it('shell no disco que não executa → FORGE-SHELL-UNAVAILABLE', () => {
    const route = windowsRoute(
      shellsWith({
        powershell: {
          present: false,
          version: null,
          executable: null,
          kind: null,
          probes: {
            version: { command: 'powershell.exe …', ok: false, output: null, timed_out: false },
            file: {
              command: 'exists C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
              ok: true,
              output: null,
              timed_out: false,
            },
          },
        },
      }),
    );
    expect(route.route).toBe('none');
    expect(route.refusal?.code).toBe('FORGE-SHELL-UNAVAILABLE');
  });

  it('WSL presente nunca vira rota nativa', () => {
    const route = windowsRoute(shellsWith({ wsl: present('wsl.exe') }));
    expect(route.route).toBe('none');
    expect(route.refusal?.code).toBe('FORGE-SHELL-NOT-FOUND');
  });
});

describe('findSetupScript — rota por shells verificadas', () => {
  it('legado (sem winShells) continua só-powershell', () => {
    writeFileSync(path.join(tmp, 'setup.ps1'), '');
    writeFileSync(path.join(tmp, 'install.windows.sh'), '');
    const pick = findSetupScript(tmp, 'win32');
    expect(pick?.file).toBe('setup.ps1');
    expect(pick?.command).toBe('powershell.exe');
  });

  it('winShells.ps=pwsh → mesma cadeia .ps1 via pwsh', () => {
    writeFileSync(path.join(tmp, 'install.ps1'), '');
    const pick = findSetupScript(tmp, 'win32', { ps: 'pwsh' });
    expect(pick?.command).toBe('pwsh');
    expect(pick?.args).toContain('-File');
    expect(pick?.file).toBe('install.ps1');
  });

  it('rota git bash procura install.windows.sh primeiro', () => {
    writeFileSync(path.join(tmp, 'install.windows.sh'), '');
    writeFileSync(path.join(tmp, 'setup.sh'), '');
    const pick = findSetupScript(tmp, 'win32', { bash: 'C:\\Git\\bin\\bash.exe' });
    expect(pick?.command).toBe('C:\\Git\\bin\\bash.exe');
    expect(pick?.args).toEqual(['install.windows.sh']);
  });

  it('rota git bash cai para setup.sh POSIX quando não há install.windows.sh', () => {
    writeFileSync(path.join(tmp, 'install.sh'), '');
    const pick = findSetupScript(tmp, 'win32', { bash: 'C:\\Git\\bin\\bash.exe' });
    expect(pick?.command).toBe('C:\\Git\\bin\\bash.exe');
    expect(pick?.args).toEqual(['install.sh']);
  });

  it('ps+bash: .ps1 ganha; sem .ps1 cai para a cadeia bash', () => {
    writeFileSync(path.join(tmp, 'setup.sh'), '');
    const pick = findSetupScript(tmp, 'win32', {
      ps: 'powershell.exe',
      bash: 'C:\\Git\\bin\\bash.exe',
    });
    expect(pick?.command).toBe('C:\\Git\\bin\\bash.exe');
  });

  it('winShells={} (sondado, nada) → null', () => {
    writeFileSync(path.join(tmp, 'setup.ps1'), '');
    writeFileSync(path.join(tmp, 'install.windows.sh'), '');
    expect(findSetupScript(tmp, 'win32', {})).toBeNull();
  });
});

describe('matriz de alvos de escrita', () => {
  const envOf = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: '/home/user',
    FORGE_CLI_HOME: undefined,
    ...over,
  });
  const osHome = () => path.join(tmp, 'os-home');
  const cwd = () => path.join(tmp, 'cwd');
  const tmpD = () => path.join(tmp, 'tmpdir');
  const noDeny = () => true;

  it('prioridade: flag explícita > env > usuário > sistema', () => {
    const explicitHome = path.join(tmp, 'explicit-home');
    const t1 = resolveWriteTargets({
      env: envOf(),
      osHome: osHome(),
      cwd: cwd(),
      tmpDir: tmpD(),
      writable: noDeny,
      explicit: { home: explicitHome },
    });
    expect(t1[0].path).toBe(explicitHome);
    expect(t1[0].source).toBe('explicit');

    const envHome = path.join(tmp, 'env-home');
    const t2 = resolveWriteTargets({
      env: envOf({ FORGE_CLI_HOME: envHome }),
      osHome: osHome(),
      cwd: cwd(),
      tmpDir: tmpD(),
      writable: noDeny,
    });
    expect(t2[0].path).toBe(envHome);
    expect(t2[0].source).toBe('env');
    expect(t2[0].env_var).toBe('FORGE_CLI_HOME');

    const t3 = resolveWriteTargets({
      env: envOf(),
      osHome: osHome(),
      cwd: cwd(),
      tmpDir: tmpD(),
      writable: noDeny,
    });
    expect(t3[0].path).toBe('/home/user');
    expect(t3[0].source).toBe('user');
    expect(t3[0].env_var).toBe('HOME');

    const t4 = resolveWriteTargets({
      env: {},
      osHome: osHome(),
      cwd: cwd(),
      tmpDir: tmpD(),
      writable: noDeny,
    });
    expect(t4[0].path).toBe(osHome());
    expect(t4[0].source).toBe('system');
  });

  it('alvos derivados de home herdam o tier (bin/venvs/receipts)', () => {
    const envHome = path.join(tmp, 'env-home');
    const targets = resolveWriteTargets({
      env: envOf({ FORGE_CLI_HOME: envHome }),
      osHome: osHome(),
      cwd: cwd(),
      tmpDir: tmpD(),
      writable: noDeny,
    });
    const byName = Object.fromEntries(targets.map((t) => [t.name, t]));
    expect(byName.bin.path).toBe(path.join(envHome, '.forge-cli', 'bin'));
    expect(byName.bin.source).toBe('env');
    expect(byName.venvs.path).toBe(path.join(envHome, '.forge-cli', 'forges'));
    expect(byName.receipts.path).toBe(path.join(envHome, '.forge-cli', 'forges'));
  });

  it('override explícito de bin vence sem reescrever os demais', () => {
    const binDir = path.join(tmp, 'my-bin');
    const targets = resolveWriteTargets({
      env: envOf(),
      osHome: osHome(),
      cwd: cwd(),
      tmpDir: tmpD(),
      writable: noDeny,
      explicit: { binDir },
    });
    const byName = Object.fromEntries(targets.map((t) => [t.name, t]));
    expect(byName.bin.path).toBe(binDir);
    expect(byName.bin.source).toBe('explicit');
    expect(byName.venvs.source).toBe('user');
  });

  it('ordem fixa dos seis alvos', () => {
    const targets = resolveWriteTargets({
      env: envOf(),
      osHome: osHome(),
      cwd: cwd(),
      tmpDir: tmpD(),
      writable: noDeny,
    });
    expect(targets.map((t) => t.name)).toEqual([
      'home',
      'bin',
      'venvs',
      'receipts',
      'workspace_state',
      'env_files',
    ]);
  });

  it('alvo negado → FORGE-INSTALL-PERMISSION-DENIED + alternativa concreta', () => {
    const deniedHome = path.join(tmp, 'denied-home');
    mkdirSync(deniedHome, { recursive: true });
    const envHome = path.join(tmp, 'env-home-ok');
    mkdirSync(envHome, { recursive: true });
    const writable = (dir: string) => !dir.startsWith(deniedHome);
    const targets = resolveWriteTargets({
      env: envOf({ FORGE_CLI_HOME: envHome }),
      osHome: osHome(),
      cwd: cwd(),
      tmpDir: tmpD(),
      writable,
      explicit: { home: deniedHome },
    });
    const home = targets[0];
    expect(home.path).toBe(deniedHome);
    expect(home.writable).toBe(false);
    expect(home.denied?.code).toBe('FORGE-INSTALL-PERMISSION-DENIED');
    expect(home.fallback).toBe(envHome);
    expect(home.denied?.remedy).toContain(envHome);
  });

  it('denial real via diretório read-only (fs)', () => {
    if (
      process.platform === 'win32' ||
      typeof process.getuid !== 'function' ||
      process.getuid() === 0
    ) {
      return; // root ignora bits de permissão — predicado injetado cobre o resto
    }
    const ro = path.join(tmp, 'read-only-home');
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o555);
    try {
      const targets = resolveWriteTargets({
        env: envOf({ FORGE_CLI_HOME: ro }),
        osHome: osHome(),
        cwd: cwd(),
        tmpDir: tmpD(),
      });
      expect(targets[0].writable).toBe(false);
      expect(targets[0].denied?.code).toBe('FORGE-INSTALL-PERMISSION-DENIED');
      expect(targets[0].fallback).toBeTruthy();
    } finally {
      chmodSync(ro, 0o755);
    }
  });
});

describe('preflight agregado (discoverEnvironment) — nunca para no primeiro blocker', () => {
  const blockedDeps = (): DiscoverDeps => ({
    platform: 'linux',
    run: fakeRun({}), // nenhuma sonda responde
    exists: () => false,
    env: { HOME: path.join(tmp, 'h') },
    osHome: path.join(tmp, 'h'),
    cwd: path.join(tmp, 'w'),
    tmpDir: path.join(tmp, 'no-write-tmp'),
    writable: () => false,
    home: path.join(tmp, 'h'),
    now: () => '2026-03-01T00:00:00.000Z',
    pythonProbe: async () => null,
    toolchainProbe: async () => null,
    gitProbe: async () => ({ output: null, timedOut: false }),
    forgesProbe: () => ({ forges: {} }),
    nodeVersion: 'v18.0.0',
  });

  it('agrega múltiplos blockers simultâneos', async () => {
    const report = await discoverEnvironment(blockedDeps());
    expect(report.status).toBe('blocked');
    const ids = report.blockers.map((b) => b.id);
    expect(ids).toContain('git');
    expect(ids).toContain('node');
    expect(ids.some((i) => i.startsWith('write-target:'))).toBe(true);
    expect(ids).toContain('tmpdir');
    // python ausente é warning, não blocker — e também aparece
    expect(report.warnings.map((w) => w.id)).toContain('python');
    expect(report.blockers.length).toBeGreaterThanOrEqual(3);
  });

  it('win32 sem shells → blocker FORGE-SHELL-NOT-FOUND na rota', async () => {
    const report = await discoverEnvironment({
      ...blockedDeps(),
      platform: 'win32',
      writable: () => true,
      nodeVersion: 'v22.0.0',
    });
    const routeBlocker = report.blockers.find((b) => b.id === 'shell-route');
    expect(routeBlocker?.code).toBe('FORGE-SHELL-NOT-FOUND');
    expect(report.route.selected).toBe('none');
    expect(report.route.refusal?.code).toBe('FORGE-SHELL-NOT-FOUND');
  });

  it('win32 com só WSL → rota none (WSL nunca substitui)', async () => {
    const report = await discoverEnvironment({
      ...blockedDeps(),
      platform: 'win32',
      run: fakeRun({
        'where.exe wsl.exe': 'C:\\Windows\\System32\\wsl.exe',
      }),
      writable: () => true,
      nodeVersion: 'v22.0.0',
    });
    expect(report.shells.wsl.present).toBe(true);
    expect(report.route.selected).toBe('none');
  });

  it('relatório saudável em POSIX valida contra o contrato', async () => {
    const report = await discoverEnvironment({
      platform: 'linux',
      run: fakeRun({
        'bash --version': 'GNU bash 5.2',
        'sh -c command -v bash': '/usr/bin/bash',
      }),
      exists: (p) => p === path.join(tmp, 'h'),
      env: { HOME: path.join(tmp, 'h') },
      osHome: path.join(tmp, 'h'),
      cwd: path.join(tmp, 'w'),
      tmpDir: path.join(tmp, 't'),
      writable: () => true,
      home: path.join(tmp, 'h'),
      now: () => '2026-03-01T00:00:00.000Z',
      pythonProbe: async () => ({ exe: 'python3', args: [], version: 'Python 3.12.1' }),
      toolchainProbe: async () => 'pipx',
      gitProbe: async () => ({ output: 'git version 2.43.0', timedOut: false }),
      forgesProbe: () =>
        ({
          forges: {
            alpha: { method: 'local' },
            beta: { method: 'pypi' },
          },
        }) as unknown as ForgeState,
      nodeVersion: 'v22.0.0',
    });
    expect(report.status).toBe('ok');
    expect(report.shells.bash.present).toBe(true);
    expect(report.route.selected).toBe('sh');
    expect(report.python.version).toContain('3.12');
    expect(report.forges_detected).toEqual({
      count: 2,
      names: ['alpha', 'beta'],
      by_method: { local: 1, pypi: 1, unknown: 0 },
    });
    expect(report.network.probed).toBe(false);
    const errs = contractValidator().validate(ENVIRONMENT_DISCOVERY_SCHEMA, report);
    expect(errs).toEqual([]);
  });

  it('determinístico: mesmas respostas → mesmo JSON', async () => {
    const deps = blockedDeps();
    const a = await discoverEnvironment(deps);
    const b = await discoverEnvironment(deps);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('toda sonda tem timeout ≤ 5 s', () => {
    expect(SHELL_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });

  it('relatório real em POSIX passa no contrato', async () => {
    // máquina real do CI: probes de verdade, nenhum PowerShell spawna
    const report = await discoverEnvironment({ platform: process.platform });
    const errs = contractValidator().validate(ENVIRONMENT_DISCOVERY_SCHEMA, report);
    expect(errs).toEqual([]);
    expect(report.shells.powershell).toBeDefined();
    expect(report.shells.git_bash).toBeDefined();
    // Windows real scan: reg.exe + Program Files + py launcher + N probes
    // de ≤5s cada passam do timeout default num runner ocupado.
  }, 120_000);
});

describe('localInstall — rota Windows via winShells', () => {
  function makeWinSource(dir: string, files: Record<string, string> = {}) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'forge.json'),
      JSON.stringify({ forge_id: 'win-forge', cli: 'win-cli', version: '1.0.0' }),
    );
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "win"\n');
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, file), content);
    }
  }

  const depsFor = (
    winShells?: { ps?: string; bash?: string },
    extra: Partial<LocalDeps> = {},
  ): LocalDeps & { calls: { cmd: string; args: string[] }[] } => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run: LocalDeps['run'] = async (cmd, args) => {
      calls.push({ cmd, args });
      return { exitCode: 0 };
    };
    const deps: LocalDeps = {
      home: path.join(tmp, 'home'),
      run,
      yes: true,
      platform: 'win32',
      now: () => '2026-03-01T00:00:00.000Z',
      ...(winShells !== undefined ? { winShells } : {}),
      ...extra,
    };
    return Object.assign(deps, { calls }) as LocalDeps & {
      calls: { cmd: string; args: string[] }[];
    };
  };

  it('powershell ausente + git bash → install.windows.sh via bash.exe', async () => {
    const dir = path.join(tmp, 'src');
    makeWinSource(dir, { 'install.windows.sh': 'echo ok' });
    const deps = depsFor({ bash: 'C:\\Git\\bin\\bash.exe' });
    const outcome = await localInstall(dir, deps);
    expect(outcome.ok).toBe(true);
    expect(deps.calls[0]?.cmd).toBe('C:\\Git\\bin\\bash.exe');
    expect(deps.calls[0]?.args).toEqual(['install.windows.sh']);
    if (outcome.ok)
      expect(outcome.receipt.execution_environment.shell).toBe('C:\\Git\\bin\\bash.exe');
  });

  it('powershell ausente + git bash + só .sh POSIX → cai para setup.sh', async () => {
    const dir = path.join(tmp, 'src-posix-sh');
    makeWinSource(dir, { 'setup.sh': 'echo ok' });
    const deps = depsFor({ bash: 'C:\\Git\\bin\\bash.exe' });
    const outcome = await localInstall(dir, deps);
    expect(outcome.ok).toBe(true);
    expect(deps.calls[0]?.args).toEqual(['setup.sh']);
  });

  it('winShells={} + nenhum script → FORGE-SHELL-NOT-FOUND', async () => {
    const dir = path.join(tmp, 'src-noshell');
    makeWinSource(dir);
    const outcome = await localInstall(dir, depsFor({}));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.code).toBe('FORGE-SHELL-NOT-FOUND');
      expect(outcome.failure.remedy).toContain('Git for Windows');
    }
  });

  it('winShells={} mas bootstrap python presente → fallback python ainda instala', async () => {
    const dir = path.join(tmp, 'src-bootstrap');
    makeWinSource(dir);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'scripts', 'forge_bootstrap.py'), 'pass');
    const deps = depsFor({}, { python: ['python3'] });
    const outcome = await localInstall(dir, deps);
    expect(outcome.ok).toBe(true);
    expect(deps.calls[0]?.cmd).toBe('python3');
  });

  it('powershell presente → .ps1 route preservada', async () => {
    const dir = path.join(tmp, 'src-ps');
    makeWinSource(dir, { 'setup.ps1': 'Write-Host ok' });
    const deps = depsFor({ ps: 'powershell.exe', bash: 'C:\\Git\\bin\\bash.exe' });
    const outcome = await localInstall(dir, deps);
    expect(outcome.ok).toBe(true);
    expect(deps.calls[0]?.cmd).toBe('powershell.exe');
    expect(deps.calls[0]?.args).toContain('setup.ps1');
  });
});

describe('integração CLI — env discover/paths', () => {
  it('verb desconhecido → 2', async () => {
    expect(await runEnvCommand(parseCliArgs([]), ['bogus'])).toBe(2);
  });

  it('env paths --json emite a matriz de alvos', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    try {
      const code = await runEnvCommand(parseCliArgs(['--json']), ['paths']);
      const doc = JSON.parse(logs[0]);
      expect(doc.command).toBe('env paths');
      expect(Array.isArray(doc.write_targets)).toBe(true);
      expect(doc.write_targets.map((t: { name: string }) => t.name)).toEqual([
        'home',
        'bin',
        'venvs',
        'receipts',
        'workspace_state',
        'env_files',
      ]);
      expect([0, 1]).toContain(code);
    } finally {
      spy.mockRestore();
    }
  });

  it('env discover --json emite forge/EnvironmentDiscovery/v1 válida', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    try {
      const code = await runEnvCommand(parseCliArgs(['--json']), ['discover']);
      const doc = JSON.parse(logs[0]);
      expect(doc.schema).toBe('forge/EnvironmentDiscovery/v1');
      const errs = contractValidator().validate('forge/EnvironmentDiscovery/v1', doc);
      expect(errs).toEqual([]);
      expect([0, 1]).toContain(code);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});
