/**
 * Detecção de fonte local — `forge/LocalForgeSourceDetection/v1`.
 *
 * Classifica qualquer caminho fornecido pelo usuário em um dos 8 estados:
 *
 *   GIT_REPOSITORY | GIT_WORKTREE | GITLESS_VALID_FORGE
 *   | GITLESS_PARTIAL_FORGE | UNKNOWN_DIRECTORY | CONFLICTING_IDENTITY
 *   | INVALID_MANIFEST | UNTRUSTED_SOURCE
 *
 * Determinístico e offline: mesma árvore → mesmo veredito; nenhum spawn
 * (`.git` é inspeção de filesystem — direto = repo, arquivo = worktree),
 * nenhuma rede, nenhuma escrita. Níveis de identidade do contrato:
 *
 *   A = `.git` + forge.json válido + estrutura esperada + checksums verificados
 *   B = forge.json válido + estrutura esperada (checksums parciais/ausentes)
 *   C = só forge.json válido
 *   none = não é uma Forja
 *
 * Falha de checksum NUNCA identifica origem — só rebaixa `integrity`.
 * `UNTRUSTED_SOURCE` só sai de identidade não confiável (link simbólico,
 * `.git`/`forge.json` fora do tipo esperado), nunca de checksum.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { contractValidator } from '../contracts/index.js';
import { FORGE_REPOS } from '../constants/repos.js';
import type { ForgeErrorCode } from '../errors.js';
import { isLinkOrJunction } from '../safety.js';

export type SourceState =
  | 'GIT_REPOSITORY'
  | 'GIT_WORKTREE'
  | 'GITLESS_VALID_FORGE'
  | 'GITLESS_PARTIAL_FORGE'
  | 'UNKNOWN_DIRECTORY'
  | 'CONFLICTING_IDENTITY'
  | 'INVALID_MANIFEST'
  | 'UNTRUSTED_SOURCE';

export type IdentityLevel = 'A' | 'B' | 'C' | 'none';
export type SourceIntegrity = 'verified' | 'partial' | 'unverified';

export interface SourceRefusal {
  code: ForgeErrorCode;
  cause: string;
  remedy: string;
}

/** Manifesto `forge.json` parseado com os campos que a identidade usa. */
export interface LocalManifest {
  forgeId: string;
  cli?: string;
  mcpCommand?: string[];
  package?: string;
  distribution?: string;
  version?: string;
  python?: string;
  extras?: string[];
}

export interface SourceDetection {
  schema: 'forge/LocalForgeSourceDetection/v1';
  path: string;
  state: SourceState;
  /** `.git` diretório (repo) ou arquivo (worktree) — detecção por filesystem. */
  is_git: boolean;
  manifest_valid: boolean;
  forge_id?: string;
  manifest?: LocalManifest;
  /** Nível de identidade A/B/C/none — `source_trust` é o mesmo valor. */
  identity: IdentityLevel;
  source_trust: IdentityLevel;
  integrity: SourceIntegrity;
  structure: { setup_scripts: string[]; project_markers: string[] };
  /** Evidência determinística do veredito (ordem fixa). */
  reasons: string[];
  /** Presente nos estados que recusam operação — código FORGE-* + remédio. */
  refusal?: SourceRefusal;
}

const MANIFEST_MAX_BYTES = 64 * 1024;
const CHECKSUM_MAX_ENTRIES = 10_000;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_DEP_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Candidatos de script de setup — ordem fixa define a ordem reportada. */
const SETUP_CANDIDATES = [
  'setup.sh',
  'install.sh',
  'setup.ps1',
  'install.ps1',
  'install.windows.sh',
] as const;

/** Marcadores de projeto — a estrutura esperada exige ao menos um. */
const PROJECT_MARKERS = [
  'pyproject.toml',
  'package.json',
  'setup.py',
  'requirements.txt',
  path.join('scripts', 'forge_bootstrap.py'),
] as const;

/** Manifestos de checksum reconhecidos — o primeiro encontrado decide. */
const CHECKSUM_FILES = ['SHA256SUMS', 'checksums.sha256', '.forge-checksums.json'] as const;

