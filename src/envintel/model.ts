/** Modelo da inteligência de .env — nenhum tipo carrega valores para fora do parser/aplicador. */

export interface EnvEntry {
  key: string;
  value: string;
  /** Índice da linha dentro de EnvFile.lines (base 0). */
  line: number;
  /** Comentário inline após o valor, quando presente. */
  comment?: string;
}

export interface EnvFile {
  entries: EnvEntry[];
  /** Linhas brutas e ordenadas — fonte da verdade para round-trip byte a byte. */
  lines: string[];
}

export type VarKind = 'secret' | 'path' | 'port' | 'url' | 'bool' | 'number' | 'string' | 'enum';

export interface VarSpec {
  key: string;
  kind: VarKind;
  required: boolean;
  secret: boolean;
  /** Nunca carrega valores de segredos — defaults de vars secretas não são propagados. */
  default?: string;
  choices?: string[];
  pattern?: string;
  /** `dependsOn = 'A'` significa: esta var é exigida quando A está definida e não-vazia. */
  dependsOn?: string;
}

export interface EnvSchema {
  vars: VarSpec[];
}

export type FindingKind =
  'missing' | 'obsolete' | 'conflict' | 'insecure' | 'duplicate' | 'invalid' | 'secret';

export interface Finding {
  key: string;
  kind: FindingKind;
  /** Detalhe livre de valores — só rótulos, nomes de chaves e números de linha. */
  detail: string;
}

export interface VarStatus {
  key: string;
  kind: VarKind;
  present: boolean;
  /** null quando ausente; true/false conforme o validador do kind. */
  valid: boolean | null;
  secret: boolean;
}
