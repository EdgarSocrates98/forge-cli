# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui, no
formato [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não lançado]

### Adicionado

- `help`, `components [forjas]` (flags do instalador nativo por Forja),
  `doctor <forja>` e `--offline` (usa só clones existentes; nunca clona
  nem faz pull/fetch).
- Adaptadores leves (Cycle 0/6): `--profile`, `--scope` e `--components`
  acionam o instalador nativo da Forja (`<cli> install ...`) depois do
  bootstrap, somente para Forjas que o documentam; sempre `--dry-run`
  salvo `--yes`. Matriz de capacidades real em `docs/capabilities.md`.
- Portabilidade/distribuição (Cycle 8/9): `self update` respeitando o
  método de instalação (npm global automático com `--yes`; shim e
  código-fonte mostram o passo manual), CI em Linux/Windows/macOS e
  testes dos cenários de independência A–F.
- TUI (Cycle 2): menu principal ao rodar `forge-cli` em terminal
  interativo (instalar, atualizar, reinstalar, reparar, versões, estado,
  desinstalar, diagnosticar, sair). Sem TTY ou com comando/flags de
  seleção, o comportamento anterior é mantido. `uninstall` pede
  confirmação interativa quando não há `--yes`.
- Ciclo de vida (Cycle 4/5/7): `pin`/`unpin` (install/update respeitam a
  fixação), `rollback` (só o checkout Git, ao HEAD anterior registrado),
  `reinstall` (mantém a revisão atual; `--clean` remove e reclona com
  backup) e `uninstall <forjas>` (plano por padrão, exige `--yes`; recusa
  tree suja, remote diferente, symlink e diretórios sem .git; faz backup
  de `.env`/configs em `.forge-cli/backups`).
- Versões e revisões (Cycle 3/5): `update [forjas]` (sem nomes: todas as
  clonadas), `update --check` (só fetch, sem alterar), `versions`,
  `--ref <sha|tag>` e `--version <tag>` (checkout destacado; recusa
  working tree modificada; exige uma única Forja).
- Subcomandos (Cycle 3): `install [forjas]`, `clone <forjas>` (sem
  scripts), `status [forjas]`, `self install|uninstall`. **Mudança:**
  `forge-cli install` sem nomes agora abre o fluxo interativo; o
  registro no PATH é `forge-cli self install`.
- Sync Git (Cycle 1): detecta remote divergente do catálogo e classifica
  falhas de pull (divergente/rede/autenticação). Scripts não rodam após
  falha de sync sem `--run-after-sync-failure`; repositórios de
  `forge-cli.repos.json` só executam scripts com `--trust-custom`.
- Segurança (Cycle 1): validação de nomes/URLs de repositórios (bloqueia
  path traversal, `--opção`, `ext::`, `file://` e credenciais embutidas),
  recusa de destino symlink/junction, `git clone --`, redação de
  segredos em logs/relatórios/erros e escrita atômica de estado.
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
