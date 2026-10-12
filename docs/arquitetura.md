# Arquitetura

O forge-cli é um CLI Node.js (ESM + TypeScript) de fluxo único: um
orquestrador fino coordena módulos pequenos e testáveis. A regra de
organização é simples — **`src/index.ts` só orquestra; toda lógica
vive em módulos especializados.**

## Mapa de módulos

| Módulo                   | Responsabilidade                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `src/index.ts`           | Só despacha: parse de args, menu, resolução do subcomando, SIGINT e erros fatais.                      |
| `src/cmd/shared.ts`      | Banner, preflight, catálogo efetivo, `--json`, seleção de Forjas por nome.                             |
| `src/cmd/batch.ts`       | Execução sequencial com spinner/taskLog por Forja.                                                     |
| `src/cmd/query.ts`       | `doctor`, `list`, `status`, `update --check`, `versions` (com `--json`).                               |
| `src/cmd/manage.ts`      | `pin`, `unpin`, `rollback`, `uninstall <forjas>`, `self update`, PATH.                                 |
| `src/cmd/run.ts`         | Fluxo de instalação/clone/update/reinstall e resumo de execução com aprovação.                         |
| `src/prompts.ts`         | Prompts interativos (diretório, seleção, confirmação) e tratamento de cancelamento via `isCancel()`.   |
| `src/preflight.ts`       | Verificações de ambiente antes de qualquer prompt: `git`, Node.js >= 20, `powershell.exe` no Windows.  |
| `src/runner.ts`          | Pipeline por repositório com cronômetro e fases: sincronizar → `.env` → script de instalação.          |
| `src/env.ts`             | Provisionamento do `.env` (`planEnvFile` decide, `ensureEnvFile` executa).                             |
| `src/report.ts`          | Badges de status, linha por repositório e relatório consolidado.                                       |
| `src/ui/theme.ts`        | Paleta de cores (picocolors) e ícones emoji. Único ponto de contato com cores.                         |
| `src/ui/strings.ts`      | Todas as strings visíveis ao usuário, em PT-BR.                                                        |
| `src/constants/repos.ts` | Catálogo fixo dos oito repositórios Forge.                                                             |
| `src/utils/system.ts`    | Primitivas: resolução de caminho, `.git`, seleção de script por SO, `execa`, detalhe de erro.          |
| `src/commands.ts`        | Resolve o subcomando (`install`, `clone`, `update`, `pin`, `self ...`) a partir dos posicionais.       |
| `src/menu.ts`            | Menu principal; só aparece com TTY e sem comando/flags de seleção.                                     |
| `src/safety.ts`          | Nomes/URLs de repositório válidos, bloqueio de symlink/junction, redação de segredos, escrita atômica. |
| `src/git-revs.ts`        | Tags, checkout destacado por ref/versão, verificação de atualização via fetch.                         |
| `src/lifecycle.ts`       | Plano e execução de uninstall (com backup) e rollback de checkout.                                     |
| `src/native-install.ts`  | Monta o `<cli> install` nativo da Forja com as flags que ela documenta.                                |
| `src/status.ts`          | Fase local (não clonado, clonado, instalado, falha), versão e alterações.                              |
| `src/self.ts`            | Detecta o método de instalação do CLI e planeja o `self update`.                                       |
| `src/types.ts`           | Tipos compartilhados (`ForgeRepo`, `RepoResult`, `InstallScript`, `PreflightCheck`).                   |

## Fluxo de execução

```mermaid
flowchart TD
    A[Banner animado + intro] --> B[Preflight: git, Node, powershell]
    B -->|falha| Z1[log.error + exit 1]
    B -->|ok| C[Prompt: diretório de destino]
    C --> D[Resolve caminho + mkdir -p]
    D --> E[Multiselect: 8 repositórios]
    E --> F[Resumo + confirmar]
    F -->|cancelou| Z2[cancel + exit 0]
    F -->|confirmou| G[Para cada repositório]
    G --> H{Pasta tem .git?}
    H -->|sim| I[git pull]
    H -->|não| J[git clone]
    I --> K[Provisionar .env]
    J --> K
    K -->|falha| L[ERRO: pula script]
    K --> M{Script do SO existe?}
    M -->|não| N[AVISO: sem script]
    M -->|sim| O[install.ps1 ou install.sh]
    O -->|falha| P[ERRO]
    O -->|ok| Q[OK]
    L & N & P & Q --> R[Próximo repositório]
    R -->|fim da lista| S[Relatório + outro]
```

## Camadas adicionadas no roadmap 2.0

- **Segurança antes de execução:** todo nome/URL passa por `safety.ts`; o
  destino nunca é symlink; segredos são mascarados em logs, relatórios e erros.
- **Sync com política:** falha de pull, divergência ou remote diferente do
  catálogo impedem a execução de scripts, salvo aprovação por flag.
- **Instalação em duas fases:** bootstrap (`setup.sh/ps1`) e, sob opt-in
  (`--profile/--scope/--components`), o `<cli> install` da própria Forja —
  sempre `--dry-run` sem `--yes`. Veja [capabilities.md](capabilities.md).
- **Independência:** nenhuma Forja depende do forge-cli; o estado em
  `.forge-cli/` é auxiliar e pode ser descartado.

## Decisões de design

### `.env` antes do script de instalação

Os scripts `install.ps1`/`install.sh` presumem variáveis de ambiente.
O `runner` provisiona o `.env` entre a sincronização e o script: se o
provisionamento falhar, o script nem roda — falhar cedo evita
instalações parciais silenciosas.

### `.env` nunca é sobrescrito

`planEnvFile` retorna `exists` quando o `.env` já está presente. O
repo pode ter segredos reais configurados; o CLI só cria o arquivo
quando ele não existe. Esta regra é coberta por teste em
`tests/env.test.ts`.

### Preflight falha rápido

Ambiente sem `git` ou sem `powershell.exe` (Windows) não consegue
completar o fluxo. Melhor falhar com mensagem clara antes de criar
diretórios do que descobrir no meio do lote.

### Isolamento de erro por repositório

`processRepo` converte cada falha (clone, `.env`, script) em um
`RepoResult` com `status: 'error'` em vez de lançar exceção. O laço
continua e o relatório final mostra o quadro completo.

### Erro detalhado via execa

`errorDetail` extrai `stderr`, `shortMessage` ou `message` do erro do
`execa` — o relatório mostra a causa real (por exemplo, erro de
autenticação do git), não só "falhou".

### Strings e cores centralizadas

Todo texto PT-BR vive em `src/ui/strings.ts` e toda cor em
`src/ui/theme.ts`. Isso mantém o código livre de literais soltos e
abre caminho para i18n futura sem reescrever módulos.

## Tipos centrais

```typescript
interface ForgeRepo {
  name;
  url;
  description;
}
type RepoStatus = 'ok' | 'warning' | 'error';
type EnvAction = 'exists' | 'copied' | 'stub';
interface RepoResult {
  repo;
  status;
  detail;
  envNote?;
  elapsedMs;
}
interface InstallScript {
  file;
  command;
  args;
}
```

## Build e distribuição

- `tsup` compila `src/index.ts` para `dist/index.js` (ESM único,
  ~12 KB), preservando o shebang do binário.
- `bin.forge-cli` aponta para `dist/index.js`; `npm link` registra o
  comando global.
- Dependências ficam externas ao bundle e são instaladas via
  `package.json`.
