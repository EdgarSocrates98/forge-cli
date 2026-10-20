# Códigos `FORGE-*` — taxonomia de recusa (ciclo 12.1)

Toda recusa nomeada sai com código estável + causa + remédio acionável,
no texto do erro e no `--json` (`results[].code`/`cause`/`remedy`).
Contrato de exit code: `2` = recusa nomeada (nada foi escrito),
`1` = falha operacional (script/setup quebrou depois de autorizado —
sem código inventado), `0` = ok. O mesmo código significa a mesma coisa
em POSIX e Windows; os remédios abaixo cobrem os dois.

## Códigos do CLI (`src/errors.ts`)

| Código                              | Causa                                                                                                                                                                                              | Remédio                                                                                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FORGE-SOURCE-NOT-FOUND`            | Caminho inexistente, não é diretório ou não tem nenhum marcador de Forja (sem `.git` e sem `forge.json`); também: update/repair/uninstall sem receipt registrado, ou `source_dir` registrado sumiu | Verifique o caminho; instale pelo catálogo (`install <nome>`/`--method registry`); se a fonte registrada foi movida, `uninstall <nome>` limpa o registro                                                     |
| `FORGE-SOURCE-GITLESS`              | A operação exige git (`--method git`, `update <nome>` por nome, `clone`) mas a fonte não tem `.git`; ou fonte parcial instalada sem confirmação                                                    | Remova `--method git`, passe o diretório ao `update` (`update <dir-novo>`) ou confirme fonte parcial com `--yes`                                                                                             |
| `FORGE-SOURCE-INVALID`              | `forge.json` malformado/ausente na rota local, sem script executável e sem fallback `scripts/forge_bootstrap.py`, fonte não confiável (symlink/junction), ou ação registry-only num receipt local  | Corrija `forge.json` (JSON válido + `forge_id`), forneça `install.sh`/`setup.sh`/`install.windows.sh` ou aponte o diretório real; para receipt local use a rota sem `--method`                               |
| `FORGE-SOURCE-CONFLICT`             | Identidade contraditória: nome do diretório/cli aponta uma Forja do catálogo diferente do `forge_id` declarado; ou receipt PyPI pré-existente para o mesmo `forge_id`                              | Corrija `forge.json` ou aponte o diretório certo; para reinstalar por fonte local uma Forja do PyPI, `uninstall --method registry <nome>` primeiro                                                           |
| `FORGE-INSTALL-VERIFICATION-FAILED` | Bootstrap executou mas o verify pós-install (`<cli> --help`) saiu não-zero — instalação registrada, entrada quebrada                                                                               | Rode o cli manualmente dentro da fonte para ver o erro; o receipt já está gravado para diagnóstico                                                                                                           |
| `FORGE-SHELL-NOT-FOUND`             | Windows sem nenhuma shell de instalação utilizável: `powershell.exe`/`pwsh` ausentes e Git Bash inexistente                                                                                        | Instale PowerShell 7+ (`winget install Microsoft.PowerShell`), habilite o `powershell.exe` 5.1 ou instale Git for Windows (o Git Bash vira a rota de `install.windows.sh`). WSL nunca substitui shell nativo |
| `FORGE-SHELL-UNAVAILABLE`           | Shell candidata existe no disco mas não executa (política/AppLocker/WDAC bloqueando ou instalação quebrada)                                                                                        | Verifique `Get-ExecutionPolicy` e a política corporativa, ou reinstale PowerShell 7+/Git for Windows                                                                                                         |
| `FORGE-INSTALL-PERMISSION-DENIED`   | Alvo de escrita resolvido nega permissão (home, bin, venvs, receipts…)                                                                                                                             | Rode `forge-cli env paths` para ver a matriz de alvos e o fallback concreto; ajuste permissões ou aponte outro diretório                                                                                     |
| `FORGE-ENV-PERSISTENCE-FAILED`      | Provisionamento de ambiente falhou na escrita (`.env`/configs de exemplo) — diretório da fonte ou alvo sem permissão de escrita                                                                    | Dê permissão de escrita no diretório da fonte e reexecute; o instalador grava `.env` e copia `*.example.*` antes do bootstrap                                                                                |
| `FORGE-PYTHON-NOT-FOUND`            | Pipeline não achou nenhum interpretador (ou só aliases da Microsoft Store, que não executam)                                                                                                       | Instale Python ≥3.10 ou aponte explicitamente com `--python <exe>`/`FORGE_PYTHON`                                                                                                                            |
| `FORGE-PYTHON-INCOMPATIBLE`         | Candidatos executaram mas todos abaixo do piso (`requires_python` do release ou `python` do `forge.json` — piso padrão ≥3.10)                                                                      | Aponte um interpretador compatível com `--python`/`FORGE_PYTHON`                                                                                                                                             |
| `FORGE-PYTHON-UNEXECUTABLE`         | Candidato existe mas `--version` falha, expira ou não parseia (stub da Store, exe quebrado, shim morto)                                                                                            | Teste `<exe> --version` manualmente; aponte outro interpretador com `--python`/`FORGE_PYTHON`                                                                                                                |

## Códigos do instalador compartilhado (`scripts/forge_bootstrap.py` + `install.windows.sh`)

Emitidos pela camada Python/bash vendored nas Forjas — mesma
convenção: código no stderr/JSON e remédio explícito.

| Código                              | Causa                                                                                | Remédio                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `FORGE-INSTALL-NO-CONFIG`           | `forge.json` ausente no diretório onde o bootstrap rodou                             | Rode dentro de um checkout/fonte de Forja com `forge.json`             |
| `FORGE-INSTALL-BAD-CONFIG`          | `forge.json` inválido ou faltando chaves                                             | Corrija o manifesto                                                    |
| `FORGE-INSTALL-DIST-INVALID`        | `--dist` fora da whitelist do instalador                                             | Use a distribuição publicada da Forja                                  |
| `FORGE-INSTALL-DIST-URL`            | `--dist-url` fora do esquema/host permitido                                          | Aponte uma URL `https://` autorizada                                   |
| `FORGE-INSTALL-DIST-MISMATCH`       | Dist/url divergem do esperado pelo manifesto                                         | Alinhe dist e url com a Forja instalada                                |
| `FORGE-INSTALL-MODE-CONFLICT`       | Combinação inválida de flags de modo                                                 | Rode com um modo só (`--help` lista)                                   |
| `FORGE-INSTALL-PYTHON-INCOMPATIBLE` | Interpretador abaixo do `requires-python` da Forja                                   | Aponte Python compatível na flag/`FORGE_PYTHON`                        |
| `FORGE-INSTALL-VENV-FAILED`         | `python -m venv` falhou ou a venv ficou incompleta                                   | Verifique `python3-venv`/`ensurepip` instalados e permissão de escrita |
| `FORGE-INSTALL-RUNTIME-FAILED`      | Falha de runtime do bootstrap (pip/wheel interno)                                    | Veja o log impresso; rede offline exige wheelhouse                     |
| `FORGE-INSTALL-CLI-MISSING`         | Binário `<cli>` ausente no `bin/` da venv após o install                             | Reinstale; entry-point do pacote quebrado                              |
| `FORGE-INSTALL-VERIFY-FAILED`       | Smoke pós-install falhou (equivalente ao `FORGE-INSTALL-VERIFICATION-FAILED` do CLI) | Rode o binário da venv manualmente                                     |
| `FORGE-INSTALL-BOOTSTRAP-FAILED`    | `install.windows.sh` repassou falha não-zero do bootstrap                            | Veja o log `forge-install-*.log` ao lado da fonte                      |
| `FORGE-ENV-PERSISTENCE-FAILED`      | `--persist-env` não conseguiu gravar PATH/perfil do usuário                          | Ajuste permissões do perfil ou rode sem `--persist-env`                |

## Recusas de pipeline sem script

Quando a fonte não tem script executável **e** o fallback
`forge_bootstrap.py` falhou por descoberta de Python, o código
`FORGE-PYTHON-*` da descoberta é propagado no lugar de
`FORGE-SOURCE-INVALID` — a causa real é o interpretador, não a fonte.

## Diagnóstico rápido

```bash
forge env discover --json   # shells, rota escolhida, pythons sondados
forge env paths             # alvos de escrita + fallbacks
forge doctor --json         # checks por domínio (fontes locais incl.)
forge status --json         # estado por Forja (receipts locais incl.)
```
