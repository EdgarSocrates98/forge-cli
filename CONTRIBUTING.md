# Contribuindo com o forge-cli

Guia para desenvolver no forge-cli: ambiente, convenções de código e o
fluxo de trabalho orientado a specs (Loop Factory).

## Configuração do ambiente

1. Instale o Node.js >= 20 e o Git.
2. Clone o repositório e instale as dependências:

   ```bash
   npm install
   ```

3. Rode a suíte de verificação completa:

   ```bash
   npx tsc --noEmit
   npm run build
   npm test
   ```

## Convenções de código

- **TypeScript estrito** com módulos `NodeNext`. Imports relativos
  usam o sufixo `.js` (por exemplo, `./env.js`), mesmo apontando para
  arquivos `.ts`.
- **ESM puro** (`"type": "module"`). Não use `require` nem
  `__dirname` — use `import` e `import.meta` quando necessário.
- **Strings de UI ficam em `src/ui/strings.ts`.** Nunca escreva texto
  visível ao usuário diretamente nos módulos. Todo o texto é PT-BR.
- **Cores e ícones ficam em `src/ui/theme.ts`.** Não chame
  `picocolors` fora do tema.
- **Dependências de runtime são congeladas por spec.** O conjunto
  atual (`@clack/prompts`, `picocolors`, `figlet`, `execa`) só muda por
  decisão de produto registrada em spec.
- **Erros são capturados por repositório.** Uma falha nunca aborta o
  lote — converta exceções em `RepoResult` com `status: 'error'`.

## Testes

Os testes vivem em `tests/` e usam `vitest`. Cobertura esperada:

- Lógica pura (decisões de `.env`, resolução de caminhos, seleção de
  script por SO, versão do Node).
- Use `mkdtempSync` + `tmpdir()` para testes que tocam o filesystem;
  limpe com `rmSync` no `afterEach`.
- Não teste prompts interativos nem chamadas reais a `git`/rede.

## Fluxo spec-driven (Loop Factory)

Mudanças no produto entram como **specs** em `factory/specs/inbox/`.
A pasta onde a spec está define seu estado:

```text
inbox/  →  active/  →  archive/<ano>/
nova      em          revisada e
spec      execução    aceita
```

Comandos (CLI instalado via `pip` a partir de
`E:\projetos\Loop-Factory`):

```bash
python -m loop_factory.cli scan                    # fila
python -m loop_factory.cli dispatch --agent codex --stage
python -m loop_factory.cli review <spec-id> --agent codex
python -m loop_factory.cli archive <spec-id> --accepted
```

Regras:

- Toda spec nova passa pelo `# Grill Gate` antes de ir para `active/`.
- Os comandos de verificação vivem no frontmatter `verification:` da
  spec — rode todos antes de considerar o trabalho pronto.
- Nada sai de `active/` sem revisão aceita (`archive --accepted`).
- Artefatos em `factory/prompts/`, `factory/runs/` e
  `factory/reviews/` são trilha de auditoria; a spec é a fonte da
  verdade.

## Commits

Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`) em
inglês, com o id da spec quando aplicável — por exemplo,
`feat: env bootstrap, preflight checks (lf-0002)`.
