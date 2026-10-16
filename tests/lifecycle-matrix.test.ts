import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'index.ts');
const ANSI = new RegExp(String.raw`\[[0-9;]*m`, 'g');

let ws: string;
let home: string;
let remotes: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-mx-ws-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-mx-home-'));
  remotes = mkdtempSync(path.join(os.tmpdir(), 'forge-cli-mx-remote-'));
});
afterEach(() => {
  for (const d of [ws, home, remotes])
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function cli(...args: string[]) {
  const res = await execa('node', ['--import', 'tsx', ENTRY, ...args], {
    cwd: ROOT,
    reject: false,
    timeout: 60_000,
    stdin: 'ignore',
    env: { HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
    extendEnv: true,
  });
  const out = `${res.stdout}\n${res.stderr}`.replace(ANSI, '');
  return { code: res.exitCode ?? -1, out };
}

const git = (dir: string, ...a: string[]) =>
  execFileSync('git', ['-C', dir, ...a], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

function gitInit(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
}

function commit(dir: string, file: string, content: string, msg: string) {
  writeFileSync(path.join(dir, file), content);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Bare "remote" + linked work tree on local disk — pull works fully offline. */
function fakeRemote(name: string): {
  url: string;
  dir: string;
  publish: (m: string, c: string) => string;
} {
  const work = path.join(remotes, `${name}-work`);
  const bare = path.join(remotes, `${name}.git`);
  gitInit(work);
  writeFileSync(path.join(work, 'forge.json'), JSON.stringify({ forge_id: name }));
  commit(work, 'VERSION', '0.1.0\n', 'v0.1.0');
  execFileSync('git', ['clone', '-q', '--bare', work, bare], { stdio: 'ignore' });
  git(work, 'remote', 'add', 'origin', bare);
  return {
    url: bare,
    dir: work,
    publish: (file, content) => {
      const sha = commit(work, file, content, `bump ${file}`);
      git(work, 'push', '-q', 'origin', 'main');
      return sha;
    },
  };
}

const CATALOG_URLS: Record<string, string> = {
  'the-forge': 'https://github.com/EdgarSocrates98/the-forge',
  'api-forge': 'https://github.com/EdgarSocrates98/api-forge',
  'platform-forge': 'https://github.com/EdgarSocrates98/platform-forge',
  'spark-forge-aws': 'https://github.com/EdgarSocrates98/spark-forge-aws',
  'spark-forge-azure': 'https://github.com/EdgarSocrates98/spark-forge-azure',
  'forge-doctor-api': 'https://github.com/EdgarSocrates98/forge-doctor-api',
  'forge-doctor-data': 'https://github.com/EdgarSocrates98/forge-doctor-data',
  'forge-portal': 'https://github.com/EdgarSocrates98/forge-portal',
};

/**
 * Clone of a fake remote inside ws, as if `forge clone` had done it.
 * By default origin is rewritten to the catalog URL so the repo passes the
 * sameRemote safety check; fetch stays offline because only `--offline` /
 * fixed-ref paths are exercised. `keepLocalOrigin` keeps the local bare URL
 * to exercise the remote-mismatch refusal.
 */
function fakeClone(name: string, url: string, opts: { keepLocalOrigin?: boolean } = {}): string {
  const dir = path.join(ws, name);
  execFileSync('git', ['clone', '-q', url, dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  const catalog = CATALOG_URLS[name];
  if (catalog && !opts.keepLocalOrigin) git(dir, 'remote', 'set-url', 'origin', catalog);
  return dir;
}

function head(dir: string) {
  return git(dir, 'rev-parse', 'HEAD');
}

function state(dir: string) {
  return JSON.parse(readFileSync(path.join(dir, '.forge-cli', 'state.json'), 'utf8'));
}

function compatManifest(theForgeVersion: string) {
  return {
    schema: 'forge/EcosystemCompatibility/v1',
    release: '2026.10',
    created_at: '2026-10-15',
    producer: { id: 'the-forge', version: theForgeVersion },
    components: [
      {
        component: 'the-forge',
        version: theForgeVersion,
        scheme: 'semver',
        source: 'pyproject.toml',
      },
      { component: 'api-forge', version: '0.1.0', scheme: 'semver', source: 'pyproject.toml' },
    ],
    contracts: [
      {
        family: 'specialist_manifest',
        contract: 'theforge/ForgeManifest',
        min_major: 1,
        max_major: 1,
      },
    ],
  };
}

describe(
  'lifecycle matrix (§5.2) — update/downgrade/rollback/drift/partial',
  { timeout: 240_000 },
  () => {
    it('safety: update refuses to pull when origin does not match the catalog', async () => {
      // Clone keeps the local bare as origin — from the CLI's perspective this is
      // a remote substitution. The pull must be refused, not silently applied.
      const remote = fakeRemote('the-forge');
      const dir = fakeClone('the-forge', remote.url, { keepLocalOrigin: true });
      const v1 = head(dir);
      remote.publish('VERSION', '0.2.0\n');

      const r = await cli(
        'update',
        'the-forge',
        '--yes',
        '--skip-scripts',
        '--skip-verify',
        '--dir',
        ws,
      );
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/difere do catálogo|remote/i);
      expect(head(dir)).toBe(v1); // not pulled — tree untouched except .env scaffold
    });

    it('downgrade via pin + update --offline, then rollback returns to v2', async () => {
      const remote = fakeRemote('api-forge');
      const v2 = remote.publish('VERSION', '0.2.0\n');
      const dir = fakeClone('api-forge', remote.url);
      const log = git(dir, 'log', '--format=%H', 'HEAD');
      const v1 = log.split('\n')[1]; // parent = initial commit

      // Establish the recorded head first — previousHead requires a prior entry.
      const first = await cli(
        'update',
        'api-forge',
        '--offline',
        '--yes',
        '--skip-scripts',
        '--skip-verify',
        '--dir',
        ws,
      );
      expect(first.code).toBe(0);
      expect(head(dir)).toBe(v2);
      expect(state(ws).repos['api-forge'].head).toBe(v2);

      rmSync(path.join(dir, '.env'), { force: true }); // scaffolded by update → dirty
      const pin = await cli('pin', 'api-forge', '--ref', v1, '--dir', ws);
      expect(pin.code).toBe(0);

      const down = await cli(
        'update',
        'api-forge',
        '--offline',
        '--yes',
        '--skip-scripts',
        '--skip-verify',
        '--dir',
        ws,
      );
      expect(down.code).toBe(0);
      expect(head(dir)).toBe(v1);
      const st = state(ws).repos['api-forge'];
      expect(st.head).toBe(v1);
      expect(st.previousHead).toBe(v2);

      // The .env scaffolded by update leaves the tree dirty → rollback must refuse.
      const dirty = await cli('rollback', 'api-forge', '--dir', ws);
      expect(dirty.code).not.toBe(0);
      expect(head(dir)).toBe(v1);

      rmSync(path.join(dir, '.env'), { force: true }); // drop the scaffolded file
      const back = await cli('rollback', 'api-forge', '--dir', ws);
      expect(back.code).toBe(0);
      expect(head(dir)).toBe(v2);
    });

    it('partial failure: sibling with substituted remote is refused, sibling still updates', async () => {
      const good = fakeRemote('the-forge');
      good.publish('VERSION', '0.2.0\n');
      const goodDir = fakeClone('the-forge', good.url);
      const goodV1 = git(goodDir, 'log', '--format=%H', 'HEAD').split('\n')[1];
      const bad = fakeRemote('api-forge');
      const badDir = fakeClone('api-forge', bad.url, { keepLocalOrigin: true });
      const badHead = head(badDir);

      const pin = await cli('pin', 'the-forge', '--ref', goodV1, '--dir', ws);
      expect(pin.code).toBe(0);
      const r = await cli(
        'update',
        '--offline',
        '--yes',
        '--skip-scripts',
        '--skip-verify',
        '--dir',
        ws,
      );
      expect(r.out).toMatch(/api-forge/);
      expect(head(goodDir)).toBe(goodV1); // pinned ref applied despite sibling refusal
      expect(head(badDir)).toBe(badHead); // refused clone untouched
      expect(existsSync(path.join(badDir, 'forge.json'))).toBe(true);
    });

    it('uninstall removes a clean clone and leaves the sibling untouched', async () => {
      const remote = fakeRemote('platform-forge');
      fakeRemote('forge-doctor-data');
      const dir = fakeClone('platform-forge', remote.url);
      const keepDir = fakeClone('forge-doctor-data', path.join(remotes, 'forge-doctor-data.git'));

      const r = await cli('uninstall', 'platform-forge', '--yes', '--dir', ws);
      expect(r.code).toBe(0);
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(path.join(keepDir, 'forge.json'))).toBe(true);
    });

    it('drift: local commit after update marks the forge drifted in status --json', async () => {
      const remote = fakeRemote('the-forge');
      const dir = fakeClone('the-forge', remote.url);
      const r1 = await cli(
        'update',
        'the-forge',
        '--yes',
        '--skip-scripts',
        '--skip-verify',
        '--offline',
        '--dir',
        ws,
      );
      expect(r1.code).toBe(0);

      commit(dir, 'LOCAL.md', 'user change\n', 'local edit');
      const r2 = await cli('status', '--json', '--dir', ws);
      expect(r2.code).toBe(0);
      const parsed = JSON.parse(r2.out);
      const arr = Array.isArray(parsed) ? parsed : (parsed.repos ?? parsed.forges ?? []);
      const tf = arr.find((x: { name: string }) => x.name === 'the-forge');
      expect(tf).toBeTruthy();
      expect(tf.phase ?? tf.state).toBe('drifted');
    });

    it('version mismatch: update --check reports incompatible vs ecosystem manifest', async () => {
      const remote = fakeRemote('the-forge');
      const dir = fakeClone('the-forge', remote.url, { keepLocalOrigin: true });
      writeFileSync(
        path.join(dir, 'pyproject.toml'),
        '[project]\nname = "theforge"\nversion = "0.5.0"\n',
      );
      writeFileSync(
        path.join(dir, 'ecosystem-compatibility.json'),
        JSON.stringify(compatManifest('9.9.9')),
      );
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'meta');

      const r = await cli('update', '--check', '--json', '--dir', ws);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.out);
      const tf = (parsed.repos ?? []).find((x: { name: string }) => x.name === 'the-forge');
      expect(tf?.installed_compat).toBe('incompatible');
    });

    it('corrupted metadata: malformed ecosystem manifest degrades to manifest null', async () => {
      const remote = fakeRemote('the-forge');
      const dir = fakeClone('the-forge', remote.url, { keepLocalOrigin: true });
      writeFileSync(path.join(dir, 'ecosystem-compatibility.json'), '{broken json');

      const r = await cli('update', '--check', '--json', '--dir', ws);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.out);
      expect(parsed.manifest).toBeNull();
      expect((parsed.repos ?? []).length).toBeGreaterThan(0);
    });

    it('reinstall is idempotent — second run records same head, no duplicate state', async () => {
      const remote = fakeRemote('spark-forge-azure');
      const dir = fakeClone('spark-forge-azure', remote.url, { keepLocalOrigin: true });
      const h = head(dir);

      for (let i = 0; i < 2; i++) {
        const r = await cli(
          'reinstall',
          'spark-forge-azure',
          '--yes',
          '--skip-scripts',
          '--skip-verify',
          '--dir',
          ws,
        );
        expect(r.code).toBe(0);
      }
      expect(head(dir)).toBe(h);
      expect(state(ws).repos['spark-forge-azure'].head).toBe(h);
    });
  },
);
