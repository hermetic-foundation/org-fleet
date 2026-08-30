import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main, planForOrg } from "../bin/org-fleet.ts";
import {
  loadManifest,
  manifestRepoPath,
  repoFleetManifestPath,
  resolveWorkspaceRoot,
  validateManifestData,
} from "../src/manifest.ts";
import type { ManifestData } from "../src/manifest.ts";

function captureConsole(action: () => number): { status: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => stdout.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => stderr.push(values.map(String).join(" "));
  try {
    return { status: action(), stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function validManifest(): ManifestData {
  return {
    version: 1,
    organizations: [
      {
        id: "example-org",
        repo_fleet_manifest: {
          repository: "meta",
          path: "repo-fleet.json",
        },
      },
    ],
  };
}

test("valid manifest has no errors", () => {
  assert.deepEqual(validateManifestData(validManifest()), []);
});

test("org manifest accepts flake-backed repo-fleet pointers", () => {
  const manifest = validManifest();
  manifest.organizations[0].repo_fleet_manifest = {
    flake: "git+ssh://git@github.com/example-org/meta.git",
    attribute: "repoFleetManifest",
  };
  assert.deepEqual(validateManifestData(manifest), []);
});

test("loadManifest evaluates explicit flake sources without building", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const fakeBin = path.join(root, "bin");
  const argsPath = path.join(root, "nix.args");
  mkdirSync(fakeBin);
  writeFileSync(
    path.join(fakeBin, "nix"),
    `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(argsPath)}\nprintf '%s\\n' ${JSON.stringify(JSON.stringify(validManifest()))}\n`,
    "utf8",
  );
  chmodSync(path.join(fakeBin, "nix"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
  try {
    const manifest = loadManifest("flake:github:example/meta#orgFleetManifest");
    assert.equal(manifest.organizations[0].id, "example-org");
    assert.equal(readFileSync(argsPath, "utf8").trim(), "eval --option substituters  --json github:example/meta#orgFleetManifest");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("flake-backed repo-fleet pointers delegate without cloning a manifest repository", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "repo-fleet.log");
  mkdirSync(binDir);
  const repoFleet = path.join(binDir, "repo-fleet");
  writeFileSync(repoFleet, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(logPath)}\n`, "utf8");
  chmodSync(repoFleet, 0o755);
  const manifest = validManifest();
  manifest.organizations[0].repo_fleet_manifest = { flake: "github:example-org/meta", attribute: "repoFleetManifest" };
  const manifestPath = path.join(root, "org-fleet.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  const previousBin = process.env.ORG_FLEET_REPO_FLEET_BIN;
  process.env.ORG_FLEET_REPO_FLEET_BIN = repoFleet;
  try {
    assert.equal(main(["sync", "--manifest", manifestPath, "--workspace-root", root]), 0);
    const invocation = readFileSync(logPath, "utf8");
    assert.match(invocation, /--manifest flake:github:example-org\/meta#repoFleetManifest/);
    assert.match(invocation, new RegExp(`--workspace-root ${path.join(root, "example-org")}`));
  } finally {
    if (previousBin === undefined) delete process.env.ORG_FLEET_REPO_FLEET_BIN;
    else process.env.ORG_FLEET_REPO_FLEET_BIN = previousBin;
  }
});

test("duplicate organization ids are rejected", () => {
  const manifest = validManifest();
  manifest.organizations.push({
    ...manifest.organizations[0],
  });

  const errors = validateManifestData(manifest);

  assert.ok(errors.some((error) => error.includes("duplicates example-org")));
});

test("absolute paths are rejected", () => {
  const manifest = validManifest();
  manifest.organizations[0].repo_fleet_manifest.path = "/tmp/repo-fleet.json";

  const errors = validateManifestData(manifest);

  assert.ok(errors.some((error) => error.includes("repo_fleet_manifest.path must be relative")));
});

test("absolute checkout paths are rejected", () => {
  const manifest = validManifest();
  manifest.organizations[0].repo_fleet_manifest.checkout_path = "/tmp/example-org/meta";

  const errors = validateManifestData(manifest);

  assert.ok(errors.some((error) => error.includes("repo_fleet_manifest.checkout_path must be relative")));
});

test("manifest paths resolve from workspace root and manifest repository", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const manifestPath = path.join(root, "monarchic-meta", "meta", "org-fleet.json");
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(validManifest()), "utf8");

  const manifest = loadManifest(manifestPath);
  const workspaceRoot = resolveWorkspaceRoot(manifest);
  const org = manifest.organizations[0];

  assert.equal(workspaceRoot, root);
  assert.equal(manifestRepoPath(org, workspaceRoot), path.join(root, "example-org", "meta"));
  assert.equal(repoFleetManifestPath(org, workspaceRoot), path.join(root, "example-org", "meta", "repo-fleet.json"));
});

test("manifest repository checkout path can be overridden", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const manifestPath = path.join(root, "monarchic-meta", "meta", "org-fleet.json");
  const data = validManifest();
  data.organizations[0].repo_fleet_manifest.checkout_path = "example-org/meta/meta";
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(data), "utf8");

  const manifest = loadManifest(manifestPath);
  const workspaceRoot = resolveWorkspaceRoot(manifest);
  const org = manifest.organizations[0];

  assert.equal(manifestRepoPath(org, workspaceRoot), path.join(root, "example-org", "meta", "meta"));
  assert.equal(repoFleetManifestPath(org, workspaceRoot), path.join(root, "example-org", "meta", "meta", "repo-fleet.json"));
});

test("sync dry-run plans a clone for missing manifest repository", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const manifestPath = path.join(root, "org-fleet.json");
  const manifest = validManifest();
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

  assert.equal(main(["sync", "--manifest", manifestPath, "--workspace-root", root, "--dry-run"]), 0);
});

test("plan reports missing repo-fleet manifest in existing manifest repository", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const manifestPath = path.join(root, "org-fleet.json");
  const data = validManifest();
  writeFileSync(manifestPath, JSON.stringify(data), "utf8");
  const manifest = loadManifest(manifestPath);
  const org = manifest.organizations[0];
  const repoPath = manifestRepoPath(org, root);
  mkdirSync(path.join(repoPath, ".git"), { recursive: true });

  const plan = planForOrg(org, root);

  assert.equal(plan.ok, false);
  assert.equal(plan.error, "repo-fleet manifest is not materialized; run org-fleet sync or clone-missing first");
});

test("sync invokes repo-fleet for organizations with manifests", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const binDir = path.join(root, "bin");
  mkdirSync(binDir);
  const repoFleet = path.join(binDir, "repo-fleet");
  const logPath = path.join(root, "repo-fleet.log");
  writeFileSync(
    repoFleet,
    `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(logPath)}\nexit 0\n`,
    "utf8",
  );
  chmodSync(repoFleet, 0o755);

  const data = validManifest();
  const remotePath = path.join(root, "remote.git");
  const manifestPath = path.join(root, "org-fleet.json");
  writeFileSync(manifestPath, JSON.stringify(data), "utf8");
  execFileSync("git", ["init", "--bare", remotePath], { stdio: "ignore" });
  const orgMeta = path.join(root, "example-org", "meta");
  execFileSync("git", ["clone", remotePath, orgMeta], { stdio: "ignore" });
  writeFileSync(path.join(orgMeta, "repo-fleet.json"), JSON.stringify({ version: 1 }), "utf8");

  const previousBin = process.env.ORG_FLEET_REPO_FLEET_BIN;
  process.env.ORG_FLEET_REPO_FLEET_BIN = repoFleet;
  try {
    assert.equal(main(["sync", "--manifest", manifestPath, "--workspace-root", root]), 0);
  } finally {
    if (previousBin === undefined) {
      delete process.env.ORG_FLEET_REPO_FLEET_BIN;
    } else {
      process.env.ORG_FLEET_REPO_FLEET_BIN = previousBin;
    }
  }
});

test("sync forwards top-level rebase flags to repo-fleet", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const binDir = path.join(root, "bin");
  mkdirSync(binDir);
  const repoFleet = path.join(binDir, "repo-fleet");
  const logPath = path.join(root, "repo-fleet.log");
  writeFileSync(
    repoFleet,
    `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(logPath)}\nexit 0\n`,
    "utf8",
  );
  chmodSync(repoFleet, 0o755);

  const data = validManifest();
  const manifestPath = path.join(root, "org-fleet.json");
  writeFileSync(manifestPath, JSON.stringify(data), "utf8");
  const orgMeta = path.join(root, "example-org", "meta");
  mkdirSync(path.join(orgMeta, ".git"), { recursive: true });
  writeFileSync(path.join(orgMeta, "repo-fleet.json"), JSON.stringify({ version: 1 }), "utf8");

  const previousBin = process.env.ORG_FLEET_REPO_FLEET_BIN;
  process.env.ORG_FLEET_REPO_FLEET_BIN = repoFleet;
  try {
    assert.equal(main([
      "sync",
      "--manifest", manifestPath,
      "--workspace-root", root,
      "--dry-run",
      "--no-rebase",
      "--notify-conflicts",
    ]), 0);
  } finally {
    if (previousBin === undefined) {
      delete process.env.ORG_FLEET_REPO_FLEET_BIN;
    } else {
      process.env.ORG_FLEET_REPO_FLEET_BIN = previousBin;
    }
  }

  const invocation = readFileSync(logPath, "utf8");
  assert.match(invocation, /--no-rebase/);
  assert.match(invocation, /--notify-conflicts/);
});

test("orgs lists organization manifest pointers", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const manifestPath = path.join(root, "org-fleet.json");
  const data = validManifest();
  writeFileSync(manifestPath, JSON.stringify(data), "utf8");

  assert.equal(main(["orgs", "--manifest", manifestPath, "--workspace-root", root, "--json"]), 0);
});

test("list aggregates repo-fleet list output", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const binDir = path.join(root, "bin");
  mkdirSync(binDir);
  const repoFleet = path.join(binDir, "repo-fleet");
  writeFileSync(
    repoFleet,
    "#!/bin/sh\nif [ \"$1\" = list ]; then printf '[{\"id\":\"api\"}]\\n'; exit 0; fi\nexit 1\n",
    "utf8",
  );
  chmodSync(repoFleet, 0o755);
  const data = validManifest();
  const manifestPath = path.join(root, "org-fleet.json");
  writeFileSync(manifestPath, JSON.stringify(data), "utf8");
  const orgMeta = path.join(root, "example-org", "meta");
  mkdirSync(path.join(orgMeta, ".git"), { recursive: true });
  writeFileSync(path.join(orgMeta, "repo-fleet.json"), JSON.stringify({ version: 1 }), "utf8");

  const previousBin = process.env.ORG_FLEET_REPO_FLEET_BIN;
  process.env.ORG_FLEET_REPO_FLEET_BIN = repoFleet;
  try {
    assert.equal(main(["list", "--manifest", manifestPath, "--workspace-root", root, "--json"]), 0);
  } finally {
    if (previousBin === undefined) {
      delete process.env.ORG_FLEET_REPO_FLEET_BIN;
    } else {
      process.env.ORG_FLEET_REPO_FLEET_BIN = previousBin;
    }
  }
});

test("path delegates to a selected organization's repo-fleet manifest", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const binDir = path.join(root, "bin");
  mkdirSync(binDir);
  const repoFleet = path.join(binDir, "repo-fleet");
  const repoPath = path.join(root, "example-org", "api");
  writeFileSync(repoFleet, `#!/bin/sh\nif [ "$1" = path ]; then printf '%s\\n' ${JSON.stringify(repoPath)}; exit 0; fi\nexit 1\n`, "utf8");
  chmodSync(repoFleet, 0o755);
  const data = validManifest();
  const manifestPath = path.join(root, "org-fleet.json");
  writeFileSync(manifestPath, JSON.stringify(data), "utf8");
  const orgMeta = path.join(root, "example-org", "meta");
  mkdirSync(path.join(orgMeta, ".git"), { recursive: true });
  writeFileSync(path.join(orgMeta, "repo-fleet.json"), JSON.stringify({ version: 1 }), "utf8");

  const previousBin = process.env.ORG_FLEET_REPO_FLEET_BIN;
  process.env.ORG_FLEET_REPO_FLEET_BIN = repoFleet;
  try {
    assert.equal(main(["path", "example-org", "api", "--manifest", manifestPath, "--workspace-root", root, "--json"]), 0);
  } finally {
    if (previousBin === undefined) {
      delete process.env.ORG_FLEET_REPO_FLEET_BIN;
    } else {
      process.env.ORG_FLEET_REPO_FLEET_BIN = previousBin;
    }
  }
});

test("delegation reports repo-fleet executable launch errors and exact arguments", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const manifestPath = path.join(root, "org-fleet.json");
  const missingExecutable = path.join(root, "missing", "repo-fleet");
  writeFileSync(manifestPath, JSON.stringify(validManifest()), "utf8");
  const orgMeta = path.join(root, "example-org", "meta");
  mkdirSync(path.join(orgMeta, ".git"), { recursive: true });
  writeFileSync(path.join(orgMeta, "repo-fleet.json"), JSON.stringify({ version: 1 }), "utf8");

  const previousBin = process.env.ORG_FLEET_REPO_FLEET_BIN;
  process.env.ORG_FLEET_REPO_FLEET_BIN = missingExecutable;
  try {
    const captured = captureConsole(() => main(["list", "--manifest", manifestPath, "--workspace-root", root, "--json"]));
    assert.equal(captured.status, 1);
    assert.equal(captured.stderr, "");
    const output = JSON.parse(captured.stdout) as Array<{ error: string; stderr: null }>;
    assert.equal(output.length, 1);
    assert.match(output[0].error, /failed to launch repo-fleet executable/);
    assert.match(output[0].error, new RegExp(missingExecutable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(output[0].error, /\["list","--manifest"/);
    assert.match(output[0].error, /ENOENT/);
    assert.equal(output[0].stderr, null);
  } finally {
    if (previousBin === undefined) delete process.env.ORG_FLEET_REPO_FLEET_BIN;
    else process.env.ORG_FLEET_REPO_FLEET_BIN = previousBin;
  }
});

test("delegation preserves repo-fleet stdout and stderr on nonzero exit", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const binDir = path.join(root, "bin");
  const repoFleet = path.join(binDir, "repo-fleet");
  mkdirSync(binDir);
  writeFileSync(repoFleet, "#!/bin/sh\nprintf 'partial output\\n'\nprintf 'specific failure\\n' >&2\nexit 3\n", "utf8");
  chmodSync(repoFleet, 0o755);
  const manifestPath = path.join(root, "org-fleet.json");
  writeFileSync(manifestPath, JSON.stringify(validManifest()), "utf8");
  const orgMeta = path.join(root, "example-org", "meta");
  mkdirSync(path.join(orgMeta, ".git"), { recursive: true });
  writeFileSync(path.join(orgMeta, "repo-fleet.json"), JSON.stringify({ version: 1 }), "utf8");

  const previousBin = process.env.ORG_FLEET_REPO_FLEET_BIN;
  process.env.ORG_FLEET_REPO_FLEET_BIN = repoFleet;
  try {
    const captured = captureConsole(() => main(["list", "--manifest", manifestPath, "--workspace-root", root, "--json"]));
    assert.equal(captured.status, 1);
    const output = JSON.parse(captured.stdout) as Array<{ output: string; stderr: string }>;
    assert.equal(output[0].output, "partial output");
    assert.equal(output[0].stderr, "specific failure");
  } finally {
    if (previousBin === undefined) delete process.env.ORG_FLEET_REPO_FLEET_BIN;
    else process.env.ORG_FLEET_REPO_FLEET_BIN = previousBin;
  }
});

test("reconcile aggregates repo-fleet inventory results and passes --write", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const binDir = path.join(root, "bin");
  const repoFleet = path.join(binDir, "repo-fleet");
  const invocationPath = path.join(root, "repo-fleet.args");
  mkdirSync(binDir);
  const repoOutput = {
    organization: "example-org",
    upstream_repository_count: 3,
    manifest_repository_count: 2,
    missing: [{ name: "new-repo", proposed: { id: "new-repo" } }],
    stale: [],
    metadata_drift: [],
    added: ["new-repo"],
    wrote_manifest: true,
    ok: true,
  };
  writeFileSync(
    repoFleet,
    `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(invocationPath)}\nprintf '%s\\n' ${JSON.stringify(JSON.stringify(repoOutput))}\n`,
    "utf8",
  );
  chmodSync(repoFleet, 0o755);
  const manifest = validManifest();
  manifest.organizations[0].repo_fleet_manifest = { flake: "github:example-org/meta", attribute: "repoFleetManifest" };
  const manifestPath = path.join(root, "org-fleet.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

  const previousBin = process.env.ORG_FLEET_REPO_FLEET_BIN;
  process.env.ORG_FLEET_REPO_FLEET_BIN = repoFleet;
  try {
    const captured = captureConsole(() => main([
      "reconcile",
      "--manifest", manifestPath,
      "--workspace-root", root,
      "--write",
      "--json",
    ]));
    assert.equal(captured.status, 0);
    const output = JSON.parse(captured.stdout) as {
      ok: boolean;
      organizations: number;
      upstream_repository_count: number;
      manifest_repository_count: number;
      missing: Array<{ name: string; organization: string }>;
      added: Array<{ id: string; organization: string }>;
      wrote_manifests: string[];
      results: Array<{ organization: string; wrote_manifest: boolean }>;
    };
    assert.equal(output.ok, true);
    assert.equal(output.organizations, 1);
    assert.equal(output.upstream_repository_count, 3);
    assert.equal(output.manifest_repository_count, 2);
    assert.deepEqual(output.missing, [{ name: "new-repo", proposed: { id: "new-repo" }, organization: "example-org" }]);
    assert.deepEqual(output.added, [{ name: "new-repo", organization: "example-org" }]);
    assert.deepEqual(output.wrote_manifests, ["example-org"]);
    assert.equal(output.results[0].organization, "example-org");
    assert.equal(output.results[0].wrote_manifest, true);
    const invocation = readFileSync(invocationPath, "utf8").trim();
    assert.match(invocation, /^reconcile --manifest flake:github:example-org\/meta#repoFleetManifest /);
    assert.match(invocation, /--write/);
    assert.match(invocation, /--json/);
  } finally {
    if (previousBin === undefined) delete process.env.ORG_FLEET_REPO_FLEET_BIN;
    else process.env.ORG_FLEET_REPO_FLEET_BIN = previousBin;
  }
});

test("reconcile is read-only by default and rejects conflicting modes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "org-fleet-"));
  const binDir = path.join(root, "bin");
  const repoFleet = path.join(binDir, "repo-fleet");
  const invocationPath = path.join(root, "repo-fleet.args");
  mkdirSync(binDir);
  writeFileSync(
    repoFleet,
    `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(invocationPath)}\nprintf '{"organization":"example-org","upstream_repository_count":0,"manifest_repository_count":0,"missing":[],"stale":[],"metadata_drift":[],"added":[],"wrote_manifest":false,"ok":true}\\n'\n`,
    "utf8",
  );
  chmodSync(repoFleet, 0o755);
  const manifest = validManifest();
  manifest.organizations[0].repo_fleet_manifest = { flake: "github:example-org/meta" };
  const manifestPath = path.join(root, "org-fleet.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

  const previousBin = process.env.ORG_FLEET_REPO_FLEET_BIN;
  process.env.ORG_FLEET_REPO_FLEET_BIN = repoFleet;
  try {
    const readOnly = captureConsole(() => main(["reconcile", "--manifest", manifestPath, "--workspace-root", root, "--json"]));
    assert.equal(readOnly.status, 0);
    const invocation = readFileSync(invocationPath, "utf8");
    assert.doesNotMatch(invocation, /--write|--dry-run/);

    const dryRun = captureConsole(() => main([
      "reconcile",
      "--manifest", manifestPath,
      "--workspace-root", root,
      "--dry-run",
      "--json",
    ]));
    assert.equal(dryRun.status, 0);
    assert.match(readFileSync(invocationPath, "utf8"), /--dry-run/);

    const conflicting = captureConsole(() => main(["reconcile", "--write", "--dry-run"]));
    assert.equal(conflicting.status, 2);
    assert.match(conflicting.stderr, /--write and --dry-run are mutually exclusive/);
  } finally {
    if (previousBin === undefined) delete process.env.ORG_FLEET_REPO_FLEET_BIN;
    else process.env.ORG_FLEET_REPO_FLEET_BIN = previousBin;
  }
});
