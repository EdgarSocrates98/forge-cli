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
    levels: ['EXECUTABLE', 'MCP_INITIALIZED', 'TOOLS_DISCOVERED'],
    tools: 1,
    serverInfo: { name: 'fake', version: '0' },
    protocolVersion: '2024-11-05',
    error: null,
  })),
}));

import { runDoctor2Command, runHealCommand } from '../src/cmd/doctor2.js';
import { runEnvCommand } from '../src/cmd/env.js';
import { runHostsCommand, runMcpCommand } from '../src/cmd/hosts.js';
import { runRecoverCommand } from '../src/cmd/intel.js';
import { runForgeUninstall } from '../src/cmd/manage.js';
import { runListCommand, runStatusCommand, runUpdateCheckCommand } from '../src/cmd/query.js';

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
  writeFileSync(path.join(binDir, 'apiforge'), '#!/bin/sh\n');
  writeFileSync(path.join(binDir, 'apiforge-mcp'), '#!/bin/sh\n');
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
