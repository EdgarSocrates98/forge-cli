import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadState } from '../artifacts.js';
import { parseEnv } from '../envintel/parse.js';
import { deriveSchema } from '../envintel/schema.js';
import { checkEnvLock, exportProfile, importProfile, writeEnvLock } from '../maintenance.js';
import type { EnvLock, ForgeProfile, LockCheck } from '../maintenance.js';
import { buildPlan } from '../planner.js';
import type { OperationPlan, PlanAction, PlanForge } from '../planner.js';
import { writeFileAtomic } from '../safety.js';
import type { ForgeRepo } from '../types.js';
import { buildIntegrityManifest, verifyIntegrityManifest } from './manifest.js';
import type { IntegrityManifest, IntegrityVerification, ManifestInput } from './manifest.js';

// ---------------------------------------------------------------------------
// §6.6 — offline portability bundle (forge-cli/Bundle/v1).
//
// A bundle is a DIRECTORY with fixed filenames — every payload stays a plain,
// auditable JSON document and the integrity manifest covers real on-disk
// bytes, so tamper detection works on the artifact as shipped:
//
//   bundle.json          envelope (schema, generatedAt, file list)
//   profile.json         forge-cli/Profile/v1 from exportProfile
//   env.lock.json        forge-cli/EnvLock/v1 from writeEnvLock
//   env.lock.check.json  LockCheck[] from checkEnvLock at export time
//   env-keys.json        env SCHEMA key names per forja — names, never values
//   env-values.json      whitelisted NON-secret key values (opt-in only)
//   pins.json            forja pins: name + version + ref/head + repo url
//   integrity.json       forge/IntegrityManifest/v1 over all files above
//
// Secrets policy: env VALUES are never exported. `includeEnvKeys` may carry
// values for explicitly whitelisted key names, and the export refuses
// (SecretKeysRefusedError) when a whitelisted name matches the secret
// denylist or the derived schema marks it secret — fail closed, no
// leak path.
// ---------------------------------------------------------------------------

export const BUNDLE_SCHEMA = 'forge-cli/Bundle/v1' as const;

export const BUNDLE_FILES = {
  envelope: 'bundle.json',
  profile: 'profile.json',
  lock: 'env.lock.json',
  lockCheck: 'env.lock.check.json',
  envKeys: 'env-keys.json',
  envValues: 'env-values.json',
  pins: 'pins.json',
  integrity: 'integrity.json',
} as const;

const SECRET_DENYLIST = /TOKEN|SECRET|KEY|PASSWORD|PRIVATE|CREDENTIAL/;

/** Typed refusal: a whitelisted env key looks like a secret. */
export class SecretKeysRefusedError extends Error {
  readonly code = 'secret-keys-refused' as const;
  readonly keys: readonly string[];
  constructor(keys: readonly string[]) {
    super(`whitelisted env keys look secret — refusing to export values: ${keys.join(', ')}`);
    this.name = 'SecretKeysRefusedError';
    this.keys = [...keys].sort();
  }
}

export interface BundlePin {
  readonly name: string;
  readonly url?: string;
  readonly kind?: ForgeRepo['kind'];
  readonly version?: string;
  /** Explicit pin from state (`forge pin`), else the recorded head. */
  readonly ref?: string;
  readonly head?: string;
}

export interface ExportBundleOptions {
  /** Non-secret env key names whose values may travel with the bundle. */
  readonly includeEnvKeys?: readonly string[];
  /** Injected timestamp — deterministic output for tests/repro. */
  readonly now?: string;
}

export interface BundleResult {
  readonly ok: true;
  readonly dir: string;
  readonly files: readonly string[];
  readonly manifest: IntegrityManifest;
}

export interface BundleContents {
  readonly profile: ForgeProfile | null;
  readonly lockfile: EnvLock | null;
  readonly lockCheck: readonly LockCheck[];
  readonly envKeys: Record<string, readonly string[]>;
  readonly envValues: Record<string, Record<string, string>>;
  readonly pins: readonly BundlePin[];
  readonly manifest: IntegrityManifest | null;
}

export interface ImportedBundle extends BundleContents {
  readonly dir: string;
  readonly verify: IntegrityVerification;
}

function writeJson(dest: string, doc: unknown): ManifestInput {
  const content = JSON.stringify(doc, null, 2);
  writeFileAtomic(dest, content);
  return { path: path.basename(dest), content };
}

/** version from manifests: forge.json → package.json → pyproject.toml. */
function pinVersion(repoDir: string): string | undefined {
  for (const file of ['forge.json', 'package.json']) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(repoDir, file), 'utf8'));
      const v = (parsed as { version?: unknown })?.version;
      if (typeof v === 'string' && v) return v;
    } catch {
      /* absent or malformed — try the next source */
    }
  }
  try {
    const pyproject = readFileSync(path.join(repoDir, 'pyproject.toml'), 'utf8');
    const m = /^version\s*=\s*"([^"]+)"/m.exec(pyproject);
    if (m) return m[1];
  } catch {
    /* no pyproject */
  }
  return undefined;
}

