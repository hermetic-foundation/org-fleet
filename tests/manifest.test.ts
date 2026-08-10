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
