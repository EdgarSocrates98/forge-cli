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
  → validate: quality gates + npm pack --dry-run + verify-version.mjs
       (mismatch / tag-mismatch / version-exists / metadata suja ⇒ recusa)
  → publish (environment: npm, id-token: write)
       checkout no MESMO sha validado (sem TOCTOU)
       npm publish --provenance --access public
       post-publish: registry check + attestations + install limpo + --help
```

## Gates implementados

- Versão input × `package.json` × tag (opcional) — `scripts/release/verify-version.mjs`.
- Idempotência: `npm view` recusa versão já existente (nunca sobrescreve).
- npm CLI ≥ 11.5.1 (necessário p/ OIDC auto-detectado) — verificado no job.
- Actions pinadas em SHA de 40 chars; `contents: read` default; cache off.
- Concorrência `npm-release-<version>` — sem publish paralelo da mesma versão.
- Job validate roda gates completos (typecheck, lint, format, tests, build, pack).
- Post-publish smoke: instala o pacote do registry e executa `--help`.

## Troubleshooting

| Sintoma                | Causa provável                                          |
| ---------------------- | ------------------------------------------------------- |
| `version-mismatch`     | input ≠ `package.json.version` — bump primeiro          |
| `version-exists`       | versão já publicada — bump e re-dispara                 |
| OIDC `403` do npm      | trusted publisher não registrado ou env name divergente |
| Job publish não inicia | approval do environment pendente                        |

## Recovery

Publicação nunca sobrescreve: para corrigir uma versão ruim, publique
`x.y.(z+1)` com o fix e deprecie a ruim (`npm deprecate`, ação manual).
