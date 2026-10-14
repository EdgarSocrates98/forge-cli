import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AI_TASKS,
  isAiProposalShape,
  parseProposal,
  validateProposal,
  type AiRefCatalog,
} from '../src/ai/proposal.js';
import { AI_PROPOSAL_SCHEMA, type AiProposal } from '../src/ai/types.js';

const CATALOG: AiRefCatalog = {
  forjas: ['api-forge', 'the-forge'],
  hosts: ['claude-code'],
  verbs: ['doctor'],
};

const validJson = (items: unknown[] = [{ title: 't', detail: 'd' }]) =>
  JSON.stringify({
    schema: AI_PROPOSAL_SCHEMA,
    task: 'suggest-tasks',
    summary: 'a summary',
    items,
  });

describe('parseProposal', () => {
  it('rejects non-JSON input', () => {
    expect(parseProposal('not json at all')).toEqual({ error: 'invalid-json' });
    expect(parseProposal('')).toEqual({ error: 'invalid-json' });
  });

  it('rejects non-object JSON', () => {
    expect(parseProposal('[]')).toEqual({ error: 'not-an-object' });
    expect(parseProposal('42')).toEqual({ error: 'not-an-object' });
    expect(parseProposal('null')).toEqual({ error: 'not-an-object' });
  });

  it('rejects wrong schema, task, summary and items', () => {
    expect(parseProposal(JSON.stringify({ schema: 'x' }))).toEqual({ error: 'bad-schema' });
    expect(
      parseProposal(JSON.stringify({ schema: AI_PROPOSAL_SCHEMA, task: 'delete-everything' })),
    ).toEqual({ error: 'bad-task' });
    expect(
      parseProposal(
        JSON.stringify({ schema: AI_PROPOSAL_SCHEMA, task: 'suggest-tasks', summary: '  ' }),
      ),
    ).toEqual({ error: 'bad-summary' });
    expect(
      parseProposal(
        JSON.stringify({
          schema: AI_PROPOSAL_SCHEMA,
          task: 'suggest-tasks',
          summary: 's',
          items: 'nope',
        }),
      ),
    ).toEqual({ error: 'bad-items' });
  });

  it('rejects malformed items with positional detail', () => {
    expect(parseProposal(validJson([{ detail: 'd' }]))).toEqual({ error: 'bad-item:0' });
    expect(
      parseProposal(
        validJson([
          { title: 't', detail: 'd' },
          { title: '', detail: 'x' },
        ]),
      ),
    ).toEqual({ error: 'bad-item:1' });
    expect(parseProposal(validJson([{ title: 't', detail: 'd', ref: '' }]))).toEqual({
      error: 'bad-item:0',
    });
  });

  it('accepts every task in the exact enum and nothing else', () => {
    for (const task of AI_TASKS) {
      const raw = JSON.stringify({
        schema: AI_PROPOSAL_SCHEMA,
        task,
        summary: 's',
        items: [],
      });
      const parsed = parseProposal(raw);
      expect('error' in parsed).toBe(false);
    }
  });

  it('parses a valid proposal', () => {
    const parsed = parseProposal(validJson([{ title: 'a', detail: 'b', ref: 'api-forge' }]));
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.task).toBe('suggest-tasks');
    expect(parsed.items[0]?.ref).toBe('api-forge');
  });
});

describe('validateProposal', () => {
  const proposal = (refs: (string | undefined)[]): AiProposal => ({
    schema: AI_PROPOSAL_SCHEMA,
    task: 'recommend-alternatives',
    summary: 's',
    items: refs.map((ref) => ({ title: 't', detail: 'd', ...(ref ? { ref } : {}) })),
  });

  it('accepts bare and prefixed refs that exist in the catalog', () => {
    const result = validateProposal(
      proposal(['api-forge', 'forja:the-forge', 'host:claude-code', 'verb:doctor', undefined]),
      CATALOG,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects unknown bare and prefixed refs', () => {
    const result = validateProposal(proposal(['nope', 'forja:missing']), CATALOG);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toEqual([
      'item 0: unknown ref "nope"',
      'item 1: unknown ref "forja:missing"',
    ]);
  });

  it('rejects unknown ref kinds and empty names', () => {
    const result = validateProposal(proposal(['tool:hammer', 'forja:']), CATALOG);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toEqual([
      'item 0: unknown ref "tool:hammer"',
      'item 1: unknown ref "forja:"',
    ]);
  });

  it('returns deterministic sorted reasons', () => {
    const result = validateProposal(proposal(['zzz', 'aaa']), CATALOG);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons).toEqual([...result.reasons].sort());
  });
});

describe('display-only guarantee', () => {
  it('proposal module exposes no execution capability', () => {
    const src = readFileSync(new URL('../src/ai/proposal.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/execa|child_process|spawn|exec\(|eval\(|Function\(/);
  });

  it('isAiProposalShape accepts only the exact schema', () => {
    expect(isAiProposalShape(JSON.parse(validJson()))).toBe(true);
    expect(isAiProposalShape({ schema: 'other' })).toBe(false);
  });
});
