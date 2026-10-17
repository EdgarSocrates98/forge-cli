import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiCacheDir, aiCacheGet, aiCacheKey, aiCacheSet } from '../src/ai/cache.js';
import { AI_PROPOSAL_SCHEMA } from '../src/ai/types.js';
import type { AiProposal } from '../src/ai/types.js';

// ---------------------------------------------------------------------------
// §6.3 — cache de propostas AI: chave canônica, TTL honesto, eviction bounded.
// Tudo determinístico — `now` injetado em todas as chamadas.
// ---------------------------------------------------------------------------

const proposal: AiProposal = {
  schema: AI_PROPOSAL_SCHEMA,
  task: 'suggest-tasks',
  summary: 'resumo',
  items: [{ title: 't', detail: 'd' }],
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-aicache-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('aiCacheKey — canônico', () => {
  it('payloads equivalentes com ordem de chaves distinta → mesmo hash', () => {
    const a = aiCacheKey({ task: 'x', context: { a: 1, b: [2, 3] } });
    const b = aiCacheKey({ context: { b: [2, 3], a: 1 }, task: 'x' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('payloads diferentes → hashes diferentes', () => {
    expect(aiCacheKey({ task: 'a' })).not.toBe(aiCacheKey({ task: 'b' }));
    // string "1" ≠ número 1 — tipos distintos não colidem
    expect(aiCacheKey({ v: '1' })).not.toBe(aiCacheKey({ v: 1 }));
  });
});

describe('aiCacheGet — leitura honesta', () => {
  const key = aiCacheKey({ task: 'x' });

  it('miss, ttl<=0 e chave inválida → null', () => {
    expect(aiCacheGet(root, key, { ttlMs: 1000 })).toBeNull();
    aiCacheSet(root, key, proposal, { now: 100 });
    expect(aiCacheGet(root, key, { ttlMs: 0 })).toBeNull();
    expect(aiCacheGet(root, 'not-a-key', { ttlMs: 1000 })).toBeNull();
    expect(aiCacheGet(root, '../escape/../x'.padEnd(64, '0'), { ttlMs: 1000 })).toBeNull();
  });

  it('hit dentro do TTL → proposal; expirado ou do futuro → null', () => {
    aiCacheSet(root, key, proposal, { now: 1000 });
    expect(aiCacheGet(root, key, { ttlMs: 500, now: 1200 })).toEqual(proposal);
    expect(aiCacheGet(root, key, { ttlMs: 500, now: 1501 })).toBeNull();
    // entrada com timestamp futuro (clock skew / adulteração) também é miss
    expect(aiCacheGet(root, key, { ttlMs: 500, now: 500 })).toBeNull();
  });

  it('arquivo corrompido ou shape errado → null, nunca objeto inválido', () => {
    mkdirSync(aiCacheDir(root), { recursive: true });
    writeFileSync(path.join(aiCacheDir(root), `${key}.json`), '{oops', 'utf8');
    expect(aiCacheGet(root, key, { ttlMs: 99999, now: 1 })).toBeNull();
    writeFileSync(
      path.join(aiCacheDir(root), `${key}.json`),
      JSON.stringify({ at: 0, proposal: { schema: 'other' } }),
      'utf8',
    );
    expect(aiCacheGet(root, key, { ttlMs: 99999, now: 1 })).toBeNull();
  });
});

describe('aiCacheSet — eviction bounded', () => {
  const keyN = (n: number) => aiCacheKey({ n });

  it('cap excedido evicta os mais antigos (tiebreak por nome)', () => {
    for (let i = 0; i < 5; i++) aiCacheSet(root, keyN(i), proposal, { now: i });
    expect(readdirSync(aiCacheDir(root))).toHaveLength(5);
    // escreve um 6º com cap 4 → os 2 mais antigos saem
    aiCacheSet(root, keyN(5), proposal, { now: 5, maxEntries: 4 });
    const files = readdirSync(aiCacheDir(root));
    expect(files).toHaveLength(4);
    expect(existsSync(path.join(aiCacheDir(root), `${keyN(0)}.json`))).toBe(false);
    expect(existsSync(path.join(aiCacheDir(root), `${keyN(1)}.json`))).toBe(false);
    expect(existsSync(path.join(aiCacheDir(root), `${keyN(5)}.json`))).toBe(true);
  });

  it('entrada corrompida conta como age 0 (evicta primeiro)', () => {
    for (let i = 0; i < 3; i++) aiCacheSet(root, keyN(i), proposal, { now: 100 + i });
    const corrupt = `${keyN(9)}.json`;
    writeFileSync(path.join(aiCacheDir(root), corrupt), 'garbage', 'utf8');
    aiCacheSet(root, keyN(3), proposal, { now: 200, maxEntries: 3 });
    expect(existsSync(path.join(aiCacheDir(root), corrupt))).toBe(false);
    expect(readdirSync(aiCacheDir(root))).toHaveLength(3);
  });

  it('chave inválida não escreve nada', () => {
    aiCacheSet(root, 'bad key', proposal);
    expect(existsSync(aiCacheDir(root))).toBe(false);
  });
});
