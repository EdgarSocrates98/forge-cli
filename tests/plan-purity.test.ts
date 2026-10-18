// P0-002: --plan/--dry-run/--check e comandos de consulta não podem produzir
// mutação observável. Estratégia: snapshot (árvore + conteúdo, sha256) do
// FORGE_CLI_HOME e do workspace antes e depois de cada operação; exige zero
// diferença — nem cache de metadados PyPI (resolve usa `ephemeral: true`).
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runRegistryInstall,
  runRegistryList,
  runRegistryLock,
  runRegistryPin,
  runRegistryReinstall,
  runRegistryRollback,
  runRegistryUninstall,
  runRegistryUpdate,
} from '../src/cmd/registry.js';
import type { CliOptions } from '../src/cli-args.js';
import { forgeStatePath, forgeVenv } from '../src/registry/install.js';
import type { FetchLike } from '../src/registry/pypi.js';
import { parseVersion } from '../src/registry/versions.js';

// `mcp --verify` nunca spawna de verdade aqui — handshake é mockado.
vi.mock('../src/mcp/handshake.js', () => ({
  probeMcpServer: vi.fn(async () => ({
    ok: true,
    levels: ['INSTALLED', 'EXECUTABLE', 'INITIALIZED', 'TOOLS_DISCOVERED'],
    tools: 1,
    serverInfo: { name: 'fake', version: '0' },
    protocolVersion: '2024-11-05',
    calledTool: null,
    detail: 'no-allowlisted-tool',
    error: null,
  })),
}));

import { runDoctor2Command, runHealCommand } from '../src/cmd/doctor2.js';
import { runEnvCommand } from '../src/cmd/env.js';
import { runHostsCommand, runMcpCommand } from '../src/cmd/hosts.js';
import { runLockCommand, runProfileCommand, runRecoverCommand } from '../src/cmd/intel.js';
import { runAiCommand, runBundleCommand, runLearningCommand } from '../src/cmd/intel2.js';
import {
  runForgeUninstall,
  runInstallCommand,
  runPinCommand,
  runRollbackCommand,
  runSelfUpdateCommand,
  runUninstallCommand,
  runUnpinCommand,
} from '../src/cmd/manage.js';
import { runListCommand, runStatusCommand, runUpdateCheckCommand } from '../src/cmd/query.js';
import { parseCliArgs } from '../src/cli-args.js';
import { stateFileFor } from '../src/artifacts.js';

let home: string;
let ws: string;
let savedHome: string | undefined;

const snapshot = (root: string): string => {
  const h = createHash('sha256');
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      if (e.isDirectory()) {
        h.update(`D:${rel}\n`);
        walk(p);
      } else {
        h.update(`F:${rel}:${statSync(p).size}:`);
        h.update(readFileSync(p));
        h.update('\n');
      }
    }
  };
  if (statSync(root, { throwIfNoEntry: false })) walk(root);
  return h.digest('hex');
};

const cli = (over: Partial<CliOptions> = {}): CliOptions =>
  ({
    dir: ws,
    yes: true,
    jsonReport: true,
    ...over,
  }) as CliOptions;

const silent = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof orig;
  try {
    return await fn();
  } finally {
    process.stdout.write = orig;
  }
};

const run = {
  run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
  commandOutput: async () => null,
};

/** Receipt registry mínimo: bin + sibling MCP dentro da venv do home tmp. */
const seedRegistryInstall = (name = 'api-forge') => {
  const venv = forgeVenv(home, name);
  const binDir = path.join(venv, 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const s of ['apiforge', 'apiforge-mcp']) {
    writeFileSync(path.join(binDir, s), '#!/bin/sh\n');
    if (process.platform === 'win32') writeFileSync(path.join(binDir, `${s}.exe`), '');
  }
  mkdirSync(path.dirname(forgeStatePath(home)), { recursive: true });
  writeFileSync(
    forgeStatePath(home),
    JSON.stringify({
      forges: {
        [name]: {
          forge: name,
          method: 'pypi',
          dist: 'apiforge-af',
          version: '0.1.0',
          python: '3.12.4',
          venv,
          bin: path.join(binDir, 'apiforge'),
          verify: { command: [], ok: true },
          installedAt: '2026-01-01T00:00:00Z',
        },
      },
    }),
  );
};

