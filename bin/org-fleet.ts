import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  loadManifest,
  manifestRepoRemote,
  manifestRepoPath,
  repoFleetManifestPath,
  resolveWorkspaceRoot,
} from "../src/manifest.ts";
import type { Manifest, Organization } from "../src/manifest.ts";

const VERSION = "0.1.0";
const DEFAULT_MANIFEST = "org-fleet.json";

interface ParsedArgs {
  command: string | null;
  manifest: string;
  workspaceRoot: string | null;
  json: boolean;
  dryRun: boolean;
  orgs: string[];
  args: string[];
  error: string | null;
}

interface OrgPlan {
  id: string;
  manifest_repo_path: string;
  repo_fleet_manifest: string;
  manifest_repo_exists: boolean;
  manifest_exists: boolean;
  manifest_repo_action: "skip" | "clone" | "fetch";
  ok: boolean;
  error: string | null;
}

function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(parsed.error);
    printUsage();
    return 2;
  }
  if (parsed.command === "version") {
    console.log(VERSION);
    return 0;
  }

  let manifest;
  try {
    manifest = loadManifest(parsed.manifest);
  } catch (error) {
    console.error(errorMessage(error));
    return 2;
  }

  const workspaceRoot = resolveWorkspaceRoot(manifest, parsed.workspaceRoot);
  const orgs = selectOrganizations(manifest, parsed.orgs);
  if (orgs === null) {
    return 2;
  }

  if (parsed.command === "list") {
    return commandList(orgs, workspaceRoot, parsed.json);
  }
  if (parsed.command === "validate") {
    return commandValidate(manifest, orgs, workspaceRoot, parsed.json);
  }
  if (parsed.command === "path") {
    return commandPath(manifest, workspaceRoot, parsed.args, parsed.json);
  }
  if (parsed.command === "sync") {
    return commandSync(orgs, workspaceRoot, parsed.dryRun, parsed.json, parsed.args);
  }

  console.error(`unknown command ${parsed.command}`);
  printUsage();
  return 2;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: null,
    manifest: DEFAULT_MANIFEST,
    workspaceRoot: null,
    json: false,
    dryRun: false,
    orgs: [],
    args: [],
    error: null,
  };
  const args = [...argv];
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    result.error = args.length === 0 ? "missing command" : null;
    result.command = "help";
    return result;
  }
  if (args[0] === "--version" || args[0] === "version") {
    result.command = "version";
    return result;
  }
  result.command = args.shift() ?? null;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === undefined) {
      break;
    }
    if (arg === "--manifest") {
      const value = requireValue(arg, args);
      if (value === null) {
        result.error = `${arg} requires a value`;
        return result;
      }
      result.manifest = value;
    } else if (arg === "--workspace-root") {
      const value = requireValue(arg, args);
      if (value === null) {
        result.error = `${arg} requires a value`;
        return result;
      }
      result.workspaceRoot = value;
    } else if (arg === "--org") {
      const value = requireValue(arg, args);
      if (value === null) {
        result.error = `${arg} requires a value`;
        return result;
      }
      result.orgs.push(value);
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--") {
      result.args.push(...args);
      break;
    } else if (arg.startsWith("--")) {
      result.error = `unknown argument ${arg}`;
      return result;
    } else {
      result.args.push(arg);
    }
  }
  return result;
}

function requireValue(flag: string, args: string[]): string | null {
  if (args.length === 0 || args[0].startsWith("--")) {
    return null;
  }
  return args.shift() ?? null;
}

function printUsage(): void {
  console.error(`Usage:
  org-fleet list [--manifest PATH] [--workspace-root PATH] [--org ORG] [--json]
  org-fleet validate [--manifest PATH] [--workspace-root PATH] [--org ORG] [--json]
  org-fleet path ORG_ID [--manifest PATH] [--workspace-root PATH] [--json]
  org-fleet sync [--manifest PATH] [--workspace-root PATH] [--org ORG] [--dry-run] [--json] [-- REPO_FLEET_ARGS...]
  org-fleet version`);
}

