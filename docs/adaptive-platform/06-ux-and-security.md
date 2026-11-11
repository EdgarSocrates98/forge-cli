# UX and security

The adaptive commands use the existing Clack/picocolors presentation and preserve `--json` for automation. Human output is a compact table with state, kind, identity and capabilities. Refusals use stable prefixes such as `WORKSPACE-PROJECT-NOT-FOUND` and `FORGE-PACK-VERIFY-FAILED`.

Security properties:

- bounded traversal;
- no symlink/junction following;
- no dynamic execution from `forge.json`;
- no overwrite during portable import;
- checksum and size verification before extraction;
- plan output before `workspace use` mutation;
- existing secret-redaction and no-network discovery behavior preserved.