type ManifestRead =
  | { ok: true; manifest: LocalManifest }
  | {
      ok: false;
      reason:
        | 'absent'
        | 'unreadable'
        | 'invalid-json'
        | 'not-object'
        | 'schema-failed'
        | 'missing-forge-id'
        | 'unsafe-field';
      detail: string;
    };

/**
 * Lê `forge.json` com validação estrita — mais exigente que
 * `readForgeManifest` (que devolve null silencioso): aqui cada falha
 * vira uma razão nomeada para INVALID_MANIFEST, sem rebaixamento mudo.
 */
export function readManifestStrict(dir: string): ManifestRead {
  const file = path.join(dir, 'forge.json');
  if (!existsSync(file)) return { ok: false, reason: 'absent', detail: 'forge.json ausente' };
  let raw: unknown;
  try {
    if (!statSync(file).isFile() || statSync(file).size > MANIFEST_MAX_BYTES) {
      return { ok: false, reason: 'unreadable', detail: 'forge.json ilegível ou grande demais' };
    }
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid-json',
      detail: `forge.json não é JSON válido (${error instanceof Error ? error.message : error})`,
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-object', detail: 'forge.json não é um objeto JSON' };
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.schema === 'string' &&
    contractValidator().validate('forge/ForgeDescriptor/v1', obj).length
  ) {
    return {
      ok: false,
      reason: 'schema-failed',
      detail: `forge.json declara schema e falha na validação forge/ForgeDescriptor/v1`,
    };
  }
  if (typeof obj.forge_id !== 'string' || !obj.forge_id) {
    return { ok: false, reason: 'missing-forge-id', detail: 'forge.json sem forge_id' };
  }
  const unsafe = (field: string): ManifestRead => ({
    ok: false,
    reason: 'unsafe-field',
    detail: `forge.json: campo ${field} com valor fora do formato seguro`,
  });
  // '..' também é traversal — o forge_id vira chave de state e dir de receipt.
  if (!SAFE_TOKEN.test(obj.forge_id) || obj.forge_id.includes('..')) {
    return unsafe('forge_id');
  }
  const manifest: LocalManifest = { forgeId: obj.forge_id };
  if (obj.cli !== undefined && obj.cli !== null) {
    if (typeof obj.cli !== 'string' || !SAFE_TOKEN.test(obj.cli)) return unsafe('cli');
    manifest.cli = obj.cli;
  }
  if (obj.mcp_command !== undefined) {
    if (
      !Array.isArray(obj.mcp_command) ||
      !obj.mcp_command.length ||
      !obj.mcp_command.every((t) => typeof t === 'string' && SAFE_TOKEN.test(t))
    ) {
      return unsafe('mcp_command');
    }
    manifest.mcpCommand = obj.mcp_command as string[];
  }
  for (const field of ['package', 'distribution'] as const) {
    const val = obj[field];
    if (val === undefined || val === null) continue;
    if (typeof val !== 'string' || !SAFE_DEP_TOKEN.test(val)) return unsafe(field);
    manifest[field] = val;
  }
  for (const field of ['version', 'python'] as const) {
    const val = obj[field];
    if (val === undefined || val === null) continue;
    if (typeof val !== 'string' || !val.trim()) return unsafe(field);
    manifest[field] = val;
  }
  if (obj.extras !== undefined) {
    if (
      !Array.isArray(obj.extras) ||
      !obj.extras.every((t) => typeof t === 'string' && SAFE_DEP_TOKEN.test(t))
    ) {
      return unsafe('extras');
    }
    manifest.extras = obj.extras as string[];
  }
  return { ok: true, manifest };
}

