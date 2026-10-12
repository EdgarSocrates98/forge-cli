# forge-cli

CLI interativa para clonar e configurar o ecossistema **Forge**: oito
repositórios, um comando. O forge-cli resolve o diretório de destino,
sincroniza cada repositório (clone ou pull), provisiona o arquivo `.env`
e executa o script de instalação do sistema operacional — tudo com
feedback visual em tempo real.

## Funcionalidades

- **Fluxo 100% interativo** com `@clack/prompts`: banner animado,
  prompts, spinners com cronômetro e relatório final consolidado.
- **Sincronização inteligente**: faz `git clone` quando o repositório
  não existe e `git pull` quando a pasta já contém `.git`.
- **Provisionamento de `.env`**: antes de qualquer script de
  instalação, copia `.env.example` para `.env` ou cria um modelo com
  comentários. Um `.env` existente nunca é sobrescrito.
- **Scripts por sistema operacional**: `install.ps1` no Windows e
  `install.sh` no Linux/macOS, detectados automaticamente.
- **Verificação de ambiente (preflight)**: confirma `git`, Node.js
  >= 20 e `powershell.exe` (Windows) antes de qualquer alteração.
- **Isolamento de falhas**: o erro em um repositório não interrompe os
  demais; o relatório final mostra `[OK]`, `[AVISO]` ou `[ERRO]` por
  item, com tempo de execução.
- **Saída limpa**: cancelamento via `Ctrl+C` em qualquer prompt
  ou `SIGINT` durante a execução.

## Requisitos

| Requisito | Versão | Observação |
|---|---|---|
| Node.js | >= 20 | Verificado no preflight |
| npm | >= 10 | Gerenciador de pacotes fixo |
| Git | qualquer recente | Precisa estar no `PATH` |
| PowerShell | qualquer | Somente Windows — `install.ps1` |
| Credenciais Git | — | Acesso aos repositórios privados |

## Instalação

Clone este repositório e instale as dependências:

```bash
git clone https://github.com/EdgarSocrates98/forge-cli.git
cd forge-cli
npm install
```

Para rodar sem compilar:

```bash
npm run dev
```

Para compilar e usar como comando global:

```bash
npm run build
npm link        # registra o binário `forge-cli`
forge-cli       # em qualquer diretório
```

## Uso

Execute `npm run dev` (ou `forge-cli`, se instalado globalmente) e siga
o fluxo interativo:

1. **Banner e verificação de ambiente.** O CLI exibe o banner do Forge
   e valida `git`, a versão do Node.js e o `powershell.exe` (no
   Windows). Falhas encerram o processo antes de qualquer prompt.
2. **Diretório de instalação.** Informe onde os repositórios serão
   clonados. O padrão é `./forge-workspace`; o caminho é convertido
   para absoluto e o diretório criado se não existir.
3. **Seleção de repositórios.** Marque ou desmarque itens com `Espaço`.
   Todos os oito vêm selecionados por padrão; ao menos um é obrigatório.
4. **Confirmação.** Revise o resumo (destino e quantidade) e confirme.
5. **Execução.** Para cada repositório, um spinner mostra a fase atual:
   `Sincronizando`, `Provisionando .env` e `Executando script`.
6. **Relatório final.** Status por repositório com tempo de execução e
   totais agregados.

Para cancelar em qualquer etapa, pressione `Ctrl+C`. O processo
encerra de forma limpa (código `130` em `SIGINT`).

## Repositórios do ecossistema

| Repositório | Descrição |
|---|---|
| `the-forge` | Framework base e utilitários |
| `spark-forge-aws` | Pipelines Spark para AWS |
| `spark-forge-azure` | Pipelines Spark para Azure |
| `platform-forge` | Serviços e infra de plataforma |
| `api-forge` | Backend central e APIs |
| `forge-doctor-api` | API de diagnóstico e telemetria |
| `forge-doctor-data` | Pipeline de dados de diagnóstico |
| `forge-portal` | Frontend / Portal Web |

Todos os repositórios ficam na organização
[`EdgarSocrates98`](https://github.com/EdgarSocrates98) no GitHub.

## Provisionamento do `.env`

Antes do script de instalação, cada repositório recebe um `.env`:

| Condição | Ação | Indicador no relatório |
|---|---|---|
| `.env` já existe | Nada — nunca sobrescreve | `.env já existia` |
| `.env.example` existe | Copiado para `.env` | `.env criado a partir de .env.example` |
| Nenhum dos dois | Modelo com comentários criado | `.env criado (modelo vazio…)` |

Se o provisionamento falhar (por exemplo, permissão negada), o
repositório é marcado como `[ERRO]` e o script de instalação **não**
é executado para ele.

## Status de execução

| Status | Significado |
|---|---|
| ✅ `[OK]` | Clonado/atualizado e script executado com sucesso |
| ⚠️ `[AVISO]` | Clonado, mas sem script de instalação para este SO |
| ❌ `[ERRO]` | Falha no clone/pull, no `.env` ou no script |

## Scripts do projeto

| Comando | Ação |
|---|---|
| `npm run dev` | Executa o CLI via `tsx`, sem compilar |
| `npm run build` | Compila `src/` para `dist/` via `tsup` |
| `npm start` | Executa `dist/index.js` |
| `npm test` | Testes unitários via `vitest` |
| `npm run typecheck` | Verificação de tipos (`tsc --noEmit`) |

## Estrutura do projeto

```text
src/
  index.ts           # orquestrador do fluxo interativo
  prompts.ts         # prompts: diretório, seleção, confirmação
  runner.ts          # pipeline por repositório (clone → .env → script)
  env.ts             # provisionamento do .env
  preflight.ts       # verificações de ambiente
  report.ts          # relatório final
  ui/
    theme.ts         # paleta de cores e ícones (picocolors)
    strings.ts       # todas as mensagens PT-BR
  constants/
    repos.ts         # catálogo dos 8 repositórios
  utils/
    system.ts        # caminhos, .git, scripts por SO, execução
  types.ts           # tipos compartilhados
tests/               # testes unitários (vitest)
factory/             # fluxo spec-driven (Loop Factory)
```

## Documentação

- [Arquitetura e decisões de design](docs/arquitetura.md)
- [Solução de problemas](docs/solucao-de-problemas.md)
- [Como contribuir](CONTRIBUTING.md)
- [Registro de mudanças](CHANGELOG.md)
