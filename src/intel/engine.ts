/**
 * §6.1/§6.2 — deterministic three-domain intelligence engine.
 *
 * Every answer maps one question of the §6.1 sets onto the deterministic
 * core (discovery, recommend, doctor2 + heal registry) and carries
 * evidence, a confidence tier, the rule ids that produced it and honest
 * limitations. No LLM, no network, no hidden wall-clock (opts.now).
 */

import { discoverEnvironment, type DiscoveryLimits, type EnvReport } from '../discovery.js';
import { runDoctor2, type DoctorCheck, type DoctorReport } from '../doctor2/index.js';
import { classifyFindings } from '../heal/registry.js';
import type { HostAdapter } from '../hosts/types.js';
import { RULES, recommendForjas, type Recommendation } from '../recommend.js';
import { redactSecrets } from '../safety.js';
import type { ForgeRepo } from '../types.js';
import type { Confidence, Evidence, IntelAnswer } from './contracts.js';

export interface IntelOptions {
  /** Injected ISO clock — every timestamp upstream comes from it. */
  now?: () => string;
  /** Home dir for host detection / doctor2 (default: os.homedir()). */
  home?: string;
  /** Host adapters — tests inject hostAdapters(fakeProbe). */
  adapters?: readonly HostAdapter[];
  /** Discovery walk bounds (bounded by defaults otherwise). */
  limits?: Partial<DiscoveryLimits>;
}

const ev = (source: string, fact: string): Evidence => ({
  source,
  fact: redactSecrets(fact),
});

/** Code-unit compare — identical order on every machine (localeCompare isn't). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const mk = (
  question: string,
  answer: string,
  confidence: Confidence,
  evidence: readonly Evidence[],
  explanation: readonly string[],
  limitations: readonly string[] = [],
): IntelAnswer => ({
  question,
  answer: redactSecrets(answer),
  confidence,
  evidence,
  explanation,
  limitations,
});

async function envReport(targetDir: string, opts: IntelOptions): Promise<EnvReport> {
  const nowIso = () => opts.now?.() ?? new Date().toISOString();
  return discoverEnvironment(targetDir, {
    ...(opts.limits ? { limits: opts.limits } : {}),
    now: () => {
      const t = Date.parse(nowIso());
      return Number.isFinite(t) ? t : 0;
    },
  });
}

function confidenceOf(score: number): Confidence {
  if (score >= 0.7) return 'high';
  if (score >= 0.5) return 'medium';
  if (score > 0) return 'low';
  return 'unknown';
}

/** Markers that produced a given signal — the "why" behind stack claims. */
function signalEvidence(report: EnvReport, signal: string): Evidence[] {
  const files = report.workspace.markers
    .filter((m) => m.signals.includes(signal))
    .map((m) => m.file)
    .sort();
  if (files.length) {
    return files.slice(0, 3).map((file) => ev(`marker:${signal}`, file));
  }
  const host = report.hosts.find((h) => h.detected && `${h.name}-host` === signal);
  return [ev(`signal:${signal}`, host ? `probe do host '${host.name}'` : 'detectado')];
}

function ruleFor(rec: Recommendation): string {
  const rule = RULES.find((r) => r.out().forge_id === rec.forge_id);
  return rule?.id ?? rec.forge_id;
}

// ---------------------------------------------------------------------------
// §6.1 — discovery domain
// ---------------------------------------------------------------------------

