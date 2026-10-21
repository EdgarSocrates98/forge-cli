# Guia de instalação por cenário

Ciclo 12.1 (`lf-0015`–`lf-0019`). O objetivo é que a instalação de uma
Forja **não dependa de um único método de aquisição**: PyPI, clone git,
ZIP do GitHub, pasta copiada ou diretório sem `.git` são entradas
válidas quando existe um método local compatível, funcional e
autorizado. A ausência de `.git`, de PowerShell ou de um Python no PATH
nunca bloqueia isoladamente a instalação.

Toda recusa sai com código `FORGE-*`, causa e remédio — veja a tabela
completa em [troubleshooting.md](troubleshooting.md). `forge doctor`
diagnostica a instalação depois do fato; `forge env discover --json`
mostra as rotas/shells/interpretadores que a máquina oferece **antes**
de instalar.

## Sumário dos cenários

| #   | Cenário                         | Comando                                                 | Rota                                                |
| --- | ------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| 1   | PyPI (recomendado)              | `forge-cli install <forja> --method registry`           | venv isolada em `~/.forge-cli/forges/`              |
| 2   | Clone git                       | `forge-cli install <forja>`                             | clone + `install.sh`/`install.ps1`                  |
| 3   | ZIP do GitHub                   | `forge-cli install ./forja-1.2.3`                       | detecção local + bootstrap no lugar                 |
| 4   | Pasta copiada                   | `forge-cli install ./cópia`                             | idem — gitless é cidadão de 1ª classe               |
| 5   | Diretório sem `.git`            | `forge-cli install ./dir`                               | idem                                                |
| 6   | Windows + PowerShell            | `forge-cli install <forja>`                             | `install.ps1`/`setup.ps1` via powershell.exe → pwsh |
| 7   | Windows sem PowerShell          | `forge-cli install <forja>` no Git Bash                 | `install.windows.sh` via Git Bash                   |
| 8   | Python corporativo fora do PATH | `forge-cli install <alvo> --python C:\corp\python.exe`  | estágio explícito do pipeline                       |
| 9   | Vários Pythons (Linux)          | `forge-cli install <alvo>` ou `--python`/`FORGE_PYTHON` | descoberta escolhe o mais novo compatível           |
| 10  | Rede/permissão restrita         | `forge-cli install <forja> --method registry --offline` | wheelhouse/cache local; sem admin                   |

## 1. PyPI — `install --method registry`

```bash
forge-cli install api-forge --method registry
forge-cli install --all --method registry
forge-cli registry                      # catálogo + o que está instalado
```

Cada Forja vai para `~/.forge-cli/forges/<nome>/` com
`pip install <dist>==<versão>` pinado; o interpretador é o mais novo
que satisfaz `requires_python`. Sem compatível, a instalação é recusada
(`FORGE-PYTHON-INCOMPATIBLE`) antes de qualquer mutação.

## 2. Clone git — `install <nome>`

```bash
forge-cli install api-forge platform-forge
forge-cli install            # TUI guiada
forge-cli install api-forge --version 1.2.0   # pin em tag/sha
```

Clona no workspace (`--dir`, padrão `./forge-workspace`), provisiona
`.env` e roda o script do SO. Requer `git` no PATH e credenciais.

## 3–5. Fonte local — `install <dir>` (ZIP, cópia, sem `.git`)

```bash
forge-cli install ./spark-forge-aws-main     # ZIP extraído do GitHub
forge-cli install ~/minhas/forjas/api-forge  # pasta copiada / sem .git
forge-cli install ./fonte --plan             # só classifica, zero escrita
```

O diretório é classificado por `forge/LocalForgeSourceDetection/v1` em
oito estados (`GIT_REPOSITORY`, `GIT_WORKTREE`, `GITLESS_VALID_FORGE`,
`GITLESS_PARTIAL_FORGE`, `UNKNOWN_DIRECTORY`, `CONFLICTING_IDENTITY`,
`INVALID_MANIFEST`, `UNTRUSTED_SOURCE`) — detecção só por filesystem,
sem spawn de git e sem rede. Fontes parciais (estrutura incompleta)
exigem `--yes`. O bootstrap roda **no lugar**: nunca `git init`,
`clone`, `pull` ou rede.

O receipt registra `source_dir`, `is_git`, `manifest_valid`,
`source_trust` (A/B/C), `integrity`, `execution_environment`,
`managed_artifacts` e `source_files` — `forge status` e `forge doctor`
reconhecem a instalação gitless normalmente.

Persistência de ambiente: um `.env` existente na fonte **nunca** é
sobrescrito — `.env.example` só é copiado quando `.env` está ausente
(e um stub comentado é criado quando nem o exemplo existe). Exemplos
de config (`*.example.*`) só são copiados quando o destino não existe;
`.env.example` em si nunca é copiado pela regra genérica. Falha de
escrita nessa etapa é recusa nomeada `FORGE-ENV-PERSISTENCE-FAILED`,
antes de qualquer bootstrap.

## 6. Windows + PowerShell

Ordem de rota no Windows: `powershell.exe` (5.1) → `pwsh` (7+) → Git
Bash. Com PowerShell presente a cadeia é `.ps1`
(`setup.ps1`/`install.ps1`); a política de execução é contornada por
`-ExecutionPolicy Bypass` no escopo do processo.

## 7. Windows sem PowerShell — rota Git Bash

Quando `powershell.exe`/`pwsh` estão ausentes ou bloqueados e o Git
Bash executa, a rota é `.sh` com `install.windows.sh` primeiro
(seguido de `setup.sh`/`install.sh`). O bash.exe precisa ser o do **Git
for Windows** e responder a `-lc 'echo ok'` — WSL, Cygwin e MSYS2 são
reportados pela descoberta mas **nunca** são rota nativa.