/** Estrutura esperada: scripts de setup e marcadores de projeto presentes. */
function scanStructure(dir: string): { setup_scripts: string[]; project_markers: string[] } {
  const setup = SETUP_CANDIDATES.filter((f) => {
    try {
      return statSync(path.join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
  const markers = PROJECT_MARKERS.filter((f) => existsSync(path.join(dir, f)));
  return { setup_scripts: [...setup], project_markers: [...markers] };
}

/**
 * Verifica o manifesto de checksum da fonte, se houver (`SHA256SUMS`,
 * `checksums.sha256` ou `.forge-checksums.json`). Toda entrada precisa
 * existir, ser arquivo e conferir — um arquivo listado que falta ou
 * diverge rebaixa para `partial`. Nunca conclui origem: só integridade.
 */
function verifyChecksums(dir: string, reasons: string[]): SourceIntegrity {
  const found = CHECKSUM_FILES.find((f) => {
    try {
      return statSync(path.join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
  if (!found) {
    reasons.push('checksums=sem-manifesto');
    return 'unverified';
  }
  const entries: { file: string; sha256: string }[] = [];
  try {
    if (found.endsWith('.json')) {
      const raw: unknown = JSON.parse(readFileSync(path.join(dir, found), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        if (obj.files !== undefined) {
          if (!Array.isArray(obj.files)) throw new Error('files não é lista');
          for (const item of obj.files) {
            if (
              item &&
              typeof item === 'object' &&
              typeof (item as { path?: unknown }).path === 'string' &&
              typeof (item as { sha256?: unknown }).sha256 === 'string'
            ) {
              entries.push({
                file: (item as { path: string }).path,
                sha256: (item as { sha256: string }).sha256,
              });
            }
          }
        } else {
          for (const [file, digest] of Object.entries(obj)) {
            if (typeof digest === 'string') entries.push({ file, sha256: digest });
          }
        }
      }
    } else {
      for (const line of readFileSync(path.join(dir, found), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/);
        if (m) entries.push({ file: m[2].trim(), sha256: m[1].toLowerCase() });
      }
    }
  } catch {
    reasons.push(`checksums=${found}:manifesto-ilegível`);
    return 'partial';
  }
  if (!entries.length || entries.length > CHECKSUM_MAX_ENTRIES) {
    reasons.push(
      `checksums=${found}:${entries.length ? `excede-limite(${CHECKSUM_MAX_ENTRIES})` : 'vazio'}`,
    );
    return 'partial';
  }
  let failed = 0;
  for (const entry of entries) {
    const target = path.resolve(dir, entry.file);
    const rel = path.relative(dir, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      failed++;
      continue;
    }
    try {
      if (!statSync(target).isFile()) {
        failed++;
        continue;
      }
      const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
      if (digest !== entry.sha256.toLowerCase()) failed++;
    } catch {
      failed++;
    }
  }
  reasons.push(`checksums=${found}:${failed ? `${failed}/${entries.length}-divergentes` : 'ok'}`);
  return failed ? 'partial' : 'verified';
}

/**
 * Contradição manifesto × estrutura — só nomeia conflito quando a
 * identidade é realmente contraditória (nunca por checksum):
 * - basename do diretório é uma Forja do catálogo diferente do forge_id;
 * - forge_id do catálogo combinado com `cli`/`distribution`/`package`
 *   que resolve para OUTRA Forja do catálogo (identidade interna
 *   contraditória — forge.json que parece montado de partes distintas).
 */
function conflictingIdentity(dir: string, manifest: LocalManifest): string | null {
  const catalogNames = new Map(FORGE_REPOS.map((r) => [r.name, r.name]));
  const catalogTokens = new Map<string, string>();
  for (const r of FORGE_REPOS) catalogTokens.set(r.name, r.name);
  const basename = path.basename(dir).toLowerCase();
  const forgeId = manifest.forgeId;
  const claimed = catalogNames.get(basename);
  if (claimed && claimed !== forgeId) {
    return `diretório '${path.basename(dir)}' é a Forja '${claimed}' do catálogo, mas forge.json declara '${forgeId}'`;
  }
  if (!catalogNames.has(forgeId)) return null;
  for (const [field, token] of [
    ['cli', manifest.cli],
    ['distribution', manifest.distribution],
    ['package', manifest.package],
  ] as const) {
    if (!token) continue;
    const other = catalogTokens.get(token);
    if (other && other !== forgeId) {
      return `forge.json declara forge_id='${forgeId}' mas ${field}='${token}' pertence a '${other}'`;
    }
  }
  return null;
}

function refusal(code: ForgeErrorCode, cause: string, remedy: string): SourceRefusal {
  return { code, cause, remedy };
}

/**
 * Classifica `input` (caminho fornecido pelo usuário). Mesma entrada →
 * mesmo veredito; toda evidência vem do filesystem local.
 */
export function detectSource(input: string, cwd = process.cwd()): SourceDetection {
  const dir = path.resolve(cwd, input);
  const reasons: string[] = [];
  const base: Omit<SourceDetection, 'state' | 'reasons' | 'refusal'> = {
    schema: 'forge/LocalForgeSourceDetection/v1',
    path: dir,
    is_git: false,
    manifest_valid: false,
    identity: 'none',
    source_trust: 'none',
    integrity: 'unverified',
    structure: { setup_scripts: [], project_markers: [] },
  };
  const verdict = (
    state: SourceState,
    extra: Partial<SourceDetection> = {},
    ref?: SourceRefusal,
  ): SourceDetection => ({
    ...base,
    ...extra,
    state,
    reasons: [...reasons, ...(extra.reasons ?? [])],
    ...(ref ? { refusal: ref } : {}),
  });

  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch {
    return verdict(
      'UNKNOWN_DIRECTORY',
      {},
      refusal(
        'FORGE-SOURCE-NOT-FOUND',
        `caminho inexistente: ${dir}`,
        'verifique o caminho ou instale pelo nome do catálogo/PyPI',
      ),
    );
  }
  if (st.isSymbolicLink() || isLinkOrJunction(dir)) {
    reasons.push('path=link-simbólico');
    return verdict(
      'UNTRUSTED_SOURCE',
      {},
      refusal(
        'FORGE-SOURCE-INVALID',
        `fonte é link simbólico/junction: ${dir}`,
        'passe o diretório real — fontes por link não são confiáveis',
      ),
    );
  }
  if (!st.isDirectory()) {
    reasons.push('path=não-é-diretório');
    return verdict(
      'UNKNOWN_DIRECTORY',
      {},
      refusal(
        'FORGE-SOURCE-NOT-FOUND',
        `caminho não é um diretório: ${dir}`,
        'aponte o diretório da Forja (não um arquivo)',
      ),
    );
  }

  // `.git`: diretório = repo git; arquivo = ponteiro de worktree; outro
  // tipo ou link → fonte não confiável (nunca normalizado para repo).
  let gitKind: 'repo' | 'worktree' | null = null;
  const gitPath = path.join(dir, '.git');
  try {
    const gst = lstatSync(gitPath);
    if (gst.isSymbolicLink()) {
      reasons.push('.git=link-simbólico');
      return verdict(
        'UNTRUSTED_SOURCE',
        {},
        refusal(
          'FORGE-SOURCE-INVALID',
          `.git é link simbólico em ${dir}`,
          'aponte o checkout real — .git por link não é confiável',
        ),
      );
    }
    if (gst.isFile()) {
      gitKind = 'worktree';
      const pointer = readFileSync(gitPath, 'utf8').slice(0, 4096);
      reasons.push(pointer.startsWith('gitdir:') ? '.git=worktree(gitdir)' : '.git=arquivo');
    } else if (gst.isDirectory()) {
      gitKind = 'repo';
      reasons.push('.git=diretório');
    } else {
      reasons.push('.git=tipo-inesperado');
      return verdict(
        'UNTRUSTED_SOURCE',
        {},
        refusal(
          'FORGE-SOURCE-INVALID',
          `.git tem tipo inesperado em ${dir}`,
          'aponte um checkout ou diretório-fonte comum',
        ),
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      reasons.push(`.git=ilegível(${(error as NodeJS.ErrnoException).code ?? 'erro'})`);
    }
  }

  // forge.json por link = manifesto plantado fora da fonte — não confiável.
  try {
    if (lstatSync(path.join(dir, 'forge.json')).isSymbolicLink()) {
      reasons.push('forge.json=link-simbólico');
      return verdict(
        'UNTRUSTED_SOURCE',
        { is_git: gitKind !== null },
        refusal(
          'FORGE-SOURCE-INVALID',
          `forge.json é link simbólico em ${dir}`,
          'a identidade precisa estar dentro da fonte',
        ),
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      reasons.push(`forge.json=ilegível(${(error as NodeJS.ErrnoException).code ?? 'erro'})`);
    }
  }

  const read = readManifestStrict(dir);
  const structure = scanStructure(dir);
  const expected = structure.setup_scripts.length > 0 && structure.project_markers.length > 0;

  if (gitKind === null) {
    // Fonte sem `.git`: a identidade é o forge.json — sem ele não há
    // marcador de Forja e o diretório é desconhecido por definição.
    if (!existsSync(path.join(dir, 'forge.json'))) {
      reasons.push('forge.json=ausente');
      return verdict(
        'UNKNOWN_DIRECTORY',
        { structure },
        refusal(
          'FORGE-SOURCE-NOT-FOUND',
          `nenhum marcador de Forja em ${dir} (sem .git e sem forge.json)`,
          'aponte uma fonte com forge.json ou instale pelo catálogo',
        ),
      );
    }
    if (!read.ok) {
      reasons.push(`forge.json=${read.reason}`);
      return verdict(
        'INVALID_MANIFEST',
        { structure },
        refusal(
          'FORGE-SOURCE-INVALID',
          `${dir}: ${read.detail}`,
          'corrija forge.json (JSON válido + forge_id) ou aponte o diretório correto',
        ),
      );
    }
    const conflict = conflictingIdentity(dir, read.manifest);
    if (conflict) {
      reasons.push(`conflito=${conflict}`);
      return verdict(
        'CONFLICTING_IDENTITY',
        {
          manifest_valid: true,
          forge_id: read.manifest.forgeId,
          manifest: read.manifest,
          structure,
        },
        refusal(
          'FORGE-SOURCE-CONFLICT',
          `${dir}: ${conflict}`,
          'corrija forge.json ou aponte o diretório da Forja declarada',
        ),
      );
    }
    const integrity = verifyChecksums(dir, reasons);
    const state: SourceState = expected ? 'GITLESS_VALID_FORGE' : 'GITLESS_PARTIAL_FORGE';
    reasons.push(`estrutura=${expected ? 'completa' : 'parcial'}`);
    return verdict(state, {
      manifest_valid: true,
      forge_id: read.manifest.forgeId,
      manifest: read.manifest,
      identity: expected ? 'B' : 'C',
      source_trust: expected ? 'B' : 'C',
      // Fonte parcial registra 'partial' por definição (estrutura
      // incompleta é a evidência — nunca upgrade silencioso).
      integrity: state === 'GITLESS_PARTIAL_FORGE' ? 'partial' : integrity,
      structure,
    });
  }

  // Com `.git` o estado é o repo; manifesto/estrutura viram evidência do
  // nível de identidade (A exige git + manifesto + estrutura + checksums).
  const manifestValid = read.ok === true;
  const integrity = verifyChecksums(dir, reasons);
  const identity: IdentityLevel = !manifestValid
    ? 'none'
    : expected
      ? integrity === 'verified' && gitKind === 'repo'
        ? 'A'
        : 'B'
      : 'C';
  return verdict(gitKind === 'repo' ? 'GIT_REPOSITORY' : 'GIT_WORKTREE', {
    is_git: true,
    manifest_valid: manifestValid,
    ...(manifestValid ? { forge_id: read.manifest.forgeId, manifest: read.manifest } : {}),
    identity,
    source_trust: identity,
    integrity,
    structure,
  });
}

/** Estados que a fonte local pode instalar/receber update (com ressalvas). */
export const INSTALLABLE_STATES: readonly SourceState[] = [
  'GIT_REPOSITORY',
  'GIT_WORKTREE',
  'GITLESS_VALID_FORGE',
  'GITLESS_PARTIAL_FORGE',
];

/**
 * O argumento é um caminho de diretório (existe) ou tem cara de caminho
 * (separador/`.`), nunca um nome de Forja — decide o roteamento local.
 */
export function looksLikePathArg(arg: string, cwd = process.cwd()): boolean {
  if (arg.includes('/') || arg.includes('\\') || arg.startsWith('.')) return true;
  try {
    return statSync(path.resolve(cwd, arg)).isDirectory();
  } catch {
    return false;
  }
}