const PYPI = {
  info: { requires_python: '>=3.10' },
  releases: {
    '0.1.0': [
      {
        filename: 'apiforge_af-0.1.0-py3-none-any.whl',
        url: 'https://f/x.whl',
        digests: { sha256: 'a'.repeat(64) },
        packagetype: 'bdist_wheel',
      },
    ],
  },
};
const fetchOk: FetchLike = async () => ({ status: 200, body: JSON.stringify(PYPI) });
const py = [{ exe: ['python3'], version: '3.12.4', parsed: parseVersion('3.12.4')! }];

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'forge-plan-'));
  ws = mkdtempSync(path.join(os.tmpdir(), 'forge-plan-ws-'));
  savedHome = process.env.FORGE_CLI_HOME;
  process.env.FORGE_CLI_HOME = home;
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.FORGE_CLI_HOME;
  else process.env.FORGE_CLI_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe('P0-002: plan/dry-run/check → zero mutação observável', () => {
  it('registry install --plan: resolve sem criar venv/receipt/state/cache', async () => {
    const before = snapshot(home);
    await silent(() =>
      runRegistryInstall(cli({ plan: true }), ['api-forge'], {
        ...run,
        home,
        pythons: py,
        fetchImpl: fetchOk,
      }),
    );
    expect(snapshot(home)).toBe(before);
  });

  it('registry update --check: consulta sem alterar receipt/state', async () => {
    seedRegistryInstall();
    const before = snapshot(home);
    await silent(() =>
      runRegistryUpdate(cli({ check: true }), ['api-forge'], {
        ...run,
        home,
        fetchImpl: fetchOk,
      }),
    );
    expect(snapshot(home)).toBe(before);
  });

  it('registry update --plan: mesmo contrato do --check', async () => {
    seedRegistryInstall();
    const before = snapshot(home);
    await silent(() =>
      runRegistryUpdate(cli({ plan: true }), ['api-forge'], { ...run, home, fetchImpl: fetchOk }),
    );
    expect(snapshot(home)).toBe(before);
  });

  it('registry reinstall --check: plano sem tocar venv/state', async () => {
    seedRegistryInstall();
    const before = snapshot(home);
    await silent(() => runRegistryReinstall(cli({ check: true }), ['api-forge'], { ...run, home }));
    expect(snapshot(home)).toBe(before);
  });

  it('registry rollback --check: plano sem desempilhar nem instalar', async () => {
    seedRegistryInstall();
    const before = snapshot(home);
    await silent(() => runRegistryRollback(cli({ check: true }), ['api-forge'], { ...run, home }));
    expect(snapshot(home)).toBe(before);
  });

  it('uninstall não-TTY sem --yes: needsYes sem remover venv nem state', async () => {
    const forgesDir = path.join(home, '.forge-cli', 'forges', 'api-forge');
    mkdirSync(path.join(forgesDir, 'venv'), { recursive: true });
    writeFileSync(
      path.join(home, '.forge-cli', 'forges', 'state.json'),
      JSON.stringify({
        forges: {
          'api-forge': { forge: 'api-forge', dist: 'apiforge-af', version: '0.1.0', bin: '/x' },
        },
      }),
    );
    const before = snapshot(home);
    // sem --yes e sem TTY (vitest roda não-TTY): precisa needsYes + exit 0
    await silent(() => runRegistryUninstall(cli({ yes: false }), ['api-forge'], { ...run, home }));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(snapshot(home)).toBe(before);
  });
});

