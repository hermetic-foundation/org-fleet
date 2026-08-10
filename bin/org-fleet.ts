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
const REPO_FLEET_COMMANDS = new Set(["list", "validate", "path", "remotes", "status", "doctor", "clone-missing", "sync", "reconcile"]);
const MUTATING_REPO_FLEET_COMMANDS = new Set(["clone-missing", "sync"]);

interface ParsedArgs {
  command: string | null;
  manifest: string;
  workspaceRoot: string | null;
  json: boolean;
  dryRun: boolean;
  write: boolean;
  orgs: string[];
  args: string[];
  error: string | null;
}

interface OrgPlan {
  id: string;
  manifest_repo_path: string | null;
  repo_fleet_manifest: string;
  manifest_repo_exists: boolean;
  manifest_exists: boolean;
  manifest_repo_action: "skip" | "clone" | "fetch" | "resolve-flake";
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

  if (parsed.command === "orgs") {
    return commandOrgs(orgs, workspaceRoot, parsed.json);
  }
  if (parsed.command === "manifest-path") {
    return commandManifestPath(manifest, workspaceRoot, parsed.args, parsed.json);
  }
  if (parsed.command && REPO_FLEET_COMMANDS.has(parsed.command)) {
    return commandRepoFleet(manifest, orgs, workspaceRoot, parsed.command, parsed.dryRun, parsed.write, parsed.json, parsed.args);
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
    write: false,
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
    } else if (arg === "--write") {
      result.write = true;
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
  if (result.write && result.command !== "reconcile") {
    result.error = "--write is only valid with reconcile";
  } else if (result.write && result.dryRun) {
    result.error = "--write and --dry-run are mutually exclusive";
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
  org-fleet orgs [--manifest PATH] [--workspace-root PATH] [--org ORG] [--json]
  org-fleet manifest-path ORG_ID [--manifest PATH] [--workspace-root PATH] [--json]
  org-fleet list [--manifest PATH] [--workspace-root PATH] [--org ORG] [--json]
  org-fleet validate [--manifest PATH] [--workspace-root PATH] [--org ORG] [--json]
  org-fleet path ORG_ID REPO_ID [--manifest PATH] [--workspace-root PATH] [--json]
  org-fleet remotes [--manifest PATH] [--workspace-root PATH] [--org ORG] [--json]
  org-fleet status [--manifest PATH] [--workspace-root PATH] [--org ORG] [--json]
  org-fleet doctor [--manifest PATH] [--workspace-root PATH] [--org ORG] [--json]
  org-fleet clone-missing [--manifest PATH] [--workspace-root PATH] [--org ORG] [--dry-run] [--json] [-- REPO_FLEET_ARGS...]
  org-fleet sync [--manifest PATH] [--workspace-root PATH] [--org ORG] [--dry-run] [--json] [-- REPO_FLEET_ARGS...]
  org-fleet reconcile [--manifest PATH] [--workspace-root PATH] [--org ORG] [--write | --dry-run] [--json] [-- REPO_FLEET_ARGS...]
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

function commandOrgs(orgs: Organization[], workspaceRoot: string, jsonOutput: boolean): number {
  const rows = orgs.map((org) => ({
    id: org.id,
    manifest_repo: org.repo_fleet_manifest.repository ?? null,
    manifest_repo_remote: org.repo_fleet_manifest.flake ? null : manifestRepoRemote(org),
    manifest_repo_path: org.repo_fleet_manifest.flake ? null : manifestRepoPath(org, workspaceRoot),
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

function commandManifestPath(manifest: Manifest, workspaceRoot: string, args: string[], jsonOutput: boolean): number {
  if (args.length !== 1) {
    console.error("manifest-path requires exactly one ORG_ID");
    return 2;
  }
  const org = manifest.organizations.find((candidate) => candidate.id === args[0]);
  if (!org) {
    console.error(`unknown organization ${args[0]}`);
    return 2;
  }
  const row = {
    id: org.id,
    manifest_repo_path: org.repo_fleet_manifest.flake ? null : manifestRepoPath(org, workspaceRoot),
    repo_fleet_manifest: repoFleetManifestPath(org, workspaceRoot),
  };
  if (jsonOutput) {
    console.log(JSON.stringify(row, null, 2));
  } else {
    console.log(row.repo_fleet_manifest);
  }
  return 0;
}

function commandRepoFleet(
  manifest: Manifest,
  orgs: Organization[],
  workspaceRoot: string,
  command: string,
  dryRun: boolean,
  write: boolean,
  jsonOutput: boolean,
  args: string[],
): number {
  if (command === "path") {
    return commandRepoFleetPath(manifest, workspaceRoot, args, jsonOutput);
  }

  const repoFleetArgs = [...args];
  if (jsonOutput && !repoFleetArgs.includes("--json")) {
    repoFleetArgs.push("--json");
  }
  if (dryRun && MUTATING_REPO_FLEET_COMMANDS.has(command) && !repoFleetArgs.includes("--dry-run")) {
    repoFleetArgs.push("--dry-run");
  }
  const reconcileWrite = command === "reconcile" && (write || repoFleetArgs.includes("--write"));
  const reconcileDryRun = command === "reconcile" && (dryRun || repoFleetArgs.includes("--dry-run"));
  if (reconcileWrite && reconcileDryRun) {
    console.error("--write and --dry-run are mutually exclusive");
    return 2;
  }
  if (command === "reconcile") {
    if (reconcileWrite && !repoFleetArgs.includes("--write")) {
      repoFleetArgs.push("--write");
    } else if (reconcileDryRun && !repoFleetArgs.includes("--dry-run")) {
      repoFleetArgs.push("--dry-run");
    }
  }

  const mutatesManifest = MUTATING_REPO_FLEET_COMMANDS.has(command) || reconcileWrite;

  const rows = [];
  let ok = true;

  for (const org of orgs) {
    let plan = planForOrg(org, workspaceRoot);
    if (mutatesManifest && !dryRun && plan.manifest_repo_action === "clone") {
      const cloneResult = cloneManifestRepo(org, workspaceRoot);
      if (cloneResult.status !== 0) {
        ok = false;
        rows.push({ organization: org.id, manifest: { ...plan, ok: false, error: cloneResult.error }, status: null, output: null });
        continue;
      }
      plan = planForOrg(org, workspaceRoot);
    } else if (mutatesManifest && !dryRun && plan.manifest_repo_action === "fetch") {
      const fetchResult = fetchManifestRepo(plan.manifest_repo_path!);
      if (fetchResult.status !== 0) {
        ok = false;
        rows.push({ organization: org.id, manifest: { ...plan, ok: false, error: fetchResult.error }, status: null, output: null });
        continue;
      }
      plan = planForOrg(org, workspaceRoot);
    }

    if (!plan.ok) {
      ok = false;
      rows.push({ organization: org.id, manifest: plan, status: null, output: null });
      continue;
    }

    if (!mutatesManifest && plan.manifest_repo_action === "clone") {
      ok = false;
      rows.push({
        organization: org.id,
        manifest: plan,
        status: null,
        output: null,
        error: `repo-fleet manifest is not materialized at ${plan.repo_fleet_manifest}; run org-fleet sync or clone-missing first`,
      });
      continue;
    }

    if (dryRun && mutatesManifest && plan.manifest_repo_action === "clone") {
      rows.push({ organization: org.id, manifest: plan, status: 0, output: null });
      continue;
    }

    const repoFleetResult = runRepoFleetCommand(org, workspaceRoot, command, repoFleetArgs);
    if (repoFleetResult.status !== 0) {
      ok = false;
    }
    rows.push({
      organization: org.id,
      manifest: plan,
      status: repoFleetResult.status,
      output: parseRepoFleetOutput(command, repoFleetResult.stdout, jsonOutput),
      stderr: repoFleetResult.stderr.trim() || null,
      error: repoFleetResult.status === 0 || repoFleetResult.stdout.trim().length > 0 ? null : repoFleetResult.error,
    });
  }

  if (jsonOutput) {
    console.log(JSON.stringify(jsonRows(command, rows), null, 2));
  } else {
    printTextRows(command, rows);
  }
  return ok ? 0 : 1;
}

function commandRepoFleetPath(manifest: Manifest, workspaceRoot: string, args: string[], jsonOutput: boolean): number {
  if (args.length !== 2) {
    console.error("path requires ORG_ID and REPO_ID");
    return 2;
  }
  const org = manifest.organizations.find((candidate) => candidate.id === args[0]);
  if (!org) {
    console.error(`unknown organization ${args[0]}`);
    return 2;
  }
  const plan = planForOrg(org, workspaceRoot);
  if (!plan.ok) {
    console.error(plan.error ?? "repo-fleet manifest is unavailable");
    return 1;
  }
  const result = runRepoFleetCommand(org, workspaceRoot, "path", [args[1]]);
  if (result.status !== 0) {
    if (result.stdout.trim()) {
      console.log(result.stdout.trimEnd());
    }
    if (result.stderr.trim()) {
      console.error(result.stderr.trim());
    }
    if (result.error) {
      console.error(result.error);
    }
    return result.status;
  }
  const repoPath = result.stdout.trim();
  if (jsonOutput) {
    console.log(JSON.stringify({ organization: org.id, id: args[1], path: repoPath }, null, 2));
  } else {
    console.log(repoPath);
  }
  return 0;
}

function planForOrg(org: Organization, workspaceRoot: string): OrgPlan {
  if (org.repo_fleet_manifest.flake) {
    return {
      id: org.id,
      manifest_repo_path: null,
      repo_fleet_manifest: repoFleetManifestPath(org, workspaceRoot),
      manifest_repo_exists: false,
      manifest_exists: true,
      manifest_repo_action: "resolve-flake",
      ok: true,
      error: null,
    };
  }
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
      error: "repo-fleet manifest is not materialized; run org-fleet sync or clone-missing first",
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

interface VcsResult {
  status: number;
  error: string | null;
  stdout: string;
  stderr: string;
  attempts: number;
}

interface RepoFleetCommandResult {
  status: number;
  error: string | null;
  stdout: string;
  stderr: string;
}

function cloneManifestRepo(org: Organization, workspaceRoot: string): VcsResult {
  const destination = manifestRepoPath(org, workspaceRoot);
  const parent = path.dirname(destination);
  const args = commandAvailable("jj")
    ? ["git", "clone", "--colocate", manifestRepoRemote(org), destination]
    : ["clone", manifestRepoRemote(org), destination];
  const command = commandAvailable("jj") ? "jj" : "git";
  return runVcsWithRetries(command, args, parent, `clone manifest repository for ${org.id}`);
}

function fetchManifestRepo(repoPath: string): VcsResult {
  const isJjRepo = existsSync(path.join(repoPath, ".jj"));
  const command = isJjRepo && commandAvailable("jj") ? "jj" : "git";
  const args = command === "jj" ? ["git", "fetch"] : ["fetch", "--all", "--prune"];
  return runVcsWithRetries(command, args, repoPath, `fetch manifest repository ${repoPath}`);
}

function runVcsWithRetries(command: string, args: string[], cwd: string, operation: string): VcsResult {
  const retries = nonNegativeInteger(process.env.ORG_FLEET_VCS_RETRIES, 2);
  let last = { status: 1, stdout: "", stderr: "", detail: "command did not run" };
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const status = result.status ?? 1;
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const detail = result.error?.message ?? (stderr.trim() || stdout.trim() || `${command} exited ${status}`);
    last = { status, stdout, stderr, detail };
    if (status === 0 && !result.error) {
      return { status: 0, error: null, stdout, stderr, attempts: attempt };
    }
    if (attempt > retries || !isTransientVcsFailure(detail)) {
      return {
        status,
        error: `${operation} failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${detail}`,
        stdout,
        stderr,
        attempts: attempt,
      };
    }
  }
  return { status: last.status, error: `${operation} failed: ${last.detail}`, stdout: last.stdout, stderr: last.stderr, attempts: retries + 1 };
}

function isTransientVcsFailure(detail: string): boolean {
  return /timed? out|temporar(?:y|ily)|connection (?:reset|closed|refused)|could not resolve|network is unreachable|early eof|remote end hung up|http (?:5\d\d|429)/i.test(detail);
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    return fallback;
  }
  return Number.parseInt(value, 10);
}

function runRepoFleetCommand(
  org: Organization,
  workspaceRoot: string,
  command: string,
  extraArgs: string[],
): RepoFleetCommandResult {
  const repoFleetBin = process.env.ORG_FLEET_REPO_FLEET_BIN ?? "repo-fleet";
  const manifestPath = repoFleetManifestPath(org, workspaceRoot);
  const flakeWorkspaceArgs = org.repo_fleet_manifest.flake && !extraArgs.includes("--workspace-root")
    ? ["--workspace-root", path.resolve(workspaceRoot, org.id)]
    : [];
  const args = [command, "--manifest", manifestPath, ...flakeWorkspaceArgs, ...extraArgs];
  const result = spawnSync(repoFleetBin, args, { encoding: "utf8" });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status === 0 && !result.error) {
    return { status: 0, error: null, stdout, stderr };
  }

  const executable = JSON.stringify(repoFleetBin);
  const invocationArgs = JSON.stringify(args);
  if (result.error) {
    return {
      status: result.status ?? 1,
      error: `failed to launch repo-fleet executable ${executable} with arguments ${invocationArgs}: ${result.error.message}`,
      stdout,
      stderr,
    };
  }

  const status = result.status ?? 1;
  const termination = result.signal ? `signal ${result.signal}` : `status ${status}`;
  const detail = stderr.trim() || stdout.trim() || "no diagnostic output";
  return {
    status,
    error: `repo-fleet executable ${executable} exited with ${termination}; arguments ${invocationArgs}; detail: ${detail}`,
    stdout,
    stderr,
  };
}

function parseRepoFleetOutput(command: string, output: string, jsonOutput: boolean): unknown {
  if (!jsonOutput) {
    return output.trimEnd();
  }
  if (output.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(output);
  } catch {
    return output.trimEnd();
  }
}

function jsonRows(command: string, rows: Array<Record<string, unknown>>): unknown {
  if (command === "list" || command === "remotes" || command === "status") {
    return rows.flatMap((row) => {
      const output = row.output;
      if (!Array.isArray(output)) {
        return [row];
      }
      return output.map((item) => (isPlainObject(item) ? { organization: row.organization, ...item } : { organization: row.organization, value: item }));
    });
  }
  if (command === "doctor") {
    return {
      findings: rows.flatMap((row) => {
        const output = row.output;
        if (!isPlainObject(output) || !Array.isArray(output.findings)) {
          return row.error ? [{ organization: row.organization, severity: "error", message: row.error }] : [];
        }
        return output.findings.map((finding) => (isPlainObject(finding) ? { organization: row.organization, ...finding } : finding));
      }),
    };
  }
  if (command === "validate") {
    return {
      valid: rows.every((row) => row.status === 0),
      organizations: rows.length,
      results: rows.map((row) => ({
        organization: row.organization,
        valid: row.status === 0,
        manifest: row.manifest,
        output: row.output,
        error: row.error,
      })),
    };
  }
  if (command === "reconcile") {
    const results = rows.map((row) => {
      const output = isPlainObject(row.output) ? row.output : null;
      const manifestError = isPlainObject(row.manifest) && typeof row.manifest.error === "string"
        ? row.manifest.error
        : null;
      const error = row.error ?? manifestError;
      return output
        ? { ...output, organization: row.organization, status: row.status, error }
        : { organization: row.organization, status: row.status, manifest: row.manifest, output: row.output, error };
    });
    return {
      ok: rows.every((row) => row.status === 0),
      organizations: rows.length,
      upstream_repository_count: sumNumericOutputField(rows, "upstream_repository_count"),
      manifest_repository_count: sumNumericOutputField(rows, "manifest_repository_count"),
      missing: flattenOutputItems(rows, "missing"),
      stale: flattenOutputItems(rows, "stale"),
      metadata_drift: flattenOutputItems(rows, "metadata_drift"),
      added: flattenOutputItems(rows, "added"),
      wrote_manifests: rows
        .filter((row) => isPlainObject(row.output) && row.output.wrote_manifest === true)
        .map((row) => row.organization),
      results,
    };
  }
  return rows;
}

function sumNumericOutputField(rows: Array<Record<string, unknown>>, field: string): number {
  return rows.reduce((total, row) => {
    const output = row.output;
    const value = isPlainObject(output) ? output[field] : null;
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

function flattenOutputItems(rows: Array<Record<string, unknown>>, field: string): unknown[] {
  return rows.flatMap((row) => {
    const output = row.output;
    const items = isPlainObject(output) ? output[field] : null;
    if (!Array.isArray(items)) {
      return [];
    }
    return items.map((item) => {
      if (isPlainObject(item)) {
        return { ...item, organization: row.organization };
      }
      if (field === "added" && typeof item === "string") {
        return { name: item, organization: row.organization };
      }
      return { value: item, organization: row.organization };
    });
  });
}

function printTextRows(command: string, rows: Array<Record<string, unknown>>): void {
  for (const row of rows) {
    const heading = `# ${row.organization}`;
    console.log(heading);
    if (row.error) {
      console.log(`error: ${row.error}`);
    }
    if (row.output) {
      console.log(row.output);
    } else if (command === "clone-missing" || command === "sync" || command === "reconcile") {
      const manifest = row.manifest;
      if (isPlainObject(manifest)) {
        const action = manifest.manifest_repo_action;
        const state = manifest.ok ? "ok" : "error";
        const suffix = manifest.error ? ` ${manifest.error}` : "";
        console.log(`${state} manifest-repo ${action} ${manifest.repo_fleet_manifest}${suffix}`);
      }
    }
    if (row.stderr) {
      console.error(row.stderr);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
