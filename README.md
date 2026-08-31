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

The organization manifest itself may be supplied as an evaluation-only flake
attribute such as `flake:.#orgFleetManifest`, exposed with:

```nix
orgFleetManifest = builtins.fromJSON (builtins.readFile ./org-fleet.json);
```

Organizations may also point directly at flake-backed repo-fleet data, avoiding
the manifest-repository clone bootstrap:

```json
{
  "id": "example-org",
  "repo_fleet_manifest": {
    "flake": "git+ssh://git@github.com/example-org/meta.git",
    "attribute": "repoFleetManifest"
  }
}
```

File pointers remain supported. Flake sources are resolved with
`nix eval --json` and substituters disabled, so resolution neither builds
packages nor queries private binary caches.

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
org-fleet sync --manifest org-fleet.json --notify-conflicts
org-fleet reconcile --manifest org-fleet.json
org-fleet reconcile --manifest org-fleet.json --write
```

The repo-fleet-shaped commands run against every selected organization:
`list`, `validate`, `remotes`, `status`, `doctor`, `clone-missing`, `sync`, and
`reconcile`.
Use `--org ORG` to restrict the run to one organization. `path` takes an
organization id and a repo or worktree id, then delegates to that org's
`repo-fleet path`.

`reconcile` compares each selected organization's upstream GitHub repository
inventory with its repo-fleet manifest. It is read-only by default (`--dry-run`
is an explicit alias); pass `--write` to let repo-fleet add missing entries.
`--write` and `--dry-run` are mutually exclusive. JSON output aggregates counts,
missing/stale/drift findings, additions, written manifests, and the underlying
per-organization results.

`clone-missing` and `sync` first make sure each organization manifest repository
is available locally. Missing manifest repositories are cloned with Jujutsu when
available, existing Jujutsu manifest repositories are fetched with
`jj git fetch`, and repo-fleet receives `--dry-run` when org-fleet does.
Repository sync uses repo-fleet's default rebase behavior; pass `--no-rebase`
to fetch without rebasing, or `--notify-conflicts` to send a libnotify
notification for each repository whose rebase leaves conflicts. Arguments after `--` are
passed to each repo-fleet invocation.

Manifest repository clone and fetch operations retain actionable diagnostics
and retry recognized transient network failures twice by default. Set
`ORG_FLEET_VCS_RETRIES` to override the retry count. Non-mutating commands
identify legacy manifests that have not been materialized and direct the user
to `sync` or `clone-missing`.

Delegated command failures report the selected repo-fleet executable, its exact
argument vector, exit status or launch error, and captured diagnostics. Set
`ORG_FLEET_REPO_FLEET_BIN` to select a repo-fleet executable explicitly.

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
