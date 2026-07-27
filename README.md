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
org-fleet orgs --manifest org-fleet.json
org-fleet validate --manifest org-fleet.json
org-fleet list --manifest org-fleet.json
org-fleet path example-org api --manifest org-fleet.json
org-fleet remotes --manifest org-fleet.json
org-fleet status --manifest org-fleet.json
org-fleet doctor --manifest org-fleet.json
org-fleet clone-missing --manifest org-fleet.json --dry-run
org-fleet sync --manifest org-fleet.json --dry-run
org-fleet sync --manifest org-fleet.json -- --dry-run
```

The repo-fleet-shaped commands run against every selected organization:
`list`, `validate`, `remotes`, `status`, `doctor`, `clone-missing`, and `sync`.
Use `--org ORG` to restrict the run to one organization. `path` takes an
organization id and a repo or worktree id, then delegates to that org's
`repo-fleet path`.

`clone-missing` and `sync` first make sure each organization manifest repository
is available locally. Missing manifest repositories are cloned with Jujutsu when
available, existing Jujutsu manifest repositories are fetched with
`jj git fetch`, and repo-fleet receives `--dry-run` when org-fleet does.
Arguments after `--` are passed to each repo-fleet invocation.

Use `orgs` and `manifest-path` for the organization index itself:

```bash
org-fleet orgs --manifest org-fleet.json
org-fleet manifest-path example-org --manifest org-fleet.json
```

## Development

```bash
npm test
npm run typecheck
nix flake check
```
