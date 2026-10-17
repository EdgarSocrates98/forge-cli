import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEnvCommand } from '../src/cmd/env.js';
import type { CliOptions } from '../src/cli-args.js';
import { envDoctor } from '../src/envintel/doctor.js';
import { inspectEnv } from '../src/envintel/inspect.js';
import {
  applyMigration,
  latestEnvBackup,
  planMigration,
  rollbackEnv,
} from '../src/envintel/migrate.js';
import { malformedLines, parseEnv, serializeEnv } from '../src/envintel/parse.js';
import { deriveSchema } from '../src/envintel/schema.js';
import { validateEnv } from '../src/envintel/validate.js';

const tmpDirs: string[] = [];

function tmpDir(prefix = 'forge-cli-envintel-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function write(dir: string, name: string, content: string): void {
  writeFileSync(path.join(dir, name), content, 'utf8');
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const GNARLY = [
  '# comentário inicial — ção',
  '',
  'PLAIN=valor simples',
  "SQUOTED='com espaços e # dentro'",
  'DQUOTED="linha\\nquebrada # não é comentário"',
  'export EXPORTED=sim # trailing',
  'EMPTY=',
  'SPACED = com espaço ',
  'HASH_OK=valor#sem espaco',
  'INLINE=abc # comentário inline',
  'UNICODE=ácẽntüß 🚀',
  'linha malformada sem igual',
  '=sem-chave',
  '# final sem newline',
].join('\n');

describe('parseEnv/serializeEnv round-trip', () => {
  it('serializa byte a byte conteúdo gnarly sem perder nada', () => {
    expect(serializeEnv(parseEnv(GNARLY))).toBe(GNARLY);
  });

  it('round-trip com e sem newline final, CRLF e arquivo vazio', () => {
    for (const content of ['', 'A=1', 'A=1\n', 'A=1\n\n# fim\n', 'A=1\r\nB=2\r\n']) {
      expect(serializeEnv(parseEnv(content))).toBe(content);
    }
  });

  it('extrai chaves, valores, comentários e marca linhas raw', () => {
    const env = parseEnv(GNARLY);
    const get = (k: string) => env.entries.find((e) => e.key === k);
    expect(get('PLAIN')?.value).toBe('valor simples');
    expect(get('SQUOTED')?.value).toBe('com espaços e # dentro');
    expect(get('DQUOTED')?.value).toBe('linha\nquebrada # não é comentário');
    expect(get('EXPORTED')?.value).toBe('sim');
    expect(get('EXPORTED')?.comment).toBe('trailing');
    expect(get('EMPTY')?.value).toBe('');
    expect(get('SPACED')?.value).toBe('com espaço');
    expect(get('HASH_OK')?.value).toBe('valor#sem espaco');
    expect(get('INLINE')?.comment).toBe('comentário inline');
    expect(get('UNICODE')?.value).toBe('ácẽntüß 🚀');
    // malformadas preservadas e reportadas como raw
    expect(malformedLines(env).map((i) => env.lines[i])).toEqual([
      'linha malformada sem igual',
      '=sem-chave',
    ]);
  });

  it('mantém todas as entradas de chave duplicada', () => {
    const env = parseEnv('A=1\nA=2\n');
    expect(env.entries.filter((e) => e.key === 'A')).toHaveLength(2);
  });
});

describe('deriveSchema', () => {
  it('mescla .env.example + envKeys + forge.env.schema.json', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'APP_PORT=3000\nAPI_KEY=\nDEBUG=false\n');
    write(
      dir,
      'forge.env.schema.json',
      JSON.stringify({
        vars: [
          { key: 'LOG_LEVEL', kind: 'enum', choices: ['info', 'debug'], default: 'info' },
          { key: 'WORKERS', kind: 'number', required: true },
        ],
      }),
    );
    const schema = deriveSchema(dir, ['EXTRA_TOKEN']);
    const byKey = new Map(schema.vars.map((v) => [v.key, v]));
    expect(byKey.get('APP_PORT')).toMatchObject({ kind: 'port', required: false, default: '3000' });
    expect(byKey.get('API_KEY')).toMatchObject({ kind: 'secret', required: true, secret: true });
    expect(byKey.get('DEBUG')).toMatchObject({ kind: 'bool' });
    expect(byKey.get('EXTRA_TOKEN')).toMatchObject({ kind: 'secret', required: true });
    expect(byKey.get('LOG_LEVEL')).toMatchObject({ kind: 'enum', choices: ['info', 'debug'] });
    expect(byKey.get('WORKERS')).toMatchObject({ kind: 'number', required: true });
  });

  it('não propaga valores de segredo do exemplo para o esquema', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'REAL_TOKEN=super-secret-value-123\n');
    const spec = deriveSchema(dir).vars.find((v) => v.key === 'REAL_TOKEN')!;
    expect(spec.secret).toBe(true);
    expect(spec.default).toBeUndefined();
    expect(JSON.stringify(deriveSchema(dir))).not.toContain('super-secret-value-123');
  });

  it('ignora forge.env.schema.json malformado sem quebrar', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'A=1\n');
    write(dir, 'forge.env.schema.json', '{invalido!!!');
    expect(() => deriveSchema(dir)).not.toThrow();
    expect(deriveSchema(dir).vars.map((v) => v.key)).toEqual(['A']);
    write(dir, 'forge.env.schema.json', JSON.stringify({ vars: [{ key: '1BAD' }, { key: 42 }] }));
    expect(deriveSchema(dir).vars.map((v) => v.key)).toEqual(['A']);
  });

  it('infere kinds por nome de forma determinística', () => {
    const dir = tmpDir();
    write(
      dir,
      '.env.example',
      [
        'HTTP_PORT=1',
        'BASE_URL=x',
        'HOME_DIR=x',
        'AWS_SECRET=x',
        'FEATURE_FLAG=x',
        'RETRIES=3',
        'NOME=x',
      ].join('\n'),
    );
    const kinds = new Map(deriveSchema(dir).vars.map((v) => [v.key, v.kind]));
    expect(kinds.get('HTTP_PORT')).toBe('port');
    expect(kinds.get('BASE_URL')).toBe('url');
    expect(kinds.get('HOME_DIR')).toBe('path');
    expect(kinds.get('AWS_SECRET')).toBe('secret');
    expect(kinds.get('FEATURE_FLAG')).toBe('bool');
    expect(kinds.get('RETRIES')).toBe('number');
    expect(kinds.get('NOME')).toBe('string');
  });
});

