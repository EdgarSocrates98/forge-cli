# Modelo de ameaça e decisões de confiança

O forge-cli executa **código de terceiros** por definição: scripts
`setup.sh`/`setup.ps1` de cada Forja, `pip install`, `git clone/pull`,
instaladores nativos delegados, handshakes MCP e (opt-in) o bridge de IA.
Este documento registra o que o runtime garante, o que recusa e o que
permanece responsabilidade do usuário.

## Ambiente de subprocessos — deny-first por padrão (wave-14)

Todo processo filho recebe um ambiente **allowlisted**, nunca
`process.env` inteiro:

- Variáveis com formato de credencial (`*_SECRET*`, `*_TOKEN*`,
  `*_KEY*`, `AWS_*`, `OPENAI_*`, …) são negadas por padrão — o
  bootstrap de uma Forja não precisa das suas chaves de cloud.
- Toolchain/OS/locale/proxy/TLS passam por allowlist explícita
  (`PATH`, `HOME`, `LANG`, `HTTPS_PROXY`, `NODE_*`, `npm_*`, …).
- **Git** recebe adicionalmente prefixos `GIT_*`/`SSH_*` (auth legítimo)
  e `GIT_TERMINAL_PROMPT=0` é injetado **sempre** — clone/pull/fetch
  são não-interativos e com timeout limitado; credencial ausente é
  falha classificada, nunca prompt travado.
- **Bridge de IA** (opt-in via `FORGE_CLI_AI_CMD`) recebe só os
  prefixos do provedor configurado — BYOK continua sob controle do
  usuário.
- `extendEnv: false` em todo execa/spawn: o ambiente sanitizado nunca é
  re-mesclado com o pai.
- Escape hatch explícito: `FORGE_CLI_ENV_ALLOW="FOO,BAR"` re-admite
  nomes — inclusive credential-shaped — porque o chamador assumiu a
  decisão. É a mesma variável usada nos testes para stubs de git.

Verificação: `tests/child-env.test.ts` prova que
`AWS_SECRET_ACCESS_KEY`, `OPENAI_API_KEY` e nomes arbitrários não
vazam, e que o allowlist de toolchain permanece íntegro.

## Evidência: receipt filho, nunca exit code (wave-14)

`exit 0` não é prova de instalação aplicada. Toda delegação nativa
(`--native`, `workspace install`, update/uninstall nativos) exige um
receipt `forge/InstallReceipt/v1` — `status: completed` +
`verification.status: PASS` — descoberto no stdout do filho ou em
`.<estado>/**/receipts/*.json` sob o alvo:

| Observação                           | Veredito              |
| ------------------------------------ | --------------------- |
| receipt completed + PASS             | `applied`             |
| processo limpo, sem receipt válido   | `unverified`          |
| receipt non-PASS / status inesperado | `failed`/`unverified` |
| exit ≠ 0                             | `failed`              |

`unverified` é um estado honesto e final — nunca promovido a `applied`.
Verificação: `tests/child-receipt.test.ts`, `tests/workspace-install.test.ts`.

## Fontes gitless — proveniência e confiança

`forge-cli install <dir>` instala código que **não passou pelo git**:
ZIP extraído, pasta copiada, checkout sem `.git`. A decisão de
confiança do forge-cli é deliberadamente limitada — identidade e
integridade local, **não** proveniência criptográfica:

| Nível  | Evidência                                                           |
| ------ | ------------------------------------------------------------------- |
| `A`    | `.git` + `forge.json` válido + estrutura esperada + checksums OK    |
| `B`    | `GITLESS_VALID_FORGE`: `forge.json` válido + estrutura completa     |
| `C`    | `GITLESS_PARTIAL_FORGE`: `forge.json` válido + estrutura incompleta |
| `none` | sem manifesto legível                                               |

Decisões duras no caminho gitless:

- **Symlink/junction → `UNTRUSTED_SOURCE`** (recusa `FORGE-SOURCE-INVALID`):
  fonte por link não é confiável; passe o diretório real.
- **Identidade conflitante → `CONFLICTING_IDENTITY`** (`FORGE-SOURCE-CONFLICT`):
  `forge_id` divergente do esperado nunca é "resolvido".
- **Fonte parcial exige confirmação**: `GITLESS_PARTIAL_FORGE` recusa com
  `FORGE-SOURCE-GITLESS` a menos que `--yes` seja explícito; o receipt fica
  com `integrity: 'partial'` — rebaixamento registrado, nunca escondido.
- **Checksums opcionais mas respeitados**: `SHA256SUMS`,
  `checksums.sha256` ou `.forge-checksums.json` são conferidos quando
  presentes; divergência rebaixa `integrity`, ausência marca
  `unverified`. Checksum **não** identifica origem — só integridade.
- `source_trust` (A/B/C/none) é persistido no receipt da instalação —
  a decisão é auditável depois.

O que gitless **não** fornece e o usuário deve prover: autoria
assinada (commits/tags assinadas), revisão da origem do ZIP/pasta e a
decisão de rodar o `setup.sh` de um diretório sem histórico. O
forge-cli executa o bootstrap da fonte com o mesmo env deny-first dos
demais filhos, mas o conteúdo executado é confiança do usuário — trate
`install <dir>` como `curl | sh` com melhor auditabilidade, não como
canal verificado. Para proveniência verificável, prefira
`--method registry` (wheel sha256 conferida byte a byte) ou `--method git`.

## Git — não-interativo e limitado (wave-14)

`GIT_TERMINAL_PROMPT=0` em fetch/pull/clone + timeouts finitos: um
remote que pede credencial falha rápido e classificado (auth/dns/
timeout/refused), nunca trava a TUI nem forja sucesso.

## Dois ledgers

`~/.forge-cli/forges/` (runtimes, escritor: forge-cli) e
`~/.forge/installations/` (ativações, escritor: theforge) são fatos
independentes — contrato em `docs/registry-state-contract.md` e
fronteira em `docs/forge-cli-vs-theforge.md`.
