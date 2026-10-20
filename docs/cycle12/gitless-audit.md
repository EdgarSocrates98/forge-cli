# Cycle 12.1 — Gitless Installation Audit

Evidence audit of how each repo treats directories **without `.git`** today.
Audit date: 2026-10-20. Sources: source inspection + `sha256sum` runs on
this machine; commits listed per repo.

## Vendored-installer architecture (context)

`the-forge/scripts/installkit/` is the canonical source for
`forge_bootstrap.py`, `forge.json`, `install.sh`, `install.ps1`,
`setup.sh`, `setup.ps1`, `<pkg>/_installkit.py`; `scripts/installkit/vendor.py`
propagates and has a `--check` drift gate (`vendor.py:189-245`).

Byte-identity verified 2026-10-20:

- `scripts/forge_bootstrap.py` — 8 copies (7 forges + canonical) sha256
  `dbcc32580802…` **all identical** (1013 lines each).
- `*/_installkit.py` — 7 vendored copies stamped `_SOURCE_SHA256 =
"bc189dd2ae0028ce"`; canonical holds `"canonical"`.
- `*/_forge_portal.py` — 8 copies (7 forges + `forge-portal/portal_core/`
  canonical) sha256 `fed7e298fc06…` **all identical** (1162 lines each).
- `data-sentinel-forge` — not part of the vendored fleet (no installkit,
  no `_forge_portal.py`, no `forge.json`).

## Per-repo findings

| Repo                | Commit  | `.git` required for install?                                                        | `git` calls in installer                                                                    | States distinguishable today                                                                               |
| ------------------- | ------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| forge-cli           | f4e340f | yes — `hasGitRepo(dir)` = `existsSync(dir/.git)` (`src/utils/system.ts:29-31`)      | clone/pull/fetch/rev-parse/checkout (`system.ts:150-236`, `git-revs.ts:28-86`)              | GIT_REPOSITORY (`.git` exists) vs _everything-else_ (`non-git` label)                                      |
| the-forge           | 6f322af | **no** — `load_config` only needs valid `forge.json` (`forge_bootstrap.py:116-131`) | best-effort `git rev-parse` for receipt stamping only, `None` on failure (`:862-874`)       | GIT_REPO vs GITLESS-with-valid-forge.json — **implicitly supported by bootstrap but not classified/named** |
| spark-forge-aws     | cae545b | no (same bootstrap)                                                                 | same stamping-only pattern                                                                  | same                                                                                                       |
| spark-forge-azure   | 447a2e4 | no                                                                                  | same                                                                                        | same                                                                                                       |
| api-forge           | fee6e7f | no                                                                                  | same                                                                                        | same                                                                                                       |
| platform-forge      | 1fbf34d | no                                                                                  | same                                                                                        | same                                                                                                       |
| forge-doctor-api    | 0c94bc3 | no                                                                                  | same; extra `scripts/forge_install.py` lifecycle adapter also uses `forge.json`, not `.git` | same                                                                                                       |
| forge-doctor-data   | 4c8c7ff | no                                                                                  | same                                                                                        | same                                                                                                       |
| forge-portal        | 9d997d2 | n/a — npm install, no Python installer                                              | n/a                                                                                         | n/a                                                                                                        |
| data-sentinel-forge | e67d8a6 | n/a — `uv sync`/`pip install .`, no installer                                       | n/a                                                                                         | n/a                                                                                                        |

## forge-cli detail (the gitless gap owner)

- `.git` detection is **existence-only** (`src/utils/system.ts:29-31`); no
  manifest validation, no checksum, no state taxonomy.
- `git` is spawned at ~20 sites: `status --porcelain`, `rev-parse HEAD`,
  `remote get-url`, `fetch --quiet --tags`, `pull --ff-only`,
  `clone [--depth 1]`, `rev-list`, `tag --list`, `ls-remote --tags`,
  `checkout --detach`, `describe --tags` (`system.ts:150-236`,
  `git-revs.ts:28-86`, `status.ts:38`, `cmd/intel.ts:203-206`).
- `isSafeRepoUrl` (`src/safety.ts:20-33`) accepts only https/ssh/scp —
  **no `file://` or local path sources**; `registryInstall` takes a
  `RegistryEntry`, never a filesystem path (`src/registry/install.ts:627`).
- `install` on a non-catalog positional arg exits 2 with
  `sem dist no catálogo registry — use o método git`
  (`src/cmd/registry.ts:293-298`) → a local dir arg is **rejected, not
  gitless-installed**.
- `planUninstall` **refuses** non-git dirs (`reason:'non-git'`,
  `lifecycle.ts:35`) — gitless dirs are never rm'ed (safe but means
  gitless lifecycle verbs don't exist).
- `doctor` legacy path skips non-git dirs (`doctor.ts:28-30`);
  `doctor2` flags recorded-but-gitless checkouts as
  `installation.checkouts.present` warn (`doctor2/domains.ts:439-487`).
- `update` on non-git → `'not-installed'` (`cmd/query.ts:204-207`).

## Gaps vs FASE 1 state list

Required states: GIT_REPOSITORY, GIT_WORKTREE, GITLESS_VALID_FORGE,
GITLESS_PARTIAL_FORGE, UNKNOWN_DIRECTORY, CONFLICTING_IDENTITY,
INVALID_MANIFEST, UNTRUSTED_SOURCE.

| State                 | Today                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GIT_REPOSITORY        | detected (`.git` exists)                                                                                                                                                              |
| GIT_WORKTREE          | **not distinguished** — `.git` file (worktree link) treated same as `.git` dir                                                                                                        |
| GITLESS_VALID_FORGE   | **not detected** — bootstrap would succeed but forge-cli never reaches it (local path rejected at arg parse); install.sh run manually would work via bootstrap's forge.json-only path |
| GITLESS_PARTIAL_FORGE | not detected — no partial-manifest concept                                                                                                                                            |
| UNKNOWN_DIRECTORY     | collapses into `non-git` label                                                                                                                                                        |
| CONFLICTING_IDENTITY  | not detected — manifest-vs-structure never compared                                                                                                                                   |
| INVALID_MANIFEST      | `manifest.ts:21-47` validates `forge_id`/`cli`/`mcp_command` shape only when read; not surfaced as an install-blocking verdict                                                        |
| UNTRUSTED_SOURCE      | no trust model exists                                                                                                                                                                 |

**Key finding**: the Python bootstrap already tolerates gitless dirs
(`forge.json` suffices, `git` calls are best-effort stamps). The gap is
entirely in **forge-cli routing + classification + lifecycle verbs** —
`install <dir>` can't reach the bootstrap path, `doctor`/`update`/
`uninstall` treat gitless as foreign.

## Existing tests

- `tests/lifecycle.test.ts:57-61` — non-git dir → uninstall `refused/non-git`.
- `tests/runner.test.ts:89-95,425-430` — existing non-git dir → `S.nonGitDir` warn.
- `tests/wizard.test.ts:54-65` — non-git dir still plans `git clone`.
- `tests/registry-lifecycle.test.ts:419-423` — `pinMethodFor` routes
  `.git`-absent + receipt → `registry`.
- the-forge: `tests/test_installkit*.py`, `test_install_e2e.py` — bootstrap
  lifecycle including vendored-kit sha256 gate (`test_install_orchestration.py:48-58`).
- No test installs from a local gitless dir (feature absent).