describe('inspectEnv', () => {
  it('reporta absent sem .env', () => {
    const res = inspectEnv(tmpDir());
    expect(res.state).toBe('absent');
    expect(res.vars.every((v) => !v.present)).toBe(true);
  });

  it('reporta complete quando tudo coberto e válido', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'APP_PORT=8080\n');
    write(dir, '.env', 'APP_PORT=9090\n');
    const res = inspectEnv(dir);
    expect(res.state).toBe('complete');
    expect(res.findings).toEqual([]);
  });

  it('reporta partial com findings de missing/obsolete/insecure/duplicate/conflict', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'APP_PORT=8080\nAPI_KEY=\nREQUIRED_X=\n');
    write(dir, '.env', 'APP_PORT=8080\nAPI_KEY=changeme\nUSER_EXTRA=1\nDUP=a\nDUP=b\n');
    const res = inspectEnv(dir, ['REQUIRED_X']);
    const keysOf = (kind: string) => res.findings.filter((f) => f.kind === kind).map((f) => f.key);
    expect(res.state).toBe('partial');
    expect(keysOf('missing')).toEqual(['REQUIRED_X']);
    expect(keysOf('obsolete')).toEqual(['USER_EXTRA', 'DUP']);
    expect(keysOf('insecure')).toEqual(['API_KEY']);
    expect(keysOf('duplicate')).toEqual(['DUP']);
    expect(keysOf('conflict')).toEqual(['DUP']);
    // segredos presentes geram finding informativo 'secret'
    expect(res.findings.some((f) => f.kind === 'secret' && f.key === 'API_KEY')).toBe(true);
  });

  it('nunca expõe valores em vars/findings', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'API_KEY=\n');
    write(dir, '.env', 'API_KEY=valor-real-super-secreto\n');
    const res = inspectEnv(dir);
    const blob = JSON.stringify(res);
    expect(blob).not.toContain('valor-real-super-secreto');
    const v = res.vars.find((x) => x.key === 'API_KEY')!;
    expect(v).toMatchObject({ present: true, valid: true, secret: true });
  });
});

