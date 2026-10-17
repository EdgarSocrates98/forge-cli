// P0-002: --plan/--dry-run/--check não podem produzir mutação observável.
// Estratégia: snapshot (árvore + conteúdo) do FORGE_CLI_HOME e do workspace
// antes e depois de cada operação de planejamento; exige zero diferença.
import { createHash } from 'node:crypto';
import {
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
import { runRegistryInstall, runRegistryUpdate } from '../src/cmd/registry.js';
import { runRegistryUninstall } from '../src/cmd/registry.js';
import type { CliOptions } from '../src/cli-args.js';

let home: string;
let ws: string;

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

const silent = async (fn: () => Promise<unknown>) => {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof orig;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
};

const run = {
  run: async () => ({ code: 1, stdout: '', stderr: '' }),
  commandOutput: async () => null,
};

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'forge-plan-'));
  ws = mkdtempSync(path.join(os.tmpdir(), 'forge-plan-ws-'));
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe('P0-002: plan/dry-run/check → zero mutação observável', () => {
  it('registry install --plan: resolve sem criar venv/receipt/state', async () => {
    const before = snapshot(home);
    await silent(() =>
      runRegistryInstall(cli({ plan: true }), ['api-forge'], { ...run, home } as never),
    );
    expect(snapshot(home)).toBe(before);
  });

  it('registry update --check: consulta sem alterar receipt/state', async () => {
    // semeia uma instalação registry
    const forgesDir = path.join(home, '.forge-cli', 'forges', 'api-forge');
    mkdirSync(forgesDir, { recursive: true });
    writeFileSync(
      path.join(home, '.forge-cli', 'forges', 'state.json'),
      JSON.stringify({
        forges: {
          'api-forge': {
            forge: 'api-forge',
            dist: 'apiforge-af',
            version: '0.1.0',
            bin: '/x/apiforge',
          },
        },
      }),
    );
    const before = snapshot(home);
    await silent(() =>
      runRegistryUpdate(cli({ check: true }), ['api-forge'], { ...run, home } as never),
    );
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
    await silent(() =>
      runRegistryUninstall(cli({ yes: false }), ['api-forge'], { ...run, home } as never),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(snapshot(home)).toBe(before);
  });
});
