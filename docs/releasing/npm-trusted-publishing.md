# npm Trusted Publishing — `theforge-cli`

Publicação oficial do pacote via GitHub Actions + npm **Trusted Publishing
(OIDC)**. **Nenhum token persistente** é armazenado no repositório.

## Setup (uma vez, fora do código — ação do mantenedor)

1. npmjs.com → conta → pacote `theforge-cli` → _Settings → Trusted Publishing_:
   - Provider: **GitHub Actions**
   - Owner: `EdgarSocrates98` · Repository: `forge-cli`
   - Workflow: `publish-npm.yml`
   - Environment: `npm`
2. GitHub → Settings → Environments → **`npm`**:
   - _Required reviewers_: mantenedor (aprovação humana é o gate).
3. O job de publish só roda com `environment: npm` — sem a aprovação, nada
   publica.

## Fluxo

```
workflow_dispatch(version, tag?)
  → validate (só na main — github.ref_name != main ⇒ falha)
       quality gates + verify-version.mjs
       (SemVer estrito / mismatch / lock-mismatch / tag-mismatch /
        version-exists / metadata suja ⇒ recusa nomeada)
       npm pack → upload-artifact "npm-tarball" (artefato imutável)
  → publish (environment: npm, id-token: write)
       checkout no MESMO sha validado + verify-version --expect-sha (re-check)
       download-artifact "npm-tarball" → gate: exatamente 1 .tgz da versão
       npm publish theforge-cli-<version>.tgz --provenance --access public
       post-publish: registry check + attestations (hard-fail) +
         integrity registry==local + install limpo + --help
```

## Binding validate → publish (por que tarball, não rebuild)

O job `publish` **nunca rebuilda** o pacote: o `npm pack` roda uma única vez,
no `validate`, sobre o build já aprovado pelos gates, e o tarball sobe como
artefato imutável (`upload-artifact`, retenção 1 dia — só precisa viver até o
publish). O `publish` baixa exatamente esse arquivo e publica o `.tgz`
diretamente (`npm publish theforge-cli-<version>.tgz --provenance`).

Motivos:

- **TOCTOU de conteúdo**: um rebuild no job publish poderia produzir bytes
  diferentes do que foi verificado (inputs não-determinísticos, supply chain
  entre os dois `npm ci`). O tarball validado é o tarball publicado — byte a
  byte, provado no pós-publish comparando `dist.integrity` do registry com o
  sha512 local do arquivo.
- **TOCTOU de ref**: além do checkout pinado em
  `ref: needs.validate.outputs.sha`, o publish re-executa
  `verify-version.mjs --expect-sha` — se o HEAD resolvido divergir do SHA
  validado, o job falha antes de publicar.
- **Artifact gate**: exatamente um `.tgz` no artefato e com o nome
  `theforge-cli-<version>.tgz` — um artefato trocado/errado aborta.

## Gates implementados

- Inputs chegam aos steps via `env` (`RELEASE_VERSION`/`RELEASE_TAG`) — nenhuma
  interpolação `${{ inputs.* }}` inline em `run:`.
- Branch: dispatch fora da `main` (`github.ref_name`) falha no primeiro step.
- Versão input × SemVer estrito × `package.json` × `package-lock.json`
  (ambos `version` e `packages[""].version`) × tag (opcional) —
  `scripts/release/verify-version.mjs`.
- SHA binding: `verify-version.mjs --expect-sha` revalida o HEAD no publish.
- Idempotência: `npm view` recusa versão já existente (nunca sobrescreve).
- npm CLI ≥ 11.5.1 (necessário p/ OIDC auto-detectado) — verificado no job.
- Actions pinadas em SHA de 40 chars; `contents: read` default; cache off.
- Concorrência `npm-release-<version>` — sem publish paralelo da mesma versão.
- Job validate roda gates completos (typecheck, lint, format, tests, build, pack).
- Attestation (provenance) é obrigatória: `dist.attestations` vazio/ausente
  falha o workflow — nunca `|| echo` mascarando.
- Integrity: `dist.integrity` do registry == sha512 (formato ssri) do tarball.
- Post-publish smoke: instala o pacote do registry e executa `--help`.

## Troubleshooting

| Sintoma                | Causa provável                                          |
| ---------------------- | ------------------------------------------------------- |
| `version-invalid`      | input fora do SemVer estrito (ex.: `01.2.3`, `1.2`)     |
| `version-mismatch`     | input ≠ `package.json.version` — bump primeiro          |
| `lock-mismatch`        | `package-lock.json` não acompanhou o bump de versão     |
| `tag-missing`          | tag declarada não existe no repo                        |
| `sha-mismatch`         | HEAD do publish ≠ SHA validado — ref trocou entre jobs  |
| `version-exists`       | versão já publicada — bump e re-dispara                 |
| Branch gate falha      | dispatch foi disparado fora da `main`                   |
| Artifact gate falha    | tarball ausente, duplicado ou com nome divergente       |
| OIDC `403` do npm      | trusted publisher não registrado ou env name divergente |
| Attestation vazia      | provenance não registrada — publish é recusado          |
| Integrity diverge      | registry servindo bytes ≠ tarball validado — incidente  |
| Job publish não inicia | approval do environment pendente                        |

## Recovery

Publicação nunca sobrescreve: para corrigir uma versão ruim, publique
`x.y.(z+1)` com o fix e deprecie a ruim (`npm deprecate`, ação manual).