describe('validateEnv', () => {
  it('valida port/url/path/bool/number', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'APP_PORT=1\nBASE_URL=x\nDATA_DIR=x\nFEATURE_FLAG=x\nRETRIES=3\n');
    write(
      dir,
      '.env',
      'APP_PORT=70000\nBASE_URL=nao-eh-url\nDATA_DIR=\nFEATURE_FLAG=talvez\nRETRIES=abc\n',
    );
    const res = validateEnv(dir);
    expect(res.ok).toBe(false);
    const invalid = res.findings.filter((f) => f.kind === 'invalid').map((f) => f.key);
    expect(invalid).toEqual(
      expect.arrayContaining(['APP_PORT', 'BASE_URL', 'DATA_DIR', 'FEATURE_FLAG', 'RETRIES']),
    );
  });

  it('aceita valores válidos e detecta conflito de porta entre chaves', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'A_PORT=1\nB_PORT=2\nBASE_URL=x\nFEATURE_FLAG=x\n');
    write(dir, '.env', 'A_PORT=8080\nB_PORT=8080\nBASE_URL=https://x.dev/a\nFEATURE_FLAG=yes\n');
    const res = validateEnv(dir);
    expect(res.findings.filter((f) => f.kind === 'conflict').map((f) => f.key)).toEqual(['B_PORT']);
    expect(res.ok).toBe(false);
  });

  it('honra dependsOn (B exigida quando A definido)', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'A=x\n');
    write(dir, 'forge.env.schema.json', JSON.stringify({ vars: [{ key: 'B', dependsOn: 'A' }] }));
    write(dir, '.env', 'A=1\n');
    const res = validateEnv(dir);
    expect(res.findings.some((f) => f.kind === 'missing' && f.key === 'B')).toBe(true);
    write(dir, '.env', 'A=1\nB=2\n');
    expect(validateEnv(dir).findings.some((f) => f.kind === 'missing' && f.key === 'B')).toBe(
      false,
    );
  });

  it('falha quando .env ausente', () => {
    const res = validateEnv(tmpDir());
    expect(res.ok).toBe(false);
    expect(res.findings[0]).toMatchObject({ key: '.env', kind: 'missing' });
  });
});

