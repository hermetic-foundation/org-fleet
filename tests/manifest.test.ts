import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  assert.equal(plan.error, "repo-fleet manifest is missing");
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