export async function answerDiscovery(
  targetDir: string,
  repos: readonly ForgeRepo[],
  opts: IntelOptions = {},
): Promise<IntelAnswer[]> {
  const report = await envReport(targetDir, opts);
  const catalogNames = new Set(repos.map((r) => r.name));
  const declared = report.forges.filter((f) => catalogNames.has(f.name));
  const extra = report.forges.filter((f) => !catalogNames.has(f.name) && f.state !== 'unknown');
  const scoped = repos.length ? declared : report.forges;
  const known = scoped.filter((f) => f.state !== 'unknown');
  const missing = repos.filter((r) => !report.forges.some((f) => f.name === r.name));

  const answers: IntelAnswer[] = [];

  answers.push(
    mk(
      'Quais Forjas estão presentes e em que estado?',
      known.length
        ? known.map((f) => `${f.name} (${f.state})`).join(', ')
        : 'nenhuma evidência local de Forja',
      report.truncated ? 'medium' : known.length ? 'high' : 'medium',
      [
        ...known.map((f) => ev(`forge:${f.name}`, `state=${f.state} — ${f.evidence}`)),
        ev(
          'discovery:catalog',
          `${known.length}/${scoped.length} Forja(s) do escopo com evidência local`,
        ),
      ],
      ['intel/discovery/forges', 'contracts/resolveDiscovery'],
      [
        ...(report.truncated
          ? ['varredura limitada atingiu um teto — checkouts profundos podem faltar']
          : []),
        ...(extra.length
          ? [`${extra.length} Forja(s) fora do catálogo: ${extra.map((f) => f.name).join(', ')}`]
          : []),
        ...(missing.length ? [`sem varredura para: ${missing.map((r) => r.name).join(', ')}`] : []),
      ],
    ),
  );

  const signals = report.signals;
  answers.push(
    mk(
      'Qual stack o workspace aparenta ter?',
      signals.length ? signals.join(', ') : 'nenhum sinal de stack detectado',
      signals.length ? 'high' : 'low',
      [
        ...signals.flatMap((s) => signalEvidence(report, s)),
        ev('discovery:walk', `${report.workspace.markers.length} marcador(es) lido(s)`),
      ],
      ['intel/discovery/stack', 'discovery/markers+deps'],
      [
        `conteúdo lido apenas em marcadores ≤256 KiB (depth ≤ ${report.limits.maxDepth})`,
        ...(report.truncated ? ['varredura truncada — sinais podem estar incompletos'] : []),
      ],
    ),
  );

  const detectedHosts = report.hosts.filter((h) => h.detected);
  answers.push(
    mk(
      'Quais hosts de IA foram detectados?',
      detectedHosts.length
        ? detectedHosts.map((h) => h.name).join(', ')
        : 'nenhum host detectado por probe',
      detectedHosts.length ? 'medium' : 'low',
      detectedHosts.length
        ? detectedHosts.map((h) =>
            ev(`probe:${h.name}`, `detectado version=${h.version ?? 'desconhecida'}`),
          )
        : [
            ev(
              'host-probes',
              `${report.hosts.length} probe(s) executado(s) — nenhum host detectado`,
            ),
          ],
      ['intel/discovery/hosts', 'discovery/host-probes'],
      [
        'probe é apenas `nome --version` — auth e integração não são provadas aqui',
        `${report.hosts.length - detectedHosts.length} host(s) do conjunto conhecido não detectado(s)`,
      ],
    ),
  );

  const found = report.tools.filter((t) => t.found);
  const absent = report.tools.filter((t) => !t.found);
  answers.push(
    mk(
      'Quais ferramentas do toolchain estão disponíveis?',
      found.length
        ? `disponíveis: ${found.map((t) => t.name).join(', ')}` +
            (absent.length ? ` · ausentes: ${absent.map((t) => t.name).join(', ')}` : '')
        : 'nenhuma ferramenta do conjunto conhecido encontrada',
      absent.length ? 'medium' : 'high',
      report.tools.map((t) =>
        ev(`tool:${t.name}`, t.found ? `found version=${t.version ?? '?'}` : 'not found'),
      ),
      ['intel/discovery/tools', 'discovery/tool-probes'],
      ['probes são chamadas `--version` locais — não provam versão mínima nem PATH de login'],
    ),
  );

  const envFiles = report.workspace.env_files;
  answers.push(
    mk(
      'Onde há arquivos .env no workspace?',
      envFiles.length ? envFiles.join(', ') : 'nenhum arquivo .env encontrado',
      'high',
      envFiles.length
        ? envFiles.map((f) => ev('env-file', f))
        : [ev('env-scan', 'nenhum .env na varredura do workspace')],
      ['intel/discovery/env-files', 'discovery/env-scan'],
      ['conteúdo de .env nunca é lido — apenas presença e caminho'],
    ),
  );

  return [...answers].sort((a, b) => cmp(a.question, b.question));
}

