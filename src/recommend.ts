import { FORGE_REPOS } from './constants/repos.js';
import type { EnvReport } from './discovery.js';
import type { ForgeRepo } from './types.js';

// ---------------------------------------------------------------------------
// §2.2 deterministic recommendation engine — rules are data, never guesses.
// score = base × (fração dos sinais esperados presentes). Cada recomendação
// carrega `why` citando os sinais que contribuíram e `prereqs` das ferramentas
// ausentes. Confiança < 0.5 ou empate no topo (≤0.1) viram perguntas em PT-BR
// — o motor nunca decide no escuro. Forjas já instaladas (estados
// integrated/validated/configured) saem para `already_present`.
// ---------------------------------------------------------------------------

export interface Recommendation {
  forge_id: string;
  profile?: string;
  scope?: string;
  components?: string[];
  hosts?: string[];
  prereqs?: string[];
  why: string[];
  confidence: number;
}

export interface RecommendResult {
  recommendations: Recommendation[];
  questions: string[];
  confidence: number;
  signals: string[];
  /** Forjas recomendáveis por sinais, mas já presentes — nunca re-recomendadas. */
  already_present: string[];
}

export interface RecommendRule {
  id: string;
  /** sinais esperados — a fração presente no relatório pondera a confiança */
  expects: readonly string[];
  /** ferramentas necessárias; as ausentes viram pré-requisitos */
  tools?: readonly string[];
  /** portão mínimo de aplicabilidade sobre o relatório */
  when: (report: EnvReport) => boolean;
  /** recomendação-base (a engine adiciona evidências de sinais e confiança) */
  out: () => Omit<Recommendation, 'confidence'>;
  base: number;
}

const CONFIDENCE_ASK = 0.5;
const CONFIDENCE_TIE = 0.1;
/** Estados que contam como "já instalada" — excluídas da recomendação. */
const PRESENT_STATES = new Set(['integrated', 'validated', 'configured']);

function hasAll(report: EnvReport, ...signals: string[]): boolean {
  const sig = new Set(report.signals);
  return signals.every((s) => sig.has(s));
}

function hostDetected(report: EnvReport, name: string): boolean {
  return report.hosts.some((h) => h.name === name && h.detected);
}

function claudeEvidence(report: EnvReport): boolean {
  // host probed (claude --version) ou projeto claude-enabled (.claude/, CLAUDE.md)
  return hostDetected(report, 'claude') || report.signals.includes('claude-host');
}

export const RULES: RecommendRule[] = [
  {
    // Exemplo trabalhado §2.2: pyspark + aws + terraform + host claude.
    id: 'spark-forge-aws/datalake-claude',
    expects: ['pyspark', 'aws', 'terraform', 'claude-host', 'docker'],
    tools: ['python', 'java', 'terraform'],
    when: (r) => hasAll(r, 'pyspark', 'aws', 'terraform') && claudeEvidence(r),
    out: () => ({
      forge_id: 'spark-forge-aws',
      profile: 'recommended',
      components: ['skills', 'agents'],
      hosts: ['claude'],
      why: ['projeto Spark na AWS com IaC Terraform e host Claude'],
    }),
    base: 0.9,
  },
  {
    id: 'spark-forge-aws/spark-aws',
    expects: ['pyspark', 'aws', 'docker', 'ci'],
    tools: ['python', 'java'],
    when: (r) =>
      hasAll(r, 'pyspark', 'aws') && !(r.signals.includes('terraform') && claudeEvidence(r)),
    out: () => ({
      forge_id: 'spark-forge-aws',
      profile: 'recommended',
      components: ['skills', 'agents'],
      why: ['sinais de pipelines Spark em ambiente AWS'],
    }),
    base: 0.75,
  },
  {
    id: 'spark-forge-azure',
    expects: ['pyspark', 'azure', 'data', 'docker'],
    tools: ['python', 'java'],
    when: (r) => hasAll(r, 'pyspark', 'azure'),
    out: () => ({
      forge_id: 'spark-forge-azure',
      profile: 'recommended',
      components: ['skills', 'agents'],
      why: ['sinais de pipelines Spark em ambiente Azure'],
    }),
    base: 0.85,
  },
  {
    id: 'api-forge',
    expects: ['api', 'python-app', 'docker', 'ci'],
    tools: ['python'],
    when: (r) =>
      r.signals.includes('api') &&
      (r.signals.includes('python-app') || r.signals.includes('node-app')),
    out: () => ({
      forge_id: 'api-forge',
      profile: 'recommended',
      components: ['skills', 'agents'],
      why: ['projeto de APIs/backend detectado (fastapi/openapi/express)'],
    }),
    base: 0.8,
  },
  {
    id: 'forge-doctor-api',
    expects: ['api', 'observability', 'python-app', 'data'],
    tools: ['python'],
    when: (r) =>
      r.signals.includes('api') &&
      (r.signals.includes('observability') || r.signals.includes('data')),
    out: () => ({
      forge_id: 'forge-doctor-api',
      profile: 'recommended',
      components: ['skills', 'agents'],
      why: ['API com sinais de diagnóstico/telemetria'],
    }),
    base: 0.7,
  },
  {
    id: 'forge-doctor-data',
    expects: ['data', 'python-app', 'observability', 'aws'],
    tools: ['python'],
    when: (r) => hasAll(r, 'data', 'python-app'),
    out: () => ({
      forge_id: 'forge-doctor-data',
      profile: 'recommended',
      components: ['skills', 'agents'],
      why: ['pipeline de dados Python com potencial de diagnóstico'],
    }),
    base: 0.7,
  },
  {
    id: 'platform-forge',
    expects: ['terraform', 'kubernetes', 'docker', 'ci'],
    tools: ['terraform', 'docker'],
    when: (r) => r.signals.includes('terraform') || r.signals.includes('kubernetes'),
    out: () => ({
      forge_id: 'platform-forge',
      profile: 'recommended',
      components: ['skills', 'agents'],
      why: ['infraestrutura de plataforma detectada (IaC/containers)'],
    }),
    base: 0.7,
  },
  {
    id: 'forge-portal',
    expects: ['frontend', 'node-app', 'docker'],
    tools: ['node', 'npm'],
    when: (r) => r.signals.includes('frontend'),
    out: () => ({
      forge_id: 'forge-portal',
      why: ['aplicação frontend detectada (dependências de UI)'],
    }),
    base: 0.7,
  },
  {
    // Orquestração genérica: workspace já abriga Forjas/manifests ou multi-host.
    id: 'the-forge',
    expects: ['forge-manifest', 'ci', 'python-app'],
    tools: ['python'],
    when: (r) =>
      r.signals.includes('forge-manifest') || r.hosts.filter((h) => h.detected).length >= 2,
    out: () => ({
      forge_id: 'the-forge',
      profile: 'minimal',
      components: ['skills'],
      why: ['workspace do ecossistema Forge — orquestração/base'],
    }),
    base: 0.5,
  },
];

