import { S } from '../ui/strings.js';
import type { Finding, VarStatus } from './model.js';
import { analyzeEnv } from './validate.js';

export interface InspectResult {
  state: 'absent' | 'partial' | 'complete';
  findings: Finding[];
  /** Sem valores — apenas presença/validade/segredo. */
  vars: VarStatus[];
}

/**
 * Inspeção somente-leitura: estado + findings + status por variável.
 * Valores nunca entram no resultado (ver S.envValueNeverShown).
 */
export function inspectEnv(repoDir: string, envKeys?: readonly string[]): InspectResult {
  const a = analyzeEnv(repoDir, envKeys);
  const findings = [...a.findings];
  if (a.envFile) {
    for (const key of a.obsolete) {
      findings.push({ key, kind: 'obsolete', detail: S.envVarObsolete });
    }
    for (const v of a.vars) {
      if (v.secret && v.present) {
        findings.push({
          key: v.key,
          kind: 'secret',
          detail: `${S.envVarSecret} · ${S.envSecretHidden}`,
        });
      }
    }
  }
  return { state: a.state, findings, vars: a.vars };
}