describe('P0-002: consultas read-only → zero mutação em home e workspace', () => {
  it('registry (list): lê state sem alterá-lo', async () => {
    seedRegistryInstall();
    const before = snapshot(home);
    await silent(() => runRegistryList(cli(), { home }));
    expect(snapshot(home)).toBe(before);
  });

  it('status: catálogo + state lidos, nada escrito', async () => {
    seedRegistryInstall();
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runStatusCommand(cli(), []));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('list: catálogo + registry lidos, nada escrito', async () => {
    seedRegistryInstall();
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runListCommand(cli()));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('mcp --verify: probe MCP mockado, zero escrita', async () => {
    seedRegistryInstall();
    const before = snapshot(home);
    const code = await silent(() => runMcpCommand(cli({ verify: true }), [], home));
    expect(code).toBe(0);
    expect(snapshot(home)).toBe(before);
  });

  it('hosts plan: plano de integração sem gravar config do host', async () => {
    seedRegistryInstall();
    const before = snapshot(home);
    const code = await silent(() => runHostsCommand(cli(), ['plan', 'claude', 'api-forge'], home));
    expect(code).toBe(0);
    expect(snapshot(home)).toBe(before);
    expect(existsSync(path.join(home, '.claude.json'))).toBe(false);
  });

  it('hosts list: detecção sem gravar nada', async () => {
    const before = snapshot(home);
    const code = await silent(() => runHostsCommand(cli(), ['list'], home));
    expect(code).toBe(0);
    expect(snapshot(home)).toBe(before);
  });

  it('doctor: relatório de diagnóstico sem mutação residual', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    const code = await silent(() => runDoctor2Command(cli()));
    expect([0, 1]).toContain(code);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
    // sonda de escrita do check de workspace nunca fica para trás
    expect(readdirSync(ws).filter((f) => f.includes('probe'))).toHaveLength(0);
  });

  it('heal --plan: plano de reparo sem aplicar nem gravar receipt', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    const code = await silent(() => runHealCommand(cli({ plan: true })));
    expect(code).toBe(0);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
    expect(existsSync(path.join(ws, '.forge-cli', 'receipts'))).toBe(false);
  });

  it('update --check (git): sem checkouts → sem fetch, sem escrita', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runUpdateCheckCommand(cli(), []));
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('recover: relatório de runs interrompidas sem escrita', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    const code = await silent(() => runRecoverCommand(cli()));
    expect(code).toBe(0);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('env plan: plano de migração sem tocar .env', async () => {
    mkdirSync(path.join(ws, 'api-forge'), { recursive: true });
    writeFileSync(path.join(ws, 'api-forge', '.env.example'), 'FOO=\n');
    const before = { home: snapshot(home), ws: snapshot(ws) };
    const code = await silent(() => runEnvCommand(cli(), ['plan', 'api-forge']));
    expect(code).toBe(0);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
    expect(existsSync(path.join(ws, 'api-forge', '.env'))).toBe(false);
  });

  it('uninstall (git) não-TTY sem --yes: plano de remoção sem remover', async () => {
    // Terminal dev é TTY — força não-TTY para exercitar o caminho needsYes
    // deterministicamente (TTY real chamaria confirm() e penduraria o teste).
    const streams = [process.stdin, process.stdout] as { isTTY?: boolean }[];
    const saved = streams.map((s) => s.isTTY);
    streams.forEach((s) => {
      s.isTTY = false;
    });
    try {
      const before = { home: snapshot(home), ws: snapshot(ws) };
      await silent(() => runForgeUninstall(cli({ yes: false }), ['api-forge']));
      expect(process.exit).toHaveBeenCalledWith(0);
      expect(snapshot(home)).toBe(before.home);
      expect(snapshot(ws)).toBe(before.ws);
    } finally {
      streams.forEach((s, i) => {
        s.isTTY = saved[i];
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Matriz de aceite P0 — TODA superfície mutante honra --plan/--check ou
// recusa de forma nomeada. Cada teste exige snapshot idêntico de home+ws.
// ---------------------------------------------------------------------------
describe('P0 matriz: pin/unpin/rollback/uninstall — plan nunca muta', () => {
  it('pin --plan (git): mostra o pin que seria gravado — state.json intocado (o bug real)', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runPinCommand(cli({ plan: true, ref: 'v1.2.3' }), ['api-forge']));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(existsSync(stateFileFor(ws))).toBe(false);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('pin --check (git): mesmo contrato que --plan', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runPinCommand(cli({ check: true, ref: 'v1.2.3' }), ['api-forge']));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(existsSync(stateFileFor(ws))).toBe(false);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('pin sem --plan (git): grava — contraste que prova o gate', async () => {
    await silent(() => runPinCommand(cli({ ref: 'v1.2.3' }), ['api-forge']));
    expect(process.exit).toHaveBeenCalledWith(0);
    const state = JSON.parse(readFileSync(stateFileFor(ws), 'utf8'));
    expect(state.pins['api-forge']).toBe('v1.2.3');
  });

  it('unpin --plan (git): mostra pin atual — clearPin nunca roda', async () => {
    // Semeia um pin real para provar que o plano não o remove.
    await silent(() => runPinCommand(cli({ ref: 'v1.2.3' }), ['api-forge']));
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runUnpinCommand(cli({ plan: true }), ['api-forge']));
    expect(process.exit).toHaveBeenCalledWith(0);
    const state = JSON.parse(readFileSync(stateFileFor(ws), 'utf8'));
    expect(state.pins['api-forge']).toBe('v1.2.3'); // pin sobrevive ao plano
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('rollback --plan (git): inspeção read-only, zero checkout/state', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runRollbackCommand(cli({ plan: true }), ['api-forge']));
    // Repo não clonado → recusa nomeada (not-cloned), nunca mutation.
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('uninstall --plan (git): plano de remoção exibido antes de --yes/prompt', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runForgeUninstall(cli({ plan: true }), ['api-forge']));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('self-install --plan: lista dir/shim/profiles sem gravar nada', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runInstallCommand(cli({ plan: true })));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('self-uninstall --plan: plano sem remover dir nem tocar profile', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runUninstallCommand(cli({ plan: true })));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('self-update --plan: mostra comando do update sem executar', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runSelfUpdateCommand(cli({ plan: true })));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });
});

describe('P0 matriz: registry pin/unpin/uninstall/lock — plan nunca muta', () => {
  it('registry pin --plan: mostra a trava que seria gravada — state.json intocado', async () => {
    seedRegistryInstall();
    const before = snapshot(home);
    await silent(() => runRegistryPin(cli({ plan: true }), ['api-forge'], true, { home }));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(snapshot(home)).toBe(before);
    // E o pin NÃO foi aplicado:
    const state = JSON.parse(readFileSync(forgeStatePath(home), 'utf8'));
    expect(state.forges['api-forge'].pinned).toBeUndefined();
  });

  it('registry unpin --plan: idem — a trava existente sobrevive ao plano', async () => {
    seedRegistryInstall();
    // Aplica um pin real primeiro (fora do modo plano).
    await silent(() => runRegistryPin(cli(), ['api-forge'], true, { home }));
    const before = snapshot(home);
    await silent(() => runRegistryPin(cli({ plan: true }), ['api-forge'], false, { home }));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(snapshot(home)).toBe(before);
    const state = JSON.parse(readFileSync(forgeStatePath(home), 'utf8'));
    expect(state.forges['api-forge'].pinned).toBe('0.1.0');
  });

  it('registry uninstall --plan: plano antes de confirmação/remoção — nada apagado', async () => {
    seedRegistryInstall();
    const venv = forgeVenv(home, 'api-forge');
    const before = snapshot(home);
    await silent(() => runRegistryUninstall(cli({ plan: true }), ['api-forge'], { ...run, home }));
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(snapshot(home)).toBe(before);
    expect(existsSync(venv)).toBe(true);
  });

  it('registry lock --plan: resolve+valida sem lockfile/cache/downloads', async () => {
    // cwd isolado: snapshots da raiz do repo não são determinísticos sob
    // workers paralelos (outros arquivos podem criar fixtures lá).
    const cwdTmp = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-lockcwd-'));
    const prevCwd = process.cwd();
    process.chdir(cwdTmp);
    const before = { home: snapshot(home), ws: snapshot(ws), cwd: snapshot(cwdTmp) };
    try {
      await silent(() =>
        runRegistryLock(cli({ plan: true }), ['api-forge'], {
          home,
          pythons: py,
          fetchImpl: fetchOk,
          ...run,
        }),
      );
    } finally {
      process.chdir(prevCwd);
    }
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
    // Lockfile NUNCA é criado em modo plano — nem no cwd nem no home.
    expect(existsSync(path.join(cwdTmp, 'api-forge.offline-lock.json'))).toBe(false);
    expect(snapshot(cwdTmp)).toBe(before.cwd);
  });
});

describe('P0 matriz: superfícies secundárias — plan puro ou recusa nomeada', () => {
  it('lock write --plan: exibe o lockfile sem criar env.lock.json', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    const code = await silent(() => runLockCommand(cli({ plan: true }), ['write']));
    expect(code).toBe(0);
    expect(existsSync(path.join(ws, '.forge-cli', 'env.lock.json'))).toBe(false);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('profile export --plan: exibe o profile sem criar o arquivo', async () => {
    const file = path.join(ws, 'profile-export.json');
    const before = { home: snapshot(home), ws: snapshot(ws) };
    const code = await silent(() => runProfileCommand(cli({ plan: true }), ['export', file]));
    expect(code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('learning enable --plan: mostra o toggle sem gravar config', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    const code = await silent(() =>
      runLearningCommand(cli({ plan: true, positionals: ['learning', 'enable'] })),
    );
    expect(code).toBe(0);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('bundle export --plan: mostra destino sem escrever o arquivo', async () => {
    const file = path.join(ws, 'bundle.tgz');
    const before = { home: snapshot(home), ws: snapshot(ws) };
    const code = await silent(() =>
      runBundleCommand(cli({ plan: true, positionals: ['bundle', 'export', file] })),
    );
    expect(code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('ai --plan: semântica de plano inexistente → recusa nomeada (exit 2)', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    const code = await silent(() =>
      runAiCommand(cli({ plan: true, positionals: ['ai', 'explain-error'] })),
    );
    expect(code).toBe(2);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('env init --plan: .env e .env.bak intocados', async () => {
    mkdirSync(path.join(ws, 'api-forge'), { recursive: true });
    writeFileSync(path.join(ws, 'api-forge', '.env.example'), 'FOO=\n');
    const before = { home: snapshot(home), ws: snapshot(ws) };
    const code = await silent(() => runEnvCommand(cli({ plan: true }), ['init', 'api-forge']));
    expect(code).toBe(0);
    expect(existsSync(path.join(ws, 'api-forge', '.env'))).toBe(false);
    expect(snapshot(home)).toBe(before.home);
    expect(snapshot(ws)).toBe(before.ws);
  });
});

describe('P0 matriz: flags semânticas inválidas — recusa nomeada, nunca engolidas', () => {
  it('registry pin --ref: trava é sempre a versão instalada — exit 2', async () => {
    seedRegistryInstall();
    await silent(() => runRegistryPin(cli({ ref: '9.9.9' }), ['api-forge'], true, { home }));
    expect(process.exit).toHaveBeenCalledWith(2);
    const state = JSON.parse(readFileSync(forgeStatePath(home), 'utf8'));
    expect(state.forges['api-forge'].pinned).toBeUndefined();
  });

  it('registry unpin --ref: recusa nomeada — exit 2, state intacto', async () => {
    seedRegistryInstall();
    const before = snapshot(home);
    await silent(() => runRegistryPin(cli({ ref: '9.9.9' }), ['api-forge'], false, { home }));
    expect(process.exit).toHaveBeenCalledWith(2);
    expect(snapshot(home)).toBe(before);
  });

  it('unpin --ref (git): flag sem efeito → exit 2', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runUnpinCommand(cli({ ref: 'v9.9.9' }), ['api-forge']));
    expect(process.exit).toHaveBeenCalledWith(2);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('rollback --ref (git): rollback usa HEAD anterior registrado — exit 2', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runRollbackCommand(cli({ ref: 'v9.9.9' }), ['api-forge']));
    expect(process.exit).toHaveBeenCalledWith(2);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('uninstall --ref (git): remoção não tem alvo de revisão — exit 2', async () => {
    const before = { home: snapshot(home), ws: snapshot(ws) };
    await silent(() => runForgeUninstall(cli({ ref: 'v9.9.9' }), ['api-forge']));
    expect(process.exit).toHaveBeenCalledWith(2);
    expect(snapshot(ws)).toBe(before.ws);
  });

  it('registry uninstall --ref: recusa nomeada — exit 2, nada removido', async () => {
    seedRegistryInstall();
    const before = snapshot(home);
    await silent(() =>
      runRegistryUninstall(cli({ ref: '9.9.9' }), ['api-forge'], { ...run, home }),
    );
    expect(process.exit).toHaveBeenCalledWith(2);
    expect(snapshot(home)).toBe(before);
    expect(existsSync(forgeVenv(home, 'api-forge'))).toBe(true);
  });

  it('parseCliArgs: ref fora do formato seguro (`bad..ref`) → CliError', () => {
    expect(() => parseCliArgs(['pin', 'api-forge', '--ref', 'bad..ref'])).toThrowError(/inválid/i);
  });
});