// ---------------------------------------------------------------------------
// §6.1 — recommendation domain
// ---------------------------------------------------------------------------

export async function answerRecommendation(
  targetDir: string,
  repos: readonly ForgeRepo[],
  opts: IntelOptions = {},
): Promise<IntelAnswer[]> {
  const report = await envReport(targetDir, opts);
  const result = recommendForjas(report, repos);
  const [top] = result.recommendations;

  const answers: IntelAnswer[] = [];

  const pct = (c: number) => `${Math.round(c * 100)}%`;
  answers.push(
    mk(
      'Qual Forja a evidência recomenda instalar?',
      top
        ? `${top.forge_id} (confiança ${pct(top.confidence)}) — ${top.why[0] ?? 'regra aplicada'}`
        : 'nenhuma recomendação — sinais insuficientes',
      confidenceOf(top?.confidence ?? 0),
      top
        ? [
            ...RULES.filter((r) => r.out().forge_id === top.forge_id).flatMap((r) =>
              r.expects
                .filter((s) => result.signals.includes(s))
                .flatMap((s) => signalEvidence(report, s)),
            ),
            ev('recommend:rule', `${ruleFor(top)} base → ${pct(top.confidence)}`),
          ]
        : [ev('recommend:rules', `${RULES.length} regras avaliadas — nenhuma aplicável`)],
      ['intel/recommendation/top', ...result.recommendations.map((r) => `rule:${ruleFor(r)}`)],
      [
        ...result.questions,
        'recomendação ordena sinais — não prova que a instalação vai funcionar',
      ],
    ),
  );

  const rest = result.recommendations.slice(1);
  answers.push(
    mk(
      'Quais alternativas foram consideradas?',
      rest.length
        ? rest.map((r) => `${r.forge_id} (${pct(r.confidence)})`).join(', ')
        : 'nenhuma alternativa acima do piso',
      'high',
      rest.length
        ? rest.map((r) =>
            ev(`recommend:${r.forge_id}`, `confidence=${pct(r.confidence)} — ${r.why[0] ?? ''}`),
          )
        : [ev('recommend:rules', `${RULES.length} regras — só uma ou nenhuma aplicável`)],
      ['intel/recommendation/alternatives', 'recommend/sort-desc'],
      result.questions.length
        ? result.questions
        : ['alternativas abaixo de 50% nunca são sugeridas sem confirmação'],
    ),
  );

  const prereqs = [...new Set(result.recommendations.flatMap((r) => r.prereqs ?? []))].sort();
  answers.push(
    mk(
      'Faltam pré-requisitos para as recomendações?',
      prereqs.length
        ? `faltam: ${prereqs.join(', ')}`
        : 'nenhum pré-requisito ausente nas recomendações',
      prereqs.length ? 'high' : 'medium',
      prereqs.length
        ? prereqs.map((p) => ev('prereq', p))
        : [ev('prereq', 'todas as ferramentas exigidas pelas regras aplicáveis foram detectadas')],
      ['intel/recommendation/prereqs', 'recommend/tools-missing'],
      ['pré-requisitos vêm dos probes de `--version` — um PATH alterado pode mudar o resultado'],
    ),
  );

  answers.push(
    mk(
      'Quais Forjas recomendáveis já estão presentes?',
      result.already_present.length
        ? result.already_present.join(', ')
        : 'nenhuma recomendável já presente',
      'high',
      result.already_present.length
        ? result.already_present.map((name) => {
            const f = report.forges.find((x) => x.name === name);
            return ev(`forge:${name}`, `state=${f?.state ?? 'presente'} — ${f?.evidence ?? ''}`);
          })
        : [ev('recommend:present', 'nenhuma Forja recomendável em estado presente')],
      ['intel/recommendation/already-present', 'recommend/present-states'],
      [],
    ),
  );

  return [...answers].sort((a, b) => cmp(a.question, b.question));
}

// ---------------------------------------------------------------------------
// §6.1 — repair domain (doctor2 findings + heal risk classes)
// ---------------------------------------------------------------------------

const RESULT_RANK: Record<string, number> = { fail: 0, warn: 1, unverified: 2, skip: 3, pass: 4 };