function evidenceFor(report: EnvReport, signal: string): string {
  const files = report.workspace.markers
    .filter((m) => m.signals.includes(signal))
    .map((m) => m.file)
    .sort();
  if (files.length) return files.slice(0, 3).join(', ');
  const host = report.hosts.find((h) => h.detected && `${h.name}-host` === signal);
  if (host) return `host '${host.name}' detectado`;
  return 'detectado';
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function recommendForjas(
  report: EnvReport,
  catalog: readonly ForgeRepo[] = FORGE_REPOS,
): RecommendResult {
  const signals = [...new Set(report.signals)].sort();
  const sig = new Set(signals);
  const catalogNames = new Set(catalog.map((r) => r.name));
  const toolFound = new Map(report.tools.map((t): [string, boolean] => [t.name, t.found]));
  const installed = new Set(
    report.forges.filter((f) => PRESENT_STATES.has(f.state)).map((f) => f.name),
  );

  const recommendations: Recommendation[] = [];
  const already: string[] = [];
  for (const rule of RULES) {
    const out = rule.out();
    if (!catalogNames.has(out.forge_id) || !rule.when(report)) continue;
    if (installed.has(out.forge_id)) {
      already.push(out.forge_id);
      continue;
    }
    const matched = rule.expects.filter((s) => sig.has(s));
    const missingSignals = rule.expects.filter((s) => !sig.has(s));
    const confidence = round3(
      rule.base * (rule.expects.length ? matched.length / rule.expects.length : 0),
    );
    const why = [
      ...out.why,
      ...matched.map((s) => `sinal '${s}' (${evidenceFor(report, s)})`),
      ...missingSignals.map((s) => `sinal ausente: '${s}'`),
    ];
    const prereqs = [
      ...(out.prereqs ?? []),
      ...(rule.tools ?? []).filter((t) => !toolFound.get(t)).map((t) => `instalar ${t}`),
    ];
    recommendations.push({
      ...out,
      why,
      ...(prereqs.length ? { prereqs: [...new Set(prereqs)] } : {}),
      confidence,
    });
  }

  recommendations.sort((a, b) => b.confidence - a.confidence || (a.forge_id < b.forge_id ? -1 : 1));

  const confidence = recommendations[0]?.confidence ?? 0;
  const questions: string[] = [];
  const [top, runnerUp] = recommendations;
  if (!top) {
    questions.push(
      'Nenhum sinal suficiente no workspace — deseja selecionar as Forjas manualmente?',
    );
  } else {
    if (confidence < CONFIDENCE_ASK) {
      questions.push(
        `Confiança baixa em '${top.forge_id}' (${Math.round(confidence * 100)}%) — ` +
          'confirmar a seleção antes de instalar?',
      );
    }
    if (runnerUp && round3(confidence - runnerUp.confidence) <= CONFIDENCE_TIE) {
      questions.push(
        `Sinais ambíguos entre '${top.forge_id}' e '${runnerUp.forge_id}' — ` +
          'confirmar qual Forja instalar?',
      );
    }
  }

  return {
    recommendations,
    questions,
    confidence,
    signals,
    already_present: [...new Set(already)].sort(),
  };
}