function selectOrganizations(manifest: Manifest, ids: string[]): Organization[] | null {
  if (ids.length === 0) {
    return manifest.organizations;
  }
  const selected: Organization[] = [];
  for (const id of ids) {
    const org = manifest.organizations.find((candidate) => candidate.id === id);
    if (!org) {
      console.error(`unknown organization ${id}`);
      return null;
    }
    selected.push(org);
  }
  return selected;
}

function commandList(orgs: Organization[], workspaceRoot: string, jsonOutput: boolean): number {
  const rows = orgs.map((org) => ({
    id: org.id,
    manifest_repo: org.repo_fleet_manifest.repository,
    manifest_repo_remote: manifestRepoRemote(org),
    manifest_repo_path: manifestRepoPath(org, workspaceRoot),
    repo_fleet_manifest: repoFleetManifestPath(org, workspaceRoot),
  }));
  if (jsonOutput) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    for (const row of rows) {
      console.log(`${row.id} ${row.repo_fleet_manifest}`);
    }
  }
  return 0;
}

function commandValidate(manifest: Manifest, orgs: Organization[], workspaceRoot: string, jsonOutput: boolean): number {
  const summary = {
    valid: true,
    organizations: manifest.organizations.length,
    selected_organizations: orgs.length,
    repo_fleet_manifests: orgs.map((org) => ({
      organization: org.id,
      repository: org.repo_fleet_manifest.repository,
      path: org.repo_fleet_manifest.path,
      resolved_path: repoFleetManifestPath(org, workspaceRoot),
    })),
  };
  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`manifest is valid (${summary.organizations} organizations)`);
  }
  return 0;
}

function commandPath(manifest: Manifest, workspaceRoot: string, args: string[], jsonOutput: boolean): number {
  if (args.length !== 1) {
    console.error("path requires exactly one ORG_ID");
    return 2;
  }
  const org = manifest.organizations.find((candidate) => candidate.id === args[0]);
  if (!org) {
    console.error(`unknown organization ${args[0]}`);
    return 2;
  }
  const row = {
    id: org.id,
    manifest_repo_path: manifestRepoPath(org, workspaceRoot),
    repo_fleet_manifest: repoFleetManifestPath(org, workspaceRoot),
  };
  if (jsonOutput) {
    console.log(JSON.stringify(row, null, 2));
  } else {
    console.log(row.repo_fleet_manifest);
  }
  return 0;
}

function commandSync(orgs: Organization[], workspaceRoot: string, dryRun: boolean, jsonOutput: boolean, repoFleetArgs: string[]): number {
  const plans = orgs.map((org) => planForOrg(org, workspaceRoot));
  const results = [];
  let ok = true;

  for (const plan of plans) {
    const org = orgs.find((candidate) => candidate.id === plan.id);
    if (!org) {
      continue;
    }
    if (!dryRun && plan.manifest_repo_action === "clone") {
      const cloneResult = cloneManifestRepo(org, workspaceRoot);
      if (cloneResult.status !== 0) {
        ok = false;
        results.push({ ...plan, ok: false, error: cloneResult.error });
        continue;
      }
    } else if (!dryRun && plan.manifest_repo_action === "fetch") {
      const fetchResult = fetchManifestRepo(plan.manifest_repo_path);
      if (fetchResult.status !== 0) {
        ok = false;
        results.push({ ...plan, ok: false, error: fetchResult.error });
        continue;
      }
    }

    const refreshedPlan = planForOrg(org, workspaceRoot);
    if (!refreshedPlan.ok) {
      ok = false;
      results.push(refreshedPlan);
      continue;
    }
    if (dryRun) {
      results.push(refreshedPlan);
      continue;
    }

    const repoFleetResult = runRepoFleetSync(org, workspaceRoot, repoFleetArgs);
    if (repoFleetResult.status !== 0) {
      ok = false;
      results.push({ ...refreshedPlan, ok: false, error: repoFleetResult.error });
      continue;
    }
    results.push(refreshedPlan);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      const action = dryRun ? `would-${result.manifest_repo_action}` : result.manifest_repo_action;
      const state = result.ok ? "ok" : "error";
      const suffix = result.error ? ` ${result.error}` : "";
      console.log(`${state} ${result.id} ${action} ${result.repo_fleet_manifest}${suffix}`);
    }
  }
  return ok && results.every((result) => result.ok) ? 0 : 1;
}

