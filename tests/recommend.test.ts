import { describe, expect, it } from 'vitest';
import { FORGE_REPOS } from '../src/constants/repos.js';
import type { EnvReport } from '../src/discovery.js';
import { recommendForjas, RULES } from '../src/recommend.js';

function makeReport(over: Partial<EnvReport> = {}): EnvReport {
  return {
    schema: 'forge-cli/EnvReport/v1',
    generated_at: '2026-01-01T00:00:00.000Z',
    os: { platform: 'win32', release: '10.0', arch: 'x64', shell: null },
    tools: ['git', 'node', 'npm', 'python', 'java', 'docker', 'terraform'].map((name) => ({
      name,
      found: true,
      version: '1.0',
    })),
    workspace: { dir: '/w', markers: [], forges: [], env_files: [] },
    hosts: [],
    signals: [],
    forges: [],
    limits: {
      maxDepth: 3,
      maxEntriesPerDir: 500,
      maxTotalEntries: 5000,
      timeoutMs: 2000,
      skipDirs: [],
    },
    truncated: false,
    duration_ms: 0,
    ...over,
  };
}

const SPARK_SIGNALS = ['pyspark', 'aws', 'terraform', 'claude-host', 'docker', 'ci', 'python-app'];

describe('RULES', () => {
  it('são declarativas, com ids únicos e base em (0,1]', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const rule of RULES) {
      expect(rule.base).toBeGreaterThan(0);
      expect(rule.base).toBeLessThanOrEqual(1);
      expect(rule.expects.length).toBeGreaterThan(0);
      expect(typeof rule.when).toBe('function');
    }
  });
});

describe('recommendForjas', () => {
  it('fixture completa pyspark+aws+terraform+claude → spark-forge-aws no topo', () => {
    const report = makeReport({
      signals: SPARK_SIGNALS,
      hosts: [{ name: 'claude', detected: true, version: '1.2.3' }],
    });
    const result = recommendForjas(report);
    expect(result.recommendations[0]?.forge_id).toBe('spark-forge-aws');
    const top = result.recommendations[0];
    expect(top.confidence).toBeGreaterThanOrEqual(0.5);
    expect(top.why.length).toBeGreaterThan(1);
    expect(top.why.join(' ')).toContain('pyspark');
    expect(top.why.join(' ')).toContain('aws');
    expect(top.profile).toBe('recommended');
    expect(top.components).toEqual(['skills', 'agents']);
    expect(top.hosts).toEqual(['claude']);
  });

  it('relatório vazio → pergunta (baixa confiança), nunca chuta', () => {
    const result = recommendForjas(makeReport());
    expect(result.recommendations).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.questions.length).toBeGreaterThan(0);
  });

  it('sinais fracos → confiança < 0.5 gera pergunta de confirmação', () => {
    const report = makeReport({ signals: ['api', 'node-app'] });
    const result = recommendForjas(report);
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.questions.length).toBeGreaterThan(0);
  });

  it('top-2 dentro de 0.1 → pergunta de ambiguidade', () => {
    const report = makeReport({
      signals: ['api', 'python-app', 'docker', 'ci', 'observability', 'data'],
    });
    const result = recommendForjas(report);
    expect(result.recommendations.length).toBeGreaterThanOrEqual(2);
    const [a, b] = result.recommendations;
    expect(a.confidence - b.confidence).toBeCloseTo(0.1, 5);
    expect(result.questions.some((q) => q.includes(a.forge_id))).toBe(true);
  });

  it('forja já instalada (configured) sai para already_present', () => {
    const report = makeReport({
      signals: SPARK_SIGNALS,
      hosts: [{ name: 'claude', detected: true }],
      forges: [{ name: 'spark-forge-aws', state: 'configured', evidence: 'state.json' }],
    });
    const result = recommendForjas(report);
    expect(result.recommendations.every((r) => r.forge_id !== 'spark-forge-aws')).toBe(true);
    expect(result.already_present).toContain('spark-forge-aws');
    expect(result.recommendations[0]?.forge_id).not.toBe('spark-forge-aws');
  });

  it('azure deps → spark-forge-azure', () => {
    const report = makeReport({ signals: ['pyspark', 'azure', 'python-app'] });
    const result = recommendForjas(report);
    expect(result.recommendations[0]?.forge_id).toBe('spark-forge-azure');
  });

  it('pré-reqs: ferramenta ausente vira "instalar <tool>"', () => {
    const report = makeReport({
      signals: SPARK_SIGNALS,
      hosts: [{ name: 'claude', detected: true }],
      tools: [
        { name: 'python', found: true },
        { name: 'java', found: false },
        { name: 'terraform', found: false },
      ],
    });
    const top = recommendForjas(report).recommendations[0];
    expect(top.forge_id).toBe('spark-forge-aws');
    expect(top.prereqs).toEqual(expect.arrayContaining(['instalar java', 'instalar terraform']));
  });

  it('recomendações fora do catálogo são filtradas', () => {
    const report = makeReport({
      signals: SPARK_SIGNALS,
      hosts: [{ name: 'claude', detected: true }],
    });
    const catalog = FORGE_REPOS.filter((r) => r.name !== 'spark-forge-aws');
    const result = recommendForjas(report, catalog);
    expect(result.recommendations.every((r) => r.forge_id !== 'spark-forge-aws')).toBe(true);
  });

  it('determinístico — mesma entrada duas vezes → saída idêntica', () => {
    const report = makeReport({
      signals: SPARK_SIGNALS,
      hosts: [{ name: 'claude', detected: true }],
    });
    expect(JSON.stringify(recommendForjas(report))).toBe(JSON.stringify(recommendForjas(report)));
  });
});