function collectPins(targetDir: string, repos: readonly ForgeRepo[]): BundlePin[] {
  const state = loadState(targetDir);
  const pins = new Map<string, BundlePin>();
  for (const repo of repos) {
    const repoDir = path.join(targetDir, repo.name);
    const version = existsSync(repoDir) ? pinVersion(repoDir) : undefined;
    const head = state?.repos[repo.name]?.head;
    const ref = state?.pins?.[repo.name] ?? head;
    pins.set(repo.name, {
      name: repo.name,
      url: repo.url,
      kind: repo.kind,
      ...(version ? { version } : {}),
      ...(ref ? { ref } : {}),
      ...(head ? { head } : {}),
    });
  }
  for (const [name, ref] of Object.entries(state?.pins ?? {})) {
    if (!pins.has(name)) pins.set(name, { name, ref });
  }
  return [...pins.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function exportBundle(
  targetDir: string,
  repos: readonly ForgeRepo[],
  dest: string,
  opts?: ExportBundleOptions,
): Promise<BundleResult> {
  const now = opts?.now ?? new Date().toISOString();
  const whitelist = [...(opts?.includeEnvKeys ?? [])].sort();

  // Fail closed BEFORE any file is written: a whitelisted key matching the
  // denylist, or marked secret by the derived schema, refuses the export.
  const refused = new Set<string>();
  for (const key of whitelist) {
    if (SECRET_DENYLIST.test(key)) refused.add(key);
  }
  const schemaByRepo = new Map<string, ReturnType<typeof deriveSchema>>();
  for (const repo of repos) {
    const repoDir = path.join(targetDir, repo.name);
    const schema = existsSync(repoDir) ? deriveSchema(repoDir, repo.envKeys) : { vars: [] };
    schemaByRepo.set(repo.name, schema);
    for (const v of schema.vars) {
      if (v.secret && whitelist.includes(v.key)) refused.add(v.key);
    }
  }
  if (refused.size) throw new SecretKeysRefusedError([...refused]);

  mkdirSync(dest, { recursive: true });
  const inputs: ManifestInput[] = [];

  // Envelope first — the file list is fixed, so it is known before writing.
  const produced = [
    BUNDLE_FILES.envelope,
    BUNDLE_FILES.profile,
    BUNDLE_FILES.lock,
    BUNDLE_FILES.lockCheck,
    BUNDLE_FILES.envKeys,
    ...(whitelist.length ? [BUNDLE_FILES.envValues] : []),
    BUNDLE_FILES.pins,
    BUNDLE_FILES.integrity,
  ].sort();
  inputs.push(
    writeJson(path.join(dest, BUNDLE_FILES.envelope), {
      schema: BUNDLE_SCHEMA,
      generatedAt: now,
      files: produced,
    }),
  );

  const profile = { ...exportProfile(targetDir, path.join(dest, BUNDLE_FILES.profile)) };
  const normalizedProfile = { ...profile, exported_at: now };
  inputs.push(writeJson(path.join(dest, BUNDLE_FILES.profile), normalizedProfile));

  const lock: EnvLock = { ...writeEnvLock(targetDir, repos), generated_at: now };
  inputs.push(writeJson(path.join(dest, BUNDLE_FILES.lock), lock));
  inputs.push(writeJson(path.join(dest, BUNDLE_FILES.lockCheck), checkEnvLock(targetDir, repos)));

  const envKeys: Record<string, readonly string[]> = {};
  for (const repo of repos) {
    const keys = [...new Set((schemaByRepo.get(repo.name)?.vars ?? []).map((v) => v.key))].sort();
    envKeys[repo.name] = keys;
  }
  inputs.push(writeJson(path.join(dest, BUNDLE_FILES.envKeys), envKeys));

  if (whitelist.length) {
    const values: Record<string, Record<string, string>> = {};
    for (const repo of repos) {
      const envFile = path.join(targetDir, repo.name, '.env');
      if (!existsSync(envFile)) continue;
      const entries = parseEnv(readFileSync(envFile, 'utf8')).entries;
      const found: Record<string, string> = {};
      for (const key of whitelist) {
        const entry = entries.find((e) => e.key === key);
        if (entry) found[key] = entry.value;
      }
      if (Object.keys(found).length) values[repo.name] = found;
    }
    inputs.push(writeJson(path.join(dest, BUNDLE_FILES.envValues), values));
  }

  inputs.push(writeJson(path.join(dest, BUNDLE_FILES.pins), collectPins(targetDir, repos)));

  const manifest = buildIntegrityManifest(inputs, { now });
  inputs.push(writeJson(path.join(dest, BUNDLE_FILES.integrity), manifest));

  return { ok: true, dir: dest, files: produced, manifest };
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readLockfile(file: string): EnvLock | null {
  const parsed = readJsonFile(file) as EnvLock | null;
  return parsed?.schema === 'forge-cli/EnvLock/v1' && typeof parsed.forges === 'object'
    ? parsed
    : null;
}

function readLockCheck(file: string): readonly LockCheck[] {
  const parsed = readJsonFile(file);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (c): c is LockCheck =>
      c !== null &&
      typeof c === 'object' &&
      typeof (c as LockCheck).forge === 'string' &&
      ['match', 'drifted', 'untracked', 'absent'].includes((c as LockCheck).state),
  );
}

function readStringMap(file: string): Record<string, readonly string[]> {
  const parsed = readJsonFile(file);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, readonly string[]> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(v) && v.every((s) => typeof s === 'string')) out[k] = v as string[];
  }
  return out;
}

