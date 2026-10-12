# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui, no
formato [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não lançado]

### Adicionado

- Provisionamento de `.env` por repositório antes do script de
  instalação: copia `.env.example`, cria modelo comentado ou preserva
  `.env` existente (lf-0002).
- Verificação de ambiente (preflight): `git`, Node.js >= 20 e
  `powershell.exe` no Windows, com saída `exit 1` antes dos prompts.
- UI/UX: banner animado, tema de cores centralizado, ícones emoji,
  spinners com cronômetro, tempo por repositório e relatório final
  enriquecido.

### Alterado

- Refatoração interna: `index.ts` reduzido a orquestrador; novos
  módulos `prompts`, `runner`, `report`, `env`, `preflight` e
  `ui/{theme,strings}` (lf-0002).

## [0.1.0] - 2026-10-11

### Adicionado

- CLI interativa que clona/atualiza os 8 repositórios do ecossistema
  Forge e executa `install.ps1` (Windows) ou `install.sh`
  (Linux/macOS) (lf-0001).
- Fluxo `@clack/prompts`: diretório de destino (padrão
  `./forge-workspace`), multiseleção, confirmação, spinners e
  relatório `[OK]`/`[AVISO]`/`[ERRO]`.
- Cancelamento limpo via `isCancel()` e `SIGINT`.
- Testes `vitest` para o catálogo e utilitários de sistema.