describe('planMigration/applyMigration/rollbackEnv', () => {
  it('plano é aditivo: add ausentes, keep presentes, remove-requested para extras', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'APP_PORT=8080\nAPI_KEY=\n');
    write(dir, '.env', 'APP_PORT=9090\nEXTRA_USER=minha\n');
    const plan = planMigration(dir);
    const byKey = new Map(plan.actions.map((a) => [a.key, a]));
    expect(byKey.get('APP_PORT')?.kind).toBe('keep');
    expect(byKey.get('API_KEY')?.kind).toBe('add');
    expect(byKey.get('EXTRA_USER')?.kind).toBe('remove-requested');
    expect(plan.removesRequireApproval).toBe(true);
  });

  it('gera segredo aleatório para chave secreta vazia no exemplo', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'API_KEY=\nTOKEN=\nAPP_PORT=8080\n');
    const plan = planMigration(dir);
    const secret = plan.actions.find((a) => a.key === 'API_KEY')!;
    expect(secret.to).toMatch(/^[0-9a-f]{48}$/);
    const port = plan.actions.find((a) => a.key === 'APP_PORT')!;
    expect(port.to).toBe('8080');
  });

  it('apply aditivo preserva linhas/comentários e nunca remove sem autorização', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'APP_PORT=8080\nNEW_URL=x\n');
    write(dir, '.env', '# meu cabeçalho\nAPP_PORT=9090 # manter\nEXTRA_USER=minha\n');
    const res = applyMigration(dir, planMigration(dir), {});
    expect(res.applied).toEqual(['NEW_URL']);
    expect(res.skipped).toEqual(['EXTRA_USER']);
    const content = readFileSync(path.join(dir, '.env'), 'utf8');
    expect(content).toContain('# meu cabeçalho');
    expect(content).toContain('APP_PORT=9090 # manter');
    expect(content).toContain('EXTRA_USER=minha');
    expect(content).toContain('NEW_URL=x');
    expect(res.backup).toBeDefined();
    const backed = readFileSync(path.join(res.backup!, '.env'), 'utf8');
    expect(backed).toBe('# meu cabeçalho\nAPP_PORT=9090 # manter\nEXTRA_USER=minha\n');
  });

  it('remove solicitado só com authorizeRemoves', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'APP_PORT=8080\n');
    write(dir, '.env', 'APP_PORT=1\nEXTRA_USER=x\n');
    const res = applyMigration(dir, planMigration(dir), { authorizeRemoves: true });
    expect(res.applied).toContain('EXTRA_USER');
    const content = readFileSync(path.join(dir, '.env'), 'utf8');
    expect(content).not.toContain('EXTRA_USER');
    expect(content).toContain('APP_PORT=1');
  });

  it('dry-run não escreve nada nem cria backup', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'NEW_URL=x\n');
    write(dir, '.env', 'A=1\n');
    const before = readFileSync(path.join(dir, '.env'), 'utf8');
    const res = applyMigration(dir, planMigration(dir), { dryRun: true });
    expect(res.applied).toEqual([]);
    expect(readFileSync(path.join(dir, '.env'), 'utf8')).toBe(before);
    expect(latestEnvBackup(dir)).toBeNull();
  });

  it('rollback restaura bytes idênticos', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'NEW_URL=x\n');
    const original = 'A=1\n# nota\nEXTRA=y\n';
    write(dir, '.env', original);
    applyMigration(dir, planMigration(dir), {});
    const backup = latestEnvBackup(dir)!;
    expect(backup).toBeTruthy();
    expect(rollbackEnv(dir, backup)).toBe(true);
    expect(readFileSync(path.join(dir, '.env'), 'utf8')).toBe(original);
  });

  it('rollback retorna false sem backup', () => {
    expect(rollbackEnv(tmpDir(), path.join(tmpDir(), 'nada'))).toBe(false);
  });

  it('init cria .env do esquema sem sobrescrever existente', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'APP_PORT=8080\nAPI_KEY=\n');
    const res = applyMigration(dir, planMigration(dir), {});
    expect(res.applied).toEqual(['APP_PORT', 'API_KEY']);
    const content = readFileSync(path.join(dir, '.env'), 'utf8');
    expect(content).toContain('APP_PORT=8080');
    expect(content).toMatch(/API_KEY=[0-9a-f]{48}/);
  });
});

describe('envDoctor', () => {
  it('score e checks em repo saudável', () => {
    const dir = tmpDir();
    write(dir, '.env.example', 'APP_PORT=8080\n');
    write(dir, '.env', 'APP_PORT=9090\n');
    const res = envDoctor(dir);
    expect(res.state).toBe('complete');
    expect(res.score).toBe(100);
    expect(res.checks.every((c) => c.result === 'pass')).toBe(true);
  });

  it('falha em arquivo ausente e marca checks', () => {
    const res = envDoctor(tmpDir());
    expect(res.state).toBe('absent');
    expect(res.checks.find((c) => c.id === 'file-present')?.result).toBe('fail');
  });
});