function readValueMap(file: string): Record<string, Record<string, string>> {
  const parsed = readJsonFile(file);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const inner: Record<string, string> = {};
    for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
      if (typeof iv === 'string') inner[ik] = iv;
    }
    out[k] = inner;
  }
  return out;
}

function readPins(file: string): readonly BundlePin[] {
  const parsed = readJsonFile(file);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (p): p is BundlePin =>
        p !== null && typeof p === 'object' && typeof (p as BundlePin).name === 'string',
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read a bundle directory and verify its integrity manifest against the real
 * on-disk bytes. Malformed payloads parse to null/empty — verification still
 * reports them; nothing here throws on a hostile or partial bundle.
 * `opts.verifyIntegrity === false` skips verification (forensics/inspection).
 */
export function importBundle(src: string, opts?: { verifyIntegrity?: boolean }): ImportedBundle {
  const read = (p: string): Uint8Array | null => {
    try {
      return readFileSync(path.join(src, p));
    } catch {
      return null;
    }
  };
  const manifestRaw = readJsonFile(path.join(src, BUNDLE_FILES.integrity));
  const manifest =
    manifestRaw &&
    typeof manifestRaw === 'object' &&
    (manifestRaw as IntegrityManifest).schema === 'forge/IntegrityManifest/v1'
      ? (manifestRaw as IntegrityManifest)
      : null;
  const verify =
    opts?.verifyIntegrity === false
      ? { ok: true as const }
      : verifyIntegrityManifest(manifest, read);

  const profile = importProfile(path.join(src, BUNDLE_FILES.profile));
  return {
    dir: src,
    verify,
    manifest,
    profile: 'error' in profile ? null : profile,
    lockfile: readLockfile(path.join(src, BUNDLE_FILES.lock)),
    lockCheck: readLockCheck(path.join(src, BUNDLE_FILES.lockCheck)),
    envKeys: readStringMap(path.join(src, BUNDLE_FILES.envKeys)),
    envValues: readValueMap(path.join(src, BUNDLE_FILES.envValues)),
    pins: readPins(path.join(src, BUNDLE_FILES.pins)),
  };
}

/**
 * Map bundle pins to a deterministic reinstall plan (forge/ForgeOperationPlan/v1).
 * Each pinned forja becomes: clone → checkout ref → env-key provisioning note.
 * `opts.targetDir` makes target_dir absolute; the default keeps it relative
 * to whatever workspace the plan is approved against.
 */
export function planReinstall(
  bundle: BundleContents,
  opts?: { now?: Date; targetDir?: string },
): OperationPlan {
  const forges: PlanForge[] = [...bundle.pins]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((pin) => {
      const targetDir = opts?.targetDir ? path.join(opts.targetDir, pin.name) : pin.name;
      const actions: PlanAction[] = [];
      if (pin.url) {
        actions.push({
          kind: 'clone',
          label: `clone ${pin.name}`,
          argv: ['git', 'clone', pin.url, pin.name],
          paths: [pin.name],
          reversible: true,
        });
      } else {
        actions.push({
          kind: 'config',
          label: `resolve repository for ${pin.name} — bundle records no url`,
          reversible: false,
        });
      }
      const ref = pin.ref ?? pin.head;
      if (ref) {
        actions.push({
          kind: 'sync',
          label: `checkout pinned ref ${ref}`,
          argv: ['git', '-C', pin.name, 'checkout', ref],
          paths: [pin.name],
          reversible: true,
        });
      }
      const keys = bundle.envKeys[pin.name] ?? [];
      if (keys.length) {
        actions.push({
          kind: 'env',
          label: `provision env keys: ${[...keys].sort().join(', ')}`,
          paths: [path.join(pin.name, '.env')],
          reversible: true,
        });
      }
      return { forge_id: pin.name, repo: pin.url ?? pin.name, target_dir: targetDir, actions };
    });
  return buildPlan({ forges, source: 'cli', now: opts?.now });
}
