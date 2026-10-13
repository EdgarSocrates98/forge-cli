import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli-args.js';
import { FORGE_REPOS } from '../src/constants/repos.js';
import {
  buildNativeInstall,
  buildNativeOp,
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
      const bin = repo.nativeInstall!.command[0];
      if (bin === '{python}') continue; // script do repositório, resolvido em runtime
      expect(bin).toBe(repo.verify![0]);
    }
  });
  it('forge-portal não declara instalador nativo; doctor-api usa o script documentado', () => {
    expect(FORGE_REPOS.find((r) => r.name === 'forge-portal')?.nativeInstall).toBeUndefined();
    expect(FORGE_REPOS.find((r) => r.name === 'forge-doctor-api')?.nativeInstall?.command).toEqual([
      '{python}',
      'scripts/forge_install.py',
      'install',
    ]);
  });
  it('toda Forja com instalador nativo declara update e uninstall', () => {
    for (const repo of FORGE_REPOS.filter((r) => r.nativeInstall)) {
      expect(repo.nativeInstall!.ops?.update?.length).toBeGreaterThan(0);
      expect(repo.nativeInstall!.ops?.uninstall?.length).toBeGreaterThan(0);
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
      'apiforge install [--scope --profile --components --host --gateway-profile]',
    );
    expect(lines.find((l) => l.startsWith('forge-portal'))).toContain('sem instalador nativo');
  });
});

describe('host, gateway-profile e operações nativas', () => {
  const aws = FORGE_REPOS.find((r) => r.name === 'spark-forge-aws')!;
  const platform = FORGE_REPOS.find((r) => r.name === 'platform-forge')!;

  it('valida host e gateway-profile', () => {
    expect(validateNativeOptions({ host: 'claude', gatewayProfile: 'economy' })).toBeNull();
    expect(validateNativeOptions({ host: 'vim' })).toMatch(/host/);
    expect(validateNativeOptions({ gatewayProfile: 'turbo' })).toMatch(/gateway-profile/);
  });

  it('repassa host/gateway só onde a Forja suporta', () => {
    expect(buildNativeInstall(aws, { host: 'claude', gatewayProfile: 'economy' })?.argv).toEqual([
      'sparkforge-aws',
      'install',
      '--host',
      'claude',
      '--gateway-profile',
      'economy',
      '--dry-run',
    ]);
    const built = buildNativeInstall(platform, { host: 'claude' });
    expect(built?.ignored).toEqual(['host']);
  });

  it('operações nativas: --dry-run sem aprovação, aplicam com aprovação', () => {
    expect(buildNativeOp(aws, 'update', false)).toEqual({
      argv: ['sparkforge-aws', 'update', '--dry-run'],
      dryRun: true,
    });
    expect(buildNativeOp(aws, 'uninstall', true)).toEqual({
      argv: ['sparkforge-aws', 'uninstall'],
      dryRun: false,
    });
    expect(buildNativeOp({ ...aws, nativeInstall: undefined }, 'update', true)).toBeNull();
  });
});
