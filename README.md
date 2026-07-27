# org-fleet

`org-fleet` manages a fleet of organizations whose repositories are already
described by `repo-fleet` manifests. It keeps the organization-level source of
truth in `org-fleet.json`, ensures each organization's manifest repository is
available locally, then delegates repository synchronization to `repo-fleet`.

## Manifest

Create `org-fleet.json` in a meta repository:

```json
{
  "version": 1,
  "workspace_root": "../..",
  "organizations": [
    {
      "id": "example-org",
      "vcs_provider": "github",
      "manifest_repo": {
        "remote": "git@github.com:example-org/meta.git",
        "local_path": "example-org/meta",
        "default_branch": "main"
      },
      "manifest_path": "repo-fleet.json"
    }
  ]
}
```

`workspace_root` is optional. When present, it is resolved relative to the
`org-fleet.json` file and becomes the base directory for organization manifest
repository paths.

## Commands

```bash
org-fleet list --manifest org-fleet.json
org-fleet validate --manifest org-fleet.json
org-fleet path example-org --manifest org-fleet.json
org-fleet sync --manifest org-fleet.json --dry-run
org-fleet sync --manifest org-fleet.json -- --dry-run
```

`sync` clones missing organization manifest repositories with Jujutsu when
available, fetches existing manifest repositories, then runs
`repo-fleet sync --manifest <repo-fleet.json>` for each organization. Arguments
after `--` are passed to `repo-fleet sync`.

## Development

```bash
npm test
npm run typecheck
nix flake check
```
