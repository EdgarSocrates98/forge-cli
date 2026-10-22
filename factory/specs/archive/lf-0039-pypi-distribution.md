# lf-0039 — Install 2.0 Cycle 6: PyPI first-class distribution

## Contexto
Spec-fonte: `prompt_evo_install2.0.md` §8. **Bloqueador de release.**
Depende de lf-0034/0035/0036/0037/0038 (o wheel precisa conter tudo dos ciclos anteriores).
Sentinel (`data-sentinel-forge`) é referência madura: `test_wheel.py` constrói wheel
em tmp dir quando `dist/` ausente, `MANIFEST.sha256` verificado por
`verify_integrity`, smoke Windows corrigido com `_configure_stdio`.

## Entregáveis (por forge)
1. Auditoria de configuração §8.1: `pyproject.toml`, backend, package discovery,
   `package_data`, inclusão de recursos, sdist, wheel, metadata, entry points,
   extras MCP, versões mínimas Python, deps entre pacotes.
2. Recursos distribuídos §8.2 — o wheel/sdist DEVE incluir: skills, agents,
   templates, schemas, protocols, rules, knowledge (ou índice), manifests,
   índices, arquivos dos verificadores, recursos do runtime, assets do instalador.
   NÃO incluir: históricos, logs, segredos, caches, temp, benchmarks enormes,
   holdouts internos, arquivos de dev. Dev-evals podem ficar por extras quando
   justificado.
3. Resource Resolver §8.3: `importlib.resources` quando aplicável; não assumir
   arquivo físico de checkout; materialização segura quando preciso caminho real
   (tmpdir controlado, permissões, cleanup). Validar: Linux, Windows, caminhos
   com espaços, venvs, escopo usuário, diretórios read-only, fora da raiz,
   múltiplas versões.
4. Wheel Isolation Test §8.4 AUTOMATIZADO por forge (padrão do
   `tests/integration/test_wheel.py` do sentinel): build wheel → venv limpa →
   install wheel → checkout fora do PATH → `forge install` → verifica
   registry/contratos → retrieve knowledge → retrieve rule → verify protocol →
   offline verification → uninstall/repair/reinstall.
5. Paridade de distribuição §8.5: matriz Checkout | Wheel local | PyPI publicado
   × {CLI, Skills, Agents, MCP, Knowledge, Rules, Protocols, Evals, Install,
   Repair, Uninstall} — última coluna = versão real publicada, não a nova.
   Doc `docs/install/DISTRIBUTION_PARITY.md` por repo.
6. Publicação §8.6: preservar mecanismo aprovado (OIDC trusted publishing),
   sem tokens persistentes; não publicar com wheel incompleto/manifest inválido/
   dependência de checkout/retrieval quebrado/testes críticos falhando/registry
   migration inseguro.

## Verificação
- Wheel isolation test passa por forge em CI (e localmente).
- Matriz de paridade com evidência real (PyPI = versão live hoje).
- `twine check` nos dists; wheel contém os recursos exigidos.

## Boundary
Branches `cycle/install-context` + PR por repo. Não toca cli/portal/lens.