function planForOrg(org: Organization, workspaceRoot: string): OrgPlan {
  const repoPath = manifestRepoPath(org, workspaceRoot);
  const manifestPath = repoFleetManifestPath(org, workspaceRoot);
  const repoExists = existsSync(repoPath);
  const manifestExists = existsSync(manifestPath);
  const isGitRepo = existsSync(path.join(repoPath, ".git"));
  if (!repoExists) {
    return {
      id: org.id,
      manifest_repo_path: repoPath,
      repo_fleet_manifest: manifestPath,
      manifest_repo_exists: false,
      manifest_exists: false,
      manifest_repo_action: "clone",
      ok: true,
      error: null,
    };
  }
  if (!isGitRepo) {
    return {
      id: org.id,
      manifest_repo_path: repoPath,
      repo_fleet_manifest: manifestPath,
      manifest_repo_exists: true,
      manifest_exists: manifestExists,
      manifest_repo_action: "skip",
      ok: false,
      error: "manifest repo path exists but is not a git repo",
    };
  }
  if (!manifestExists) {
    return {
      id: org.id,
      manifest_repo_path: repoPath,
      repo_fleet_manifest: manifestPath,
      manifest_repo_exists: true,
      manifest_exists: false,
      manifest_repo_action: "fetch",
      ok: false,
      error: "repo-fleet manifest is missing",
    };
  }
  return {
    id: org.id,
    manifest_repo_path: repoPath,
    repo_fleet_manifest: manifestPath,
    manifest_repo_exists: true,
    manifest_exists: true,
    manifest_repo_action: "fetch",
    ok: true,
    error: null,
  };
}

function cloneManifestRepo(org: Organization, workspaceRoot: string): { status: number; error: string | null } {
  const destination = manifestRepoPath(org, workspaceRoot);
  const parent = path.dirname(destination);
  const args = commandAvailable("jj")
    ? ["git", "clone", "--colocate", manifestRepoRemote(org), destination]
    : ["clone", manifestRepoRemote(org), destination];
  const command = commandAvailable("jj") ? "jj" : "git";
  const result = spawnSync(command, args, { cwd: parent, stdio: "inherit" });
  return result.status === 0
    ? { status: 0, error: null }
    : { status: result.status ?? 1, error: `${command} ${args.join(" ")} failed` };
}

function fetchManifestRepo(repoPath: string): { status: number; error: string | null } {
  const isJjRepo = existsSync(path.join(repoPath, ".jj"));
  const command = isJjRepo && commandAvailable("jj") ? "jj" : "git";
  const args = command === "jj" ? ["git", "fetch"] : ["fetch", "--all", "--prune"];
  const result = spawnSync(command, args, { cwd: repoPath, stdio: "inherit" });
  return result.status === 0
    ? { status: 0, error: null }
    : { status: result.status ?? 1, error: `${command} ${args.join(" ")} failed` };
}

function runRepoFleetSync(org: Organization, workspaceRoot: string, extraArgs: string[]): { status: number; error: string | null } {
  const repoFleetBin = process.env.ORG_FLEET_REPO_FLEET_BIN ?? "repo-fleet";
  const manifestPath = repoFleetManifestPath(org, workspaceRoot);
  const args = ["sync", "--manifest", manifestPath, ...extraArgs];
  const result = spawnSync(repoFleetBin, args, { stdio: "inherit" });
  return result.status === 0
    ? { status: 0, error: null }
    : { status: result.status ?? 1, error: `${repoFleetBin} ${args.join(" ")} failed` };
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}

export { main, planForOrg };
