# Workspace inventory contract

`forge/WorkspaceInventory/v1` is a read-only, bounded inventory. It supports git and gitless workspaces, Unicode and spaces, and never follows symlinks or junctions. Identity is explicit (`declared`, `derived`, `candidate`, `unknown`, `conflict`); a conflict becomes `DEGRADED` and is not silently promoted.

Commands:

```text
forge-cli workspace scan --dir <workspace> --json
forge-cli workspace list --dir <workspace>
forge-cli workspace status --dir <workspace>
forge-cli workspace doctor --dir <workspace>
forge-cli workspace use <project> --dir <workspace> --yes
```

`use` writes only `.forge-cli/workspace.json`, and only after an explicit `--yes`. It does not execute a manifest command.
