# Portable distribution pack

`forge/PortableDistributionPack/v1` is a self-contained ZIP containing the built CLI, package metadata, README/license material, launchers for Node, Windows CMD and POSIX shells, and a manifest with byte sizes and SHA-256 digests.

```text
forge-cli pack create <artifact.zip> --dir <checkout>
forge-cli pack inspect <artifact.zip> --json
forge-cli pack verify <artifact.zip>
forge-cli pack import <artifact.zip> --dir <destination> --yes
```

ZIP entries are stored without compression so an independent verifier can validate them without npm or a third-party library. Import verifies every digest and refuses existing paths, traversal, duplicate entries, unsupported compression and manifest corruption. Import never runs package scripts.