function troubledChecks(report: DoctorReport): DoctorCheck[] {
  return report.checks
    .filter((c) => c.result === 'fail' || c.result === 'warn')
    .sort((a, b) => RESULT_RANK[a.result] - RESULT_RANK[b.result] || cmp(a.id, b.id));
}

export async function answerRepair(
  targetDir: string,
  repos: readonly ForgeRepo[],
  opts: IntelOptions = {},
): Promise<IntelAnswer[]> {
  const nowIso = () => opts.now?.() ?? new Date().toISOString();
  const report = await runDoctor2(targetDir, {
    now: nowIso,
    catalog: repos,
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
  });
  const troubled = troubledChecks(report);
  const planned = classifyFindings(troubled);

  const answers: IntelAnswer[] = [];

  answers.push(
    mk(
      'O que está quebrado ou degradado no workspace?',
      troubled.length
        ? `${troubled.length} achado(s): ${troubled
            .slice(0, 3)
            .map((c) => c.id)
            .join(', ')}${troubled.length > 3 ? '…' : ''}`
        : 'nenhum achado fail/warn',
      report.checks.length === 0 ? 'unknown' : report.truncated ? 'medium' : 'high',
      [
        ev(
          'doctor2/report',
          `${report.checks.length} check(s) executados, ${troubled.length} achado(s) fail/warn`,
        ),
        ...troubled
          .slice(0, 8)
          .flatMap((c) => [
            ev(`check:${c.id}`, `${c.result}/${c.severity} — ${c.diagnosis}`),
            ...c.evidence.slice(0, 2).map((e) => ev(`check:${c.id}`, e)),
          ]),
      ],
      ['intel/repair/findings', 'doctor2/five-domains'],
      [
        ...(report.truncated
          ? ['varredura limitada — relatórios antigos podem não ter sido lidos']
          : []),
        ...(() => {
          const unverified = report.checks.filter((c) => c.result === 'unverified').length;
          return unverified ? [`${unverified} check(s) não puderam ser verificados`] : [];
        })(),
      ],
    ),
  );

  const byClass = new Map<string, number>();
  for (const p of planned) byClass.set(p.riskClass, (byClass.get(p.riskClass) ?? 0) + 1);
  answers.push(
    mk(
      'O que pode ser reparado automaticamente e com que risco?',
      planned.length
        ? [...byClass.entries()]
            .sort(([a], [b]) => cmp(a, b))
            .map(([k, n]) => `${n}× ${k}`)
            .join(', ')
        : 'nada a reparar — nenhum achado fail/warn',
      'high',
      planned.length
        ? planned.map((p) =>
            ev(
              `repair:${p.check.id}`,
              `${p.riskClass}${p.action ? ` — ${p.action.description}` : ' — sem reparo conhecido'}`,
            ),
          )
        : [ev('heal/classify', '0 achados classificáveis')],
      ['intel/repair/plan', 'heal/classifyFindings', 'heal/risk-classes'],
      [
        'MANUAL_ONLY e UNSUPPORTED nunca são aplicados automaticamente',
        'REVIEW_REQUIRED exige revisão humana antes de qualquer escrita',
      ],
    ),
  );

  const score = report.score;
  answers.push(
    mk(
      'Qual o score de saúde do workspace?',
      score.value === null
        ? 'não verificado — evidência insuficiente para pontuar'
        : `${score.value}/100 (modelo ${score.model})`,
      score.value === null ? 'unknown' : 'high',
      [
        ev(
          'score:sufficiency',
          `observados=${score.sufficiency.observed} exigidos=${score.sufficiency.required}`,
        ),
        ...Object.entries(score.domains)
          .filter(([, d]) => d.checks > 0)
          .sort(([a], [b]) => cmp(a, b))
          .map(([d, v]) =>
            ev(`score:${d}`, `${v.checks} checks, ${v.failed} fail, ${v.warned} warn`),
          ),
      ],
      ['intel/repair/score', 'forge-health/v1'],
      score.value === null
        ? ['menos checks com evidência do que o mínimo do modelo — score recusado de propósito']
        : ['score é um modelo transparente (forge-health/v1), não uma garantia'],
    ),
  );

  return [...answers].sort((a, b) => cmp(a.question, b.question));
}
