/**
 * Taxonomia `FORGE-*` de erros nomeados (ciclo 12.1 — fontes locais).
 * Cada código é estável para scripts e carrega causa + remédio acionável
 * em PT-BR: a recusa diz O QUE falhou e COMO destravar, nunca só o nome.
 */
export type ForgeErrorCode =
  /** Diretório inexistente, não é diretório ou sem nenhum marcador de Forja. */
  | 'FORGE-SOURCE-NOT-FOUND'
  /** A operação exige git (pull/clone/remote) mas a fonte é sem `.git`. */
  | 'FORGE-SOURCE-GITLESS'
  /** forge.json malformado/ausente, sem script executável ou fonte não confiável. */
  | 'FORGE-SOURCE-INVALID'
  /** forge.json declara uma Forja diferente da que a estrutura indica. */
  | 'FORGE-SOURCE-CONFLICT'
  /** Bootstrap local executou mas a verificação pós-install falhou. */
  | 'FORGE-INSTALL-VERIFICATION-FAILED'
  /** Windows sem nenhuma shell de instalação (powershell/pwsh ausentes e Git Bash inexistente). */
  | 'FORGE-SHELL-NOT-FOUND'
  /** Shell candidata existe no disco mas não executa (bloqueio de política, quebrada). */
  | 'FORGE-SHELL-UNAVAILABLE'
  /** Alvo de escrita resolvido nega permissão — reporta alternativa concreta. */
  | 'FORGE-INSTALL-PERMISSION-DENIED'
  /** Persistência de ambiente (PATH, .env, registry) falhou na escrita. */
  | 'FORGE-ENV-PERSISTENCE-FAILED';

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  /** Ação que destrava o usuário (PT-BR) — sempre presente nas recusas. */
  readonly remedy?: string;

  constructor(code: ForgeErrorCode, message: string, remedy?: string) {
    super(message);
    this.name = 'ForgeError';
    this.code = code;
    this.remedy = remedy;
  }
}

/**
 * Recusa estruturada de uma operação sobre fonte local — o `code` é
 * opcional porque nem toda falha é uma recusa nomeada (falha operacional
 * do script de setup não ganha código FORGE-* inventado).
 */
export interface LocalFailure {
  code?: ForgeErrorCode;
  cause: string;
  remedy?: string;
}
