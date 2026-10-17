#!/usr/bin/env node
/**
 * Release gate — valida que a versão pedida é publicável, sem mutar nada.
 *   node scripts/release/verify-version.mjs <version> [--tag vX.Y.Z]
 *
 * Recusas nomeadas (exit 2):
 *  - mismatch package.json × input
 *  - versão já existe no npm (idempotência: nunca sobrescreve)
 *  - tag declarada não aponta para HEAD aprovado (--tag fornecido)
 *  - metadata suja: repository.url ausente, license ausente
 * Saída JSON em stdout para o workflow.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = process.argv[2];
const tagIdx = process.argv.indexOf('--tag');
const tagArg = tagIdx >= 0 ? process.argv[tagIdx + 1] || null : null;
const fail = (code, detail) => {
  process.stdout.write(`${JSON.stringify({ ok: false, code, detail })}\n`);
  process.exit(2);
};

if (!version || !/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/.test(version)) {
  fail('version-invalid', `formato inválido: ${version}`);
}
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) {
  fail('version-mismatch', `package.json=${pkg.version} input=${version}`);
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
  const head = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  if (tagSha !== head) fail('tag-mismatch', `${expected}→${tagSha} HEAD=${head}`);
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

process.stdout.write(
  `${JSON.stringify({ ok: true, name: pkg.name, version, sha: execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim() })}\n`,
);
