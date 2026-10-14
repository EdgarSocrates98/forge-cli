# Portability — export, lockfile, bundle, reproducible install (spec §6.6)

forge-cli makes a workspace reproducible offline: what is installed, at which
ref, under which env schema — exported as audited JSON documents, integrity
protected, never carrying secrets.

## Building blocks

| Artifact           | Producer                         | Contract                      |
| ------------------ | -------------------------------- | ----------------------------- |
| profile            | `exportProfile` (maintenance.ts) | `forge-cli/Profile/v1`        |
| env lockfile       | `writeEnvLock` / `checkEnvLock`  | `forge-cli/EnvLock/v1`        |
| integrity manifest | `portability/manifest.ts`        | `forge/IntegrityManifest/v1`  |
| offline bundle     | `portability/bundle.ts`          | `forge-cli/Bundle/v1`         |
| reinstall plan     | `planReinstall` → `buildPlan`    | `forge/ForgeOperationPlan/v1` |

### `forge/IntegrityManifest/v1`

`buildIntegrityManifest(entries, { now })` produces a deterministic document:
entries sorted by path, `bytes` + `sha256` per entry, and `digest` = sha256 of
the canonical JSON of the sorted entry list. `generatedAt` is injectable.

`verifyIntegrityManifest(manifest, read)` resolves each entry through a
`read(path)` callback and reports every problem instead of throwing:

- missing payload → the entry path is listed in `mismatches`;
- wrong size or hash → the entry path is listed;
- unsafe entry path (traversal, separators abuse) → listed **without** calling
  `read` — a hostile manifest cannot steer the verifier outside the bundle;
- tampered entry list → `<digest>` mismatch;
- malformed manifest → `<manifest>` mismatch.

## Bundle format — a directory, not a blob

`exportBundle(targetDir, repos, dest, { includeEnvKeys?, now? })` writes `dest`
as a directory of plain JSON files so every payload stays greppable and the
integrity manifest covers real on-disk bytes:

```
bundle.json          envelope: schema, generatedAt, produced file list
profile.json         forge-cli/Profile/v1 (repos, heads, pins)
env.lock.json        forge-cli/EnvLock/v1 written at export time
env.lock.check.json  LockCheck[] proving the lock was fresh on export
env-keys.json        { forge: [KEY, …] } — schema names only, sorted
env-values.json      whitelisted non-secret values (only when opted in)
pins.json            sorted [{ name, url, kind, version?, ref?, head? }]
integrity.json       forge/IntegrityManifest/v1 over every file above
```

Pin sources: `ref` from `.forge-cli/state.json` pins (falling back to the
recorded head), `version` from `forge.json` → `package.json` → `pyproject.toml`,
`url`/`kind` from the catalog entry. Determinism: all collections are sorted
and every timestamp comes from the injected `now` — two exports of the same
workspace with the same clock are byte-identical.

## Secrets policy — fail closed

Env **values** are never exported by default. `env-keys.json` carries only key
names (the env schema travels so a fresh machine knows what to ask for).

`includeEnvKeys` is the narrow, explicit escape hatch: a whitelist of key
names whose values may travel. The export **refuses before writing anything**
(`SecretKeysRefusedError`, `code: 'secret-keys-refused'`) when a whitelisted
key:

- matches the secret denylist `TOKEN|SECRET|KEY|PASSWORD|PRIVATE|CREDENTIAL`;
- or is marked `secret` by the derived env schema (catches innocuous names
  declared secret in `forge.env.schema.json`).

There is no way to opt a secret into a bundle — the denylist check runs on the
request, not on the values found on disk.

## Import + reinstall flow

`importBundle(src, { verifyIntegrity? })` reads the bundle directory and
verifies `integrity.json` against the real bytes before parsing. Malformed
payloads degrade to `null`/`[]` — verification still reports them; a hostile
or partial bundle never throws. `verifyIntegrity: false` exists for
forensics/inspection only and is explicit.

`planReinstall(bundle, { now?, targetDir? })` maps the verified pins to a
hashed `forge/ForgeOperationPlan/v1` — per forja: `clone` (or a non-reversible
`config` action when the bundle records no URL) → `sync` checkout of the
pinned ref → `env` provisioning note listing required key names. The plan is
deterministic under an injected clock and verifiable with `verifyPlan`.

## Migration flow

1. On the source machine: `exportBundle(targetDir, repos, dest)` — profile,
   fresh env lock + drift check, schema key names, pins, integrity manifest.
2. Move `dest/` (any transport — the bundle is offline by construction).
3. On the target machine: `importBundle(dest)` → `verify.ok` proves nothing
   was tampered with in transit.
4. `planReinstall(bundle)` → review the hashed plan (clone + pinned checkout +
   env keys to provision), approve, execute. `.env` values are re-entered or
   re-provisioned by the operator — the bundle intentionally cannot carry them
   (except the explicit non-secret whitelist above).
5. `checkEnvLock` on the restored workspace detects drift between the exported
   lock and the new checkouts.
