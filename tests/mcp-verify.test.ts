// P1-002: verificação MCP completa contra fixtures stdio reais (subprocesso
// Node em tests/fixtures/mcp/*) — sem rede, sem mocks do próprio protocolo.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveMinimalInput, probeMcpServer } from '../src/mcp/handshake.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = (name: string) => [process.execPath, path.join(HERE, 'fixtures', 'mcp', name)];
const FAST = { timeoutMs: 2500 };

describe('probeMcpServer — cadeia de níveis', () => {
  it('argv vazio → argv-empty, nenhum nível', async () => {
    const r = await probeMcpServer([], FAST);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('argv-empty');
    expect(r.levels).toEqual([]);
  });

  it('binário absoluto inexistente → bin-missing (INSTALLED nunca é mentira)', async () => {
    const r = await probeMcpServer(['/nonexistent/mcp-bin-xyz'], FAST);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('bin-missing');
    expect(r.levels).toEqual([]);
  });

  it('initialize + tools/list válidos → INITIALIZED + TOOLS_DISCOVERED', async () => {
    const r = await probeMcpServer(FIX('server.mjs'), { ...FAST, safeTools: [] });
    expect(r.ok).toBe(true);
    expect(r.levels).toEqual(['INSTALLED', 'EXECUTABLE', 'INITIALIZED', 'TOOLS_DISCOVERED']);
    expect(r.tools).toBe(2);
    expect(r.protocolVersion).toBe('2024-11-05');
    expect(r.serverInfo?.name).toBe('fixture-mcp');
    expect(r.detail).toBe('no-allowlisted-tool');
    expect(r.calledTool).toBeNull();
  });
});

describe('tools/call — default deny e allowlist explícita', () => {
  it('sem allowlist nunca chama tool (mesmo nomes que parecem seguros)', async () => {
    const r = await probeMcpServer(FIX('server.mjs'), FAST);
    expect(r.ok).toBe(true);
    expect(r.detail).toBe('no-allowlisted-tool');
    expect(r.levels).not.toContain('SAFE_TOOL_CALLED');
  });

  it('allowlist sem interseção com tools anunciadas → not-advertised, sem call', async () => {
    const r = await probeMcpServer(FIX('server.mjs'), { ...FAST, safeTools: ['other_tool'] });
    expect(r.ok).toBe(true);
    expect(r.detail).toBe('allowlisted-tool-not-advertised');
    expect(r.levels).not.toContain('SAFE_TOOL_CALLED');
  });

  it('tool NÃO allowlisted jamais é chamada — allowlist não casa "danger_nuke"', async () => {
    // safeTools ['safe_ping'] chama safe_ping; a prova de "nunca a não-listada"
    // é que allowlist só intersecta com 'safe_ping' (fixture oferece as duas).
    const r = await probeMcpServer(FIX('server.mjs'), { ...FAST, safeTools: ['safe_ping'] });
    expect(r.ok).toBe(true);
    expect(r.levels).toContain('SAFE_TOOL_CALLED');
    expect(r.calledTool?.name).toBe('safe_ping');
  });

  it('call bem-sucedida registra SAFE_TOOL_CALLED + arguments derivados', async () => {
    const r = await probeMcpServer(FIX('derived-args.mjs'), {
      ...FAST,
      safeTools: ['safe_ping'],
    });
    expect(r.ok).toBe(true);
    expect(r.levels).toEqual([
      'INSTALLED',
      'EXECUTABLE',
      'INITIALIZED',
      'TOOLS_DISCOVERED',
      'SAFE_TOOL_CALLED',
    ]);
    expect(r.calledTool).toEqual({
      name: 'safe_ping',
      arguments: { label: '', count: 0, verbose: false },
    });
  });

  it('campo required sem default seguro → skip honesto, sem call', async () => {
    const r = await probeMcpServer(FIX('underivable.mjs'), { ...FAST, safeTools: ['safe_ping'] });
    expect(r.ok).toBe(true);
    expect(r.detail).toBe('tool-input-underivable:config');
    expect(r.levels).not.toContain('SAFE_TOOL_CALLED');
  });

  it('tools/list vazio → TOOLS_DISCOVERED com tools=0', async () => {
    const r = await probeMcpServer(FIX('empty-tools.mjs'), { ...FAST, safeTools: ['x'] });
    expect(r.ok).toBe(true);
    expect(r.tools).toBe(0);
    expect(r.detail).toBe('allowlisted-tool-not-advertised');
  });
});

describe('falhas do server — erros nomeados', () => {
  it('tools/call com erro JSON-RPC → TOOL_CALL_ERROR', async () => {
    const r = await probeMcpServer(FIX('tool-error.mjs'), { ...FAST, safeTools: ['safe_ping'] });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TOOL_CALL_ERROR');
    expect(r.levels).toContain('TOOLS_DISCOVERED');
    expect(r.levels).not.toContain('SAFE_TOOL_CALLED');
  });

  it('schema malformado → INVALID_SCHEMA', async () => {
    const r = await probeMcpServer(FIX('bad-schema.mjs'), { ...FAST, safeTools: ['safe_ping'] });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_SCHEMA');
  });

  it('server morre no meio → server-exit com stderr sanitizado', async () => {
    const r = await probeMcpServer(FIX('crash.mjs'), FAST);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('server-exit');
    expect(r.error?.detail).toContain('exit 42');
    expect(r.error?.detail).toContain('panic: fixture crash');
  });

  it('server mudo → timeout', async () => {
    const r = await probeMcpServer(FIX('silent.mjs'), { timeoutMs: 600 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('timeout');
  });

  it('stdout não-JSON → stdout-non-json', async () => {
    const r = await probeMcpServer(FIX('nonjson.mjs'), FAST);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('stdout-non-json');
  });

  it('protocolo divergente → PROTOCOL_MISMATCH (com INITIALIZED honesto)', async () => {
    const r = await probeMcpServer(FIX('old-proto.mjs'), FAST);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('PROTOCOL_MISMATCH');
    expect(r.levels).toContain('INITIALIZED');
  });
});

describe('deriveMinimalInput — derivação de input mínimo', () => {
  it('schema ausente → args vazios', () => {
    expect(deriveMinimalInput(undefined)).toEqual({ kind: 'ok', args: {} });
    expect(deriveMinimalInput(null)).toEqual({ kind: 'ok', args: {} });
  });
  it('schema não-objeto → invalid-schema', () => {
    expect(deriveMinimalInput('nope')).toEqual({ kind: 'invalid-schema' });
    expect(deriveMinimalInput([1])).toEqual({ kind: 'invalid-schema' });
  });
  it('required malformado → invalid-schema', () => {
    expect(deriveMinimalInput({ type: 'object', required: 'x' })).toEqual({
      kind: 'invalid-schema',
    });
  });
  it('só campos required entram; defaults de enum/schema respeitados', () => {
    const d = deriveMinimalInput({
      type: 'object',
      required: ['a'],
      properties: { a: { enum: ['x', 'y'] }, opcional: { type: 'string' } },
    });
    expect(d).toEqual({ kind: 'ok', args: { a: 'x' } });
  });
  it('required array/object → underivable (nunca inventa estrutura)', () => {
    const d = deriveMinimalInput({
      type: 'object',
      required: ['conf'],
      properties: { conf: { type: 'object' } },
    });
    expect(d).toEqual({ kind: 'underivable', field: 'conf' });
  });
});