describe('runEnvCommand', () => {
  const cliBase: CliOptions = {
    dir: undefined,
    all: false,
    yes: false,
    plan: false,
    skipScripts: false,
    skipVerify: false,
    timeoutSecs: 900,
    help: false,
    jsonReport: true,
    retryFailed: false,
    fix: false,
    timeoutSet: false,
    jsonSet: true,
    jobs: 1,
    jobsSet: false,
    onlyChanged: false,
    shallow: false,
    check: false,
    native: false,
    verbose: false,
    offline: false,
    clean: false,
    rollback: false,
    verify: false,
    trustCustom: false,
    runAfterSyncFailure: false,
    positionals: [],
  };

  function spyJson(): { out: () => string; restore: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      lines.push(String(msg));
    });
    return {
      out: () => lines.join('\n'),
      restore: () => spy.mockRestore(),
    };
  }

  it('retorna 2 para verbo desconhecido', async () => {
    const cli = { ...cliBase, dir: tmpDir() };
    expect(await runEnvCommand(cli, ['bogus'])).toBe(2);
  });

  it('inspect em JSON mascara valores secretos', async () => {
    const ws = tmpDir();
    mkdirSync(path.join(ws, 'myrepo'));
    write(path.join(ws, 'myrepo'), '.env.example', 'API_KEY=\n');
    write(path.join(ws, 'myrepo'), '.env', 'API_KEY=segredo-real-123456\n');
    const spy = spyJson();
    try {
      const code = await runEnvCommand({ ...cliBase, dir: ws }, ['inspect', 'myrepo']);
      expect(code).toBe(0);
      const blob = spy.out();
      expect(blob).not.toContain('segredo-real-123456');
      const parsed = JSON.parse(blob.trim().split('\n').at(-1)!);
      expect(parsed.state).toBe('complete');
    } finally {
      spy.restore();
    }
  });

  it('plan em JSON mascara o valor gerado de segredos', async () => {
    const ws = tmpDir();
    mkdirSync(path.join(ws, 'myrepo'));
    write(path.join(ws, 'myrepo'), '.env.example', 'API_KEY=\nAPP_PORT=8080\n');
    const spy = spyJson();
    try {
      const code = await runEnvCommand({ ...cliBase, dir: ws }, ['plan', 'myrepo']);
      expect(code).toBe(0);
      const blob = spy.out();
      expect(blob).not.toMatch(/[0-9a-f]{48}/);
      const parsed = JSON.parse(blob.trim().split('\n').at(-1)!);
      const add = parsed.actions.find((a: { key: string }) => a.key === 'API_KEY');
      expect(add.to).toBe('(valor oculto)');
    } finally {
      spy.restore();
    }
  });

  it('migrate --rollback via args restaura backup', async () => {
    const ws = tmpDir();
    const repo = path.join(ws, 'myrepo');
    mkdirSync(repo);
    write(repo, '.env.example', 'NEW_URL=x\n');
    write(repo, '.env', 'A=1\n');
    await runEnvCommand({ ...cliBase, dir: ws }, ['migrate', 'myrepo']);
    expect(readFileSync(path.join(repo, '.env'), 'utf8')).toContain('NEW_URL=x');
    const code = await runEnvCommand({ ...cliBase, dir: ws }, ['migrate', 'myrepo', '--rollback']);
    expect(code).toBe(0);
    expect(readFileSync(path.join(repo, '.env'), 'utf8')).toBe('A=1\n');
  });

  it('rejeita nome que escapa do diretório base', async () => {
    const cli = { ...cliBase, dir: tmpDir() };
    expect(await runEnvCommand(cli, ['inspect', '../evil'])).toBe(2);
  });
});

describe('paths com espaços e unicode', () => {
  it('funciona em diretório com espaços e acentos', () => {
    const base = tmpDir();
    const dir = path.join(base, 'meu repositório ção');
    mkdirSync(dir);
    write(dir, '.env.example', 'APP_PORT=8080\nNEW_URL=x\n');
    write(dir, '.env', 'APP_PORT=9090\n');
    expect(inspectEnv(dir).state).toBe('complete');
    const res = applyMigration(dir, planMigration(dir), {});
    expect(res.applied).toEqual(['NEW_URL']);
    expect(res.backup).toBeTruthy();
  });
});
