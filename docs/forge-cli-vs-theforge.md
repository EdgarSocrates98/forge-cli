# forge-cli × theforge — fronteira de responsabilidades

Dois CLIs, dois papéis distintos — usados juntos, nunca um no lugar do outro.

|               | **forge-cli** (este repositório)                                                                                                                                                                                           | **theforge** (the-forge)                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Papel         | **Ferramenta de controle / meta-instalador de aquisição de runtimes**                                                                                                                                                      | **Control plane** — ativa capacidades no workspace                                                                                     |
| O que faz     | Instala e atualiza **runtimes** das Forjas: venvs do registry PyPI (`~/.forge-cli/forges/`), clones git, fontes locais gitless, delegação ao instalador nativo, `workspace scan/pack/doctor`, shims em `~/.forge-cli/bin/` | Ativa capacidades **dentro de um workspace**: skills/agents/regras nos hosts, MCP servers, contexto `.forge/` — `theforge setup`, `install plan | apply | auto`, `doctor`, `update`, `uninstall` |
| O que NÃO faz | Não é uma Forja de conteúdo; não instala host-assets por conta própria (delega e verifica o receipt)                                                                                                                       | Não baixa wheels do PyPI nem gerencia venvs/lock de versões dos runtimes                                                               |
| Ledger        | `~/.forge-cli/forges/` (`state.json` + `install.json` por Forja)                                                                                                                                                           | `~/.forge/installations/` (ledger de bootstrap/ativação)                                                                               |
| Manifesto     | `forge.json` com `installation_kind: "control-tool"`                                                                                                                                                                       | `forge.json` com `installation_kind: "control-tool"` (orquestrador)                                                                    |

## O fluxo correto, na ordem

```bash
# 1. AQUISIÇÃO do runtime — forge-cli
forge-cli install spark-forge-aws --method registry     # venv + wheel verificada
forge-cli install the-forge                             # idem (ou --method git)

# 2. ATIVAÇÃO no workspace — theforge (instalado no passo 1)
cd meu-workspace
theforge setup                 # onboarding guiado (wizard); sem conhecimento de arquitetura
# controle fino, quando precisar:
theforge install plan          # plano consolidado (install-2.1)
theforge install apply         # ou `auto` — escreve host-assets com receipt
```

Trocar os papéis produz estados honestos mas incompletos:

- `forge-cli install x` instala o **runtime** (a venv/o checkout). Sem o
  passo 2, nenhum skill/agent é ativado no workspace — isso é esperado,
  não um bug.
- `theforge install` ativa **o que já existe**. Ele delega a fase-2 ao
  instalador nativo da Forja (o mesmo caminho que `forge-cli ... --native`),
  mas não resolve PyPI/venv/checkout — esse é o trabalho do forge-cli.

## Delegação nativa e evidência (wave-14)

Quando o forge-cli aciona o instalador nativo de uma Forja
(`--native`, `workspace install`, ops de lifecycle), o veredito vem do
receipt filho `forge/InstallReceipt/v1` — `status: completed` +
`verification.status: PASS` — nunca do exit code sozinho:

- receipt PASS → `applied` (com `receiptRef` do arquivo/stdout);
- processo limpo sem receipt válido → `unverified` (não aplicado);
- processo falhou → `failed`.

O mesmo raciocínio vale para `workspace install`: o `WorkspaceOperationReceipt`
só marca `applied` quando o receipt do filho comprova.

## Os dois ledgers — reconciliar, nunca confundir

| Ledger                    | Dono      | Conteúdo                                                   |
| ------------------------- | --------- | ---------------------------------------------------------- |
| `~/.forge-cli/forges/`    | forge-cli | runtimes: venv, wheel cache, versão, pin, receipt registry |
| `~/.forge/installations/` | theforge  | ativações: o que o installkit aplicou em hosts/workspaces  |

`forge-cli status` lê o primeiro; `theforge install status`/`doctor`
leem o segundo. O `forge-cli doctor` reconcilia os dois **somente para
leitura**: além da matriz venv/receipt/launcher/shim de cada runtime
(`installation.runtime.<forja>` + `installation.runtime.orphans`), cada
`~/.forge/installations/<id>.json` é verificado contra o contrato
`forge/InstallationManifest/v1` — com `venv` declarada,
`python.executable` e `<FORGE>_PYTHON` devem apontar para o launcher
**da venv** (`installation.ledger.<id>`; escrita continua exclusiva do
theforge). Uma Forja presente nos dois está com runtime **e** ativação;
presente só no primeiro = runtime instalado, nada ativado; só no
segundo = ativação sem runtime gerenciado (repare: instale o runtime
primeiro). Detalhes do formato em
`docs/registry-state-contract.md`.
