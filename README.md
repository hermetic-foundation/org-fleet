# org-fleet

`org-fleet` manages organizations whose repositories are already described by
`repo-fleet` manifests. The organization-level manifest only says which
organizations to visit and which repository/path contains each org's
`repo-fleet` manifest.

## Manifest

Create `org-fleet.json` in a meta repository:

```json
{
  "version": 1,
  "organizations": [
    {
      "id": "example-org",
      "repo_fleet_manifest": {
        "repository": "meta",
        "path": "repo-fleet.json"
      }
    }
  ]
}
```

For the example above, `org-fleet` derives the manifest repository remote as
`git@github.com:example-org/meta.git`, expects the local checkout at
`<workspace-root>/example-org/meta`, and runs `repo-fleet` against
`<workspace-root>/example-org/meta/repo-fleet.json`.

If an existing workspace uses a different checkout path for the manifest
repository, set `repo_fleet_manifest.checkout_path` to that relative path.

By default, `<workspace-root>` is two directories above `org-fleet.json`, which
matches a layout like `Projects/monarchic-meta/meta/org-fleet.json`. Override it
with `--workspace-root` when needed.

## Commands

```bash
org-fleet list --manifest org-fleet.json
org-fleet validate --manifest org-fleet.json
org-fleet path example-org --manifest org-fleet.json
org-fleet sync --manifest org-fleet.json --dry-run
org-fleet sync --manifest org-fleet.json -- --dry-run
```

`sync` loops through each organization, clones missing manifest repositories
with Jujutsu when available, fetches existing manifest repositories, then runs
`repo-fleet sync --manifest <repo-fleet.json>` for that organization. Arguments
after `--` are passed to each `repo-fleet sync` invocation.

## Development

```bash
npm test
npm run typecheck
nix flake check
```