```bash
# dentro do Git Bash
bash install.windows.sh            # instalador direto da Forja
forge-cli env discover --json      # route.selected deve ser "git_bash"
```

Cenário coberto em CI como simulação (PATH mascarado no runner
Windows) — o gate de hardware corporativo real é ação humana
documentada no acceptance report.

## 8. Python corporativo fora do PATH — `--python` / `FORGE_PYTHON`

```bash
forge-cli install ./api-forge --python "C:\Python311\python.exe"
FORGE_PYTHON=/opt/python311/bin/python forge-cli install api-forge
```

`FORGE_PYTHON` (estágio 0) precede até `--python` (estágio 1). Depois
vêm o launcher `py`, nomes de PATH, venvs, managers, locais de
plataforma e caminhos convencionais — todo candidato é **executado**
com `--version`; alias da Microsoft Store que não executa vira
`store-stub` (nunca selecionado). Piso padrão `>=3.10`; um `forge.json`
com campo `python` pode exigir mais.

## 9. Vários Pythons no Linux

A descoberta examina `python3.x` decrescentes e escolhe o mais novo que
satisfaz o piso — um Python 3.13 no PATH vence um 3.10 mesmo sem flag.
`forge env discover --json` lista todos os candidatos com
`verdict`/`code` por item.

## 10. Rede ou permissão restrita

```bash
forge-cli install api-forge --method registry --offline   # só cache local
forge-cli env paths                                       # matriz de alvos de escrita
forge-cli install <dir>                                   # fonte local: zero rede
```

- `--offline` resolve do wheelhouse (`~/.forge-cli/cache/wheels/`) e
  metadados — artefato ausente = recusa honesta, nunca fingimento.
- Nada de `sudo`/admin: alvos de escrita são os diretórios do usuário
  (`env paths` mostra `home`, `bin`, `venvs`, `receipts`…); alvo
  negado sai como `FORGE-INSTALL-PERMISSION-DENIED` com o fallback.
- Fonte local (`install <dir>`) não toca rede por definição.

## 11. Integrações opcionais (pós-install)

Depois que uma instalação termina com sucesso, o forge-cli lista as
**integrações opcionais** declaradas para a(s) Forja(s) instalada(s) —
especialistas que compõem com ela (verificadores independentes, delegates
do orquestrador, fallbacks). Regras invioláveis:

- **Consentimento explícito.** Em terminal interativo a lista é um
  checkbox (`Espaço` marca, `Enter` confirma) sem nada pré-marcado;
  seleção vazia = nada instalado. `--yes`, `--json` e pipes nunca
  presumem consentimento — a lista sai como nota informativa (ou no
  campo `optional_integrations` do relatório JSON).
- **Nunca automático.** Nenhum fluxo instala uma Forja irmã como
  dependência — composição é sempre opcional, nunca mandatória.
- **Detecção por evidência.** Antes de oferecer, cada integração é
  classificada: `verified` (receipt com verify ok), `installed`
  (receipt sem prova ou binário no PATH), `checkout` (clone presente),
  `degraded` (receipt com verify falho ou fonte ausente) e `absent`.
  O que já está saudável não é oferecido de novo.
- **Sem rota honesta.** Integração sem dist no PyPI (hoje:
  `data-sentinel-forge`) aparece com a razão e o remédio correto
  (`--method git` / método do repositório) — nunca é fingida instalável
  nem instalada.

```bash
forge-cli install the-forge          # instala → oferece os delegates do orquestrador
forge-cli install the-forge --yes    # instala → integrações saem como nota (nada extra entra)
forge-cli install the-forge --json   # idem, no campo optional_integrations do documento
```

### Doctor — `installation.integrations.<forja>`

`forge doctor` ganha um check por Forja instalada que declara
integrações, cobrindo as dimensões exigidas pela lf-0031 em cada
especialista: instalação (state), capability (`derivável`/declarada),
versão (receipt), executable-health (verify do receipt), contract
(`forge.json` do checkout) e delegation-adapter (`the-forge`/`ausente`).

- `skip` — todas ausentes: opcionais, **nunca falham a Forja
  principal** (e não entram no plano de `doctor --fix`);
- `pass` — ao menos uma presente e nenhuma degradada;
- `warn` (low) — alguma degradada (verify falho/fonte perdida);
  reparo é `UNSUPPORTED` no heal — só diagnóstico.

Especialistas sem adapter the-forge (hoje `data-sentinel-forge`)
aparecem como `adapter=ausente`/`capability=não declarada` em evidência
— gap documentado, reportado, nunca transformado em falha.

## Ciclo de vida da fonte local

| Operação     | Comando                            | Comportamento                                                                                                                               |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Atualizar    | `forge-cli update <dir-mais-novo>` | reconcilia arquivos na fonte registrada (copia novos/alterados; remove só o que o receipt registrou e a fonte nova não traz)                |
| Reparar      | `forge-cli reinstall <nome>`       | remove artefatos gerenciados registrados e re-executa o bootstrap no lugar                                                                  |
| Desinstalar  | `forge-cli uninstall <nome> --yes` | remove **só** `managed_artifacts` (com backup dos arquivos em `~/.forge-cli/backups/`); a fonte e os arquivos do usuário nunca são apagados |
| Diagnosticar | `forge status` / `forge doctor`    | receipt local aparece como `install_method: local`; fonte ausente vira `drifted`, nunca erro                                                |

`update <nome>` (pelo nome) é recusado para fontes sem git com
`FORGE-SOURCE-GITLESS` — a semântica de `pull` não existe; aponte o
diretório-fonte mais novo. `--method git` numa fonte sem `.git` recebe
a mesma recusa antes de instalar.
