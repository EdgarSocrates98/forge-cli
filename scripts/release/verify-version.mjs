#!/usr/bin/env node
/**
 * Release gate — valida que a versão pedida é publicável, sem mutar nada.
 *   node scripts/release/verify-version.mjs <version> [--tag vX.Y.Z] [--expect-sha <sha>]
 *
 * Recusas nomeadas (exit 2):
 *  - version-invalid: input fora do SemVer estrito (semver.org, sem leading zeros)
 *  - version-mismatch: package.json.version ≠ input
 *  - lock-missing / lock-mismatch: package-lock ausente ou version divergente
 *  - repo-url / license-missing / files-empty: metadata suja
 *  - tag-missing / tag-mismatch: tag declarada inexistente ou fora de HEAD
 *  - sha-mismatch: HEAD ≠ --expect-sha (re-check anti-TOCTOU no job publish)
 *  - version-exists: versão já publicada (idempotência: nunca sobrescreve)
 * Saída JSON em stdout para o workflow.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = process.argv[2];
const flagValue = (flag) => {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  // `--tag` sem valor (ou seguido de outra flag) conta como ausente.
  return v && !v.startsWith('--') ? v : null;
};
const tagArg = flagValue('--tag');
const expectSha = flagValue('--expect-sha');
const fail = (code, detail) => {
  process.stdout.write(`${JSON.stringify({ ok: false, code, detail })}\n`);
  process.exit(2);
};

// SemVer estrito (semver.org): sem leading zeros, pre-release/build opcionais.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
if (!version || !SEMVER.test(version)) {
  fail('version-invalid', `formato inválido (SemVer estrito): ${version}`);
}
const head = () => execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) {
  fail('version-mismatch', `package.json=${pkg.version} input=${version}`);
}
// package-lock deve acompanhar o bump — lock divergente = release inconsistente.
const lockPath = path.join(root, 'package-lock.json');
if (!existsSync(lockPath)) fail('lock-missing', 'package-lock.json ausente');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const lockRoot = lock.packages?.['']?.version;
if (lock.version !== version || lockRoot !== version) {
  fail('lock-mismatch', `package-lock version=${lock.version} root=${lockRoot} ≠ ${version}`);
}
if (!pkg.repository?.url?.includes('github.com'))
  fail('repo-url', 'repository.url ausente/inválida');
if (!pkg.license) fail('license-missing', 'license ausente');
if (!pkg.files?.length) fail('files-empty', 'files[] vazio — pacote sem conteúdo');

// tag opcional declarada deve existir e apontar para HEAD
if (tagArg) {
  const expected = tagArg === version ? `v${version}` : tagArg;
  let tagSha = null;
  try {
    tagSha = execSync(`git rev-list -n 1 ${expected}`, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    fail('tag-missing', `tag ${expected} inexistente`);
  }
  const h = head();
  if (tagSha !== h) fail('tag-mismatch', `${expected}→${tagSha} HEAD=${h}`);
}

// SHA binding: o job publish re-executa o gate no checkout pinado — se o
// HEAD resolvido divergir do SHA validado, algo trocou o ref entre os jobs.
if (expectSha) {
  if (!/^[0-9a-f]{40}$/.test(expectSha)) fail('sha-invalid', `--expect-sha: ${expectSha}`);
  const h = head();
  if (h !== expectSha) fail('sha-mismatch', `HEAD=${h} ≠ validado=${expectSha}`);
}

// versão já publicada? 404 = disponível (ok); 200 = recusa
let status = 0;
try {
  const out = execSync(
    `npm view ${pkg.name}@${version} version --registry https://registry.npmjs.org`,
    {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim();
  status = out ? 200 : 0;
} catch {
  status = 404; // npm view sai != 0 quando a versão não existe
}
if (status === 200) fail('version-exists', `${pkg.name}@${version} já publicada`);

process.stdout.write(`${JSON.stringify({ ok: true, name: pkg.name, version, sha: head() })}\n`);
