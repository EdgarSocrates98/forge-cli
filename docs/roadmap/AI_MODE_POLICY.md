# AI Mode Policy — §6.3 (spec 007)

`forge ai` é um modo **opcional**. Sem opt-in explícito, nada neste módulo executa.

## Modelo de ativação

- Ativação apenas via `forge-cli.config.json` no diretório alvo:
  ```json
  {
    "ai": {
      "enabled": true,
      "command": ["claude", "-p", "--output-format", "json"],
      "maxContextBytes": 8192,
      "timeoutMs": 60000,
      "cacheTtlMs": 300000
    }
  }
  ```
- Sem `enabled: true` + `command` configurada, `forge ai` responde `disabled`
  e o comportamento determinístico permanece em vigor.
- **BYOK / pré-autorizado**: o comando de bridge é um processo local
  pré-autorizado pelo usuário (ex.: `claude -p`, `codex exec`, um proxy
  interno aprovado). Não há provider embutido, hardwired ou lock-in.
- `src/` não importa rede: o transporte pertence ao processo de bridge.

## O que a IA pode ver — `forge/ForgeContext/v1`

Somente o contexto estruturado e limitado de `src/intel/context.ts`:

- stack detectada, capabilities declaradas, Forjas (nome/estado/versão);
- hosts (id/estado/auth tri-state — sem tokens);
- config **não-secreta**: chaves que casem com
  `TOKEN|SECRET|KEY|PASSWORD|PRIVATE|CREDENTIAL|AUTH` são removidas;
  qualquer valor que `redactSecrets` altere é removido também;
- resumo de diagnósticos (ids/resultado/severidade — sem payloads);
- ids/kinds de planos ativos.

Nunca: repositórios inteiros, logs indiscriminados, valores de `.env`,
credenciais, payloads de schema.

Budget: `maxContextBytes` (default 8 KiB) é enforce antes de qualquer
chamada à bridge; contexto maior é truncado deterministicamente
(`budget.truncated: true`) ou recusado.

## Sanitização e validação

1. `sanitizeForAi` — denylist de chaves + `redactSecrets` em todos os valores;
   `assertNoSecrets` é executado como verificação final antes do spawn.
2. Saída do modelo é **input não-confiável**: `parseProposal` exige
   `forge/AiProposal/v1` bem-formado; `validateProposal` re-valida
   deterministicamente cada `ref` contra o catálogo real — referências
   desconhecidas são rejeitadas.
3. **Propostas nunca são executadas**: o módulo não possui caminho de
   execução; itens da proposta são dados de exibição.
4. Cache local (`.forge-cli/ai/cache/`) chaveado por digest do contexto
   sanitizado + tarefa; contém apenas propostas sanitizadas.

## Degradação

Sem IA habilitada, sem bridge, timeout ou saída inválida → `AiResult`
tipado (`disabled | no-bridge | invalid-output | bridge-error | timeout`)
e o usuário permanece no fluxo determinístico. Nenhum caminho depende de IA.

## Telemetria

Nenhuma. O modo IA não envia telemetria remota; o único "envio" é o
contexto sanitizado para o processo de bridge que o próprio usuário
configurou e autorizou.
