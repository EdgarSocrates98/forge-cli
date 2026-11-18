import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli-args.js';
import { FORGE_REPOS } from '../src/constants/repos.js';
import type { ForgeRepo } from '../src/types.js';
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
      'apiforge install [--scope --profile --components --host --gateway-profile --root --to --repo --purge]',
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
    // platform-forge declara --host no manifesto desde a paridade wave-14.
    expect(buildNativeInstall(platform, { host: 'claude' })?.ignored).toEqual([]);
    // Forja que NÃO declara a flag → ignored honesto, nunca repassada.
    const slim: ForgeRepo = {
      name: 'slim',
      url: 'https://example.test/slim',
      description: 'fake',
      kind: 'python',
      nativeInstall: { command: ['slim', 'install'], flags: ['scope', 'profile'] },
    };
    const built = buildNativeInstall(slim, { host: 'claude' });
    expect(built?.ignored).toEqual(['host']);
    expect(built?.argv).not.toContain('--host');
  });

  it('operações nativas: --dry-run sem aprovação, aplicam com aprovação', () => {
    expect(buildNativeOp(aws, 'update', false)).toEqual({
      argv: ['sparkforge-aws', 'update', '--dry-run'],
      dryRun: true,
      ignored: [],
    });
    expect(buildNativeOp(aws, 'uninstall', true)).toEqual({
      argv: ['sparkforge-aws', 'uninstall'],
      dryRun: false,
      ignored: [],
    });
    expect(buildNativeOp({ ...aws, nativeInstall: undefined }, 'update', true)).toBeNull();
  });
});

describe('wave-14: root/to/repo/purge no vocabulário nativo', () => {
  const aws = FORGE_REPOS.find((r) => r.name === 'spark-forge-aws')!;

  it('buildNativeInstall repassa --root <alvo> quando a Forja declara root', () => {
    const built = buildNativeInstall(aws, { root: '/ws/alvo', approve: true });
    expect(built?.argv).toEqual([
      'sparkforge-aws',
      'install',
      '--root',
      '/ws/alvo',
      '--yes',
    ]);
  });

  it('--root NÃO é repassado a Forja que não o declara (ignored honesto)', () => {
    const slim: ForgeRepo = {
      name: 'slim',
      url: 'https://example.test/slim',
      description: 'fake',
      kind: 'python',
      nativeInstall: { command: ['slim', 'install'], flags: ['scope'] },
    };
    const built = buildNativeInstall(slim, { root: '/ws/alvo' });
    expect(built?.ignored).toEqual(['root']);
    expect(built?.argv).not.toContain('--root');
  });

  it('update nativo aceita --root/--to/--repo declarados', () => {
    expect(
      buildNativeOp(aws, 'update', true, {
        root: '/ws/alvo',
        to: '1.2.3',
        repo: 'https://example.test/fork',
      }),
    ).toEqual({
      argv: [
        'sparkforge-aws',
        'update',
        '--root',
        '/ws/alvo',
        '--to',
        '1.2.3',
        '--repo',
        'https://example.test/fork',
      ],
      dryRun: false,
      ignored: [],
    });
  });

  it('uninstall nativo aceita --purge declarado; --to/--repo não se aplicam', () => {
    const built = buildNativeOp(aws, 'uninstall', true, {
      root: '/ws/alvo',
      purge: true,
      to: '9.9.9',
      repo: 'https://example.test/x',
    });
    expect(built?.argv).toEqual([
      'sparkforge-aws',
      'uninstall',
      '--root',
      '/ws/alvo',
      '--purge',
    ]);
    expect(built?.ignored).toEqual([]);
  });

  it('flags não declaradas caem em ignored mesmo no update', () => {
    const slim: ForgeRepo = {
      name: 'slim',
      url: 'https://example.test/slim',
      description: 'fake',
      kind: 'python',
      nativeInstall: {
        command: ['slim', 'install'],
        flags: ['scope'],
        ops: { update: ['slim', 'update'] },
      },
    };
    const built = buildNativeOp(slim, 'update', true, {
      root: '/r',
      to: '1.0.0',
      repo: 'https://x.test',
    });
    expect(built?.argv).toEqual(['slim', 'update']);
    expect(built?.ignored).toEqual(['root', 'to', 'repo']);
  });

  it('parser aceita --to/--repo/--purge e valida vazios', () => {
    const cli = parseCliArgs(['update', 'x', '--native', '--to', '1.2.3', '--repo', 'r', '--purge']);
    expect(cli.to).toBe('1.2.3');
    expect(cli.repo).toBe('r');
    expect(cli.purge).toBe(true);
    expect(() => parseCliArgs(['--to', ' '])).toThrow(/--to/);
    expect(() => parseCliArgs(['--repo', ' '])).toThrow(/--repo/);
  });
});
