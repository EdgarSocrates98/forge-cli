import { describe, expect, it } from 'vitest';
import { assertNoSecrets, sanitizeForAi, sanitizeText } from '../src/ai/sanitize.js';

const GH_TOKEN = `ghp_${'a'.repeat(36)}`;

describe('sanitizeText', () => {
  it('masks secret-looking content', () => {
    expect(sanitizeText(`clone with ${GH_TOKEN}`)).toBe('clone with ***');
    expect(sanitizeText('API_KEY=supersecret')).not.toContain('supersecret');
  });
  it('preserves clean text', () => {
    expect(sanitizeText('git pull --ff-only')).toBe('git pull --ff-only');
  });
});

describe('sanitizeForAi — key denylist', () => {
  it('drops keys whose name matches the denylist (case-insensitive substring)', () => {
    const out = sanitizeForAi({
      apiKey: 'x',
      GITHUB_TOKEN: 'x',
      userPassword: 'x',
      authorization: 'x',
      private: 'x',
      vaultCredential: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      monkey: 'x', // contains KEY — substring denylist is intentionally aggressive
      name: 'kept',
    }) as Record<string, unknown>;
    expect(out).toEqual({ name: 'kept' });
  });

  it('drops denylisted keys at any depth', () => {
    const out = sanitizeForAi({
      outer: { inner: { sessionToken: 'x', ok: 1 }, list: [{ password: 'x', keep: 'y' }] },
    }) as Record<string, unknown>;
    expect(out).toEqual({ outer: { inner: { ok: 1 }, list: [{ keep: 'y' }] } });
  });
});

describe('sanitizeForAi — value redaction', () => {
  it('drops a key whose value still changes after redaction', () => {
    const out = sanitizeForAi({
      note: `leaked ${GH_TOKEN}`,
      url: 'https://user:pw@example.com/x',
      clean: 'no secrets here',
    }) as Record<string, unknown>;
    expect(out).toEqual({ clean: 'no secrets here' });
  });

  it('masks array elements in place instead of dropping them', () => {
    const out = sanitizeForAi({
      items: [`token ${GH_TOKEN}`, 'clean', 42],
    }) as { items: unknown[] };
    expect(out.items).toEqual(['token ***', 'clean', 42]);
  });

  it('drops non-JSON values from objects and nulls them in arrays', () => {
    const out = sanitizeForAi({
      fn: () => 1,
      undef: undefined,
      arr: [() => 1, 'x'],
      ok: true,
    }) as Record<string, unknown>;
    expect(out).toEqual({ arr: [null, 'x'], ok: true });
  });

  it('does not mutate the input', () => {
    const input = { GITHUB_TOKEN: 'x', note: `has ${GH_TOKEN}`, keep: 'yes' };
    sanitizeForAi(input);
    expect(input).toEqual({ GITHUB_TOKEN: 'x', note: `has ${GH_TOKEN}`, keep: 'yes' });
  });

  it('produces sorted keys for deterministic output', () => {
    const out = sanitizeForAi({ b: 1, a: 2, c: 3 }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['a', 'b', 'c']);
  });

  it('handles top-level strings, arrays and primitives', () => {
    expect(sanitizeForAi(`x ${GH_TOKEN}`)).toBe('x ***');
    expect(sanitizeForAi([`x ${GH_TOKEN}`])).toEqual(['x ***']);
    expect(sanitizeForAi(42)).toBe(42);
    expect(sanitizeForAi(null)).toBe(null);
    expect(sanitizeForAi(undefined)).toBe(null);
  });
});

describe('assertNoSecrets', () => {
  it('returns [] for clean structures', () => {
    expect(assertNoSecrets({ a: 'clean', b: { c: ['x', 'y'], d: 1 }, e: 'API_KEY=***' })).toEqual(
      [],
    );
  });

  it('reports denylisted key paths', () => {
    expect(assertNoSecrets({ outer: { apiToken: 'x' }, fine: 1 })).toEqual(['outer.apiToken']);
  });

  it('reports values that still contain secret-looking content', () => {
    const hits = assertNoSecrets({
      a: `has ${GH_TOKEN}`,
      b: { c: ['ok', `Authorization: Bearer ${GH_TOKEN}`] },
    });
    expect(hits).toEqual(['a', 'b.c[1]']);
  });

  it('reports a top-level offending string as <root>', () => {
    expect(assertNoSecrets(GH_TOKEN)).toEqual(['<root>']);
  });

  it('finds nothing after sanitizeForAi ran', () => {
    const dirty = {
      password: 'x',
      nested: { note: `leak ${GH_TOKEN}`, safe: 'y' },
      list: [`API_KEY=${'z'.repeat(20)}`, 'ok'],
    };
    expect(assertNoSecrets(sanitizeForAi(dirty))).toEqual([]);
  });
});
