import { S } from '../ui/strings.js';
import { malformedLines } from './parse.js';
import { analyzeEnv } from './validate.js';

export interface EnvDoctorCheck {
  id: string;
  result: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface EnvDoctorResult {
  state: 'absent' | 'partial' | 'complete';
  checks: EnvDoctorCheck[];
  score: number;
}

export function envDoctor(repoDir: string, envKeys?: readonly string[]): EnvDoctorResult {
  const a = analyzeEnv(repoDir, envKeys);
  const count = (kind: string) => a.findings.filter((f) => f.kind === kind).length;
  const checks: EnvDoctorCheck[] = [];

  checks.push({
    id: 'file-present',
    result: a.envFile ? 'pass' : 'fail',
    detail: a.envFile ? '.env' : S.envFileAbsent,
  });

  const malformed = a.envFile ? malformedLines(a.envFile) : [];
  checks.push({
    id: 'parse-clean',
    result: !a.envFile ? 'warn' : malformed.length ? 'warn' : 'pass',
    detail: !a.envFile
      ? S.envFileAbsent
      : malformed.length
        ? malformed.map((i) => i + 1).join(', ')
        : 'ok',
  });

  const missing = count('missing');
  checks.push({
    id: 'required-covered',
    result: missing ? 'fail' : 'pass',
    detail: missing ? `${missing} ${S.envVarMissing}` : 'ok',
  });

  const insecure = count('insecure');
  checks.push({
    id: 'secrets-non-placeholder',
    result: insecure ? 'fail' : 'pass',
    detail: insecure ? `${insecure} ${S.envVarInsecure}` : 'ok',
  });

  const duplicates = count('duplicate') + count('conflict');
  checks.push({
    id: 'no-duplicates',
    result: duplicates ? 'warn' : 'pass',
    detail: duplicates ? `${duplicates} ${S.envVarDuplicate}` : 'ok',
  });

  checks.push({
    id: 'schema-coverage',
    result: a.envFile && a.obsolete.length ? 'warn' : 'pass',
    detail: a.envFile && a.obsolete.length ? `${a.obsolete.length} ${S.envVarObsolete}` : 'ok',
  });

  const score = Math.round(
    (checks.filter((c) => c.result === 'pass').length / checks.length) * 100,
  );
  return { state: a.state, checks, score };
}
