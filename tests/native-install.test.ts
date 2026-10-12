import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli-args.js';
import { FORGE_REPOS } from '../src/constants/repos.js';
import {
  buildNativeInstall,
  componentsLines,
  validateNativeOptions,
} from '../src/native-install.js';

describe('validateNativeOptions', () => {
  it('aceita valores conhecidos', () => {
    expect(
      validateNativeOptions({
        profile: 'recommended',
        scope: 'workspace',
        components: 'skills,mcp',
      }),
    ).toBeNull();
  });
  it('rejeita perfil, escopo e componentes inválidos ou perigosos', () => {
    expect(validateNativeOptions({ profile: 'max' })).toMatch(/profile/);
    expect(validateNativeOptions({ scope: 'global' })).toMatch(/scope/);
    expect(validateNativeOptions({ components: 'skills;rm -rf /' })).toMatch(/components/);
    expect(validateNativeOptions({ components: '--yes' })).toMatch(/components/);
  });
  it('é aplicado no parser da CLI', () => {
    expect(parseCliArgs(['install', 'x', '--profile', 'full']).profile).toBe('full');
    expect(() => parseCliArgs(['--profile', 'nope'])).toThrow();
  });
});

describe('catálogo: instalador nativo', () => {
  it('o binário nativo é o mesmo usado na verificação', () => {
    for (const repo of FORGE_REPOS.filter((r) => r.nativeInstall)) {
      expect(repo.nativeInstall!.command[0]).toBe(repo.verify![0]);
    }
  });
  it('forge-portal e forge-doctor-api não declaram instalador nativo (não documentado)', () => {
    for (const name of ['forge-portal', 'forge-doctor-api']) {
      expect(FORGE_REPOS.find((r) => r.name === name)?.nativeInstall).toBeUndefined();
    }
  });
  it('monta o comando só com flags suportadas', () => {
    const aws = FORGE_REPOS.find((r) => r.name === 'spark-forge-aws')!;
    expect(
      buildNativeInstall(aws, { profile: 'recommended', scope: 'project', components: 'skills' })
        ?.argv,
    ).toEqual([
      'sparkforge-aws',
      'install',
      '--scope',
      'project',
      '--profile',
      'recommended',
      '--components',
      'skills',
      '--dry-run',
    ]);
  });
});

describe('componentsLines', () => {
  it('lista flags suportadas e marca Forjas sem instalador nativo', () => {
    const lines = componentsLines(FORGE_REPOS);
    expect(lines).toHaveLength(FORGE_REPOS.length);
    expect(lines.find((l) => l.startsWith('api-forge'))).toContain(
      'apiforge install [--scope --profile --components]',
    );
    expect(lines.find((l) => l.startsWith('forge-portal'))).toContain('sem instalador nativo');
  });
});
