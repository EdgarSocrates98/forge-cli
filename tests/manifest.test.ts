import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readForgeManifest } from '../src/manifest.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-manifest-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (content: string) => writeFileSync(path.join(dir, 'forge.json'), content);

describe('readForgeManifest', () => {
  it('retorna null sem forge.json (opcional)', () => {
    expect(readForgeManifest(dir)).toBeNull();
  });

  it('lê campos conhecidos', () => {
    write(
      JSON.stringify({
        forge_id: 'spark-forge-aws',
        cli: 'sparkforge-aws',
        mcp_command: ['sparkforge-aws', 'mcp', 'serve'],
      }),
    );
    expect(readForgeManifest(dir)).toEqual({
      forgeId: 'spark-forge-aws',
      cli: 'sparkforge-aws',
      mcpCommand: ['sparkforge-aws', 'mcp', 'serve'],
    });
  });

  it('rejeita valores com caminho, espaço ou opção (conteúdo não confiável)', () => {
    write(JSON.stringify({ cli: '../evil', forge_id: 'a b', mcp_command: ['ok', '--x;rm'] }));
    expect(readForgeManifest(dir)).toBeNull();
    write(JSON.stringify({ cli: 'good-cli', mcp_command: ['/bin/sh'] }));
    expect(readForgeManifest(dir)).toEqual({ cli: 'good-cli' });
  });

  it('ignora JSON inválido ou grande demais', () => {
    write('{not json');
    expect(readForgeManifest(dir)).toBeNull();
    write(JSON.stringify({ cli: 'x', pad: 'a'.repeat(70_000) }));
    expect(readForgeManifest(dir)).toBeNull();
  });
});
