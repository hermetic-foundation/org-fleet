import { readFileSync } from "node:fs";
import path from "node:path";

export interface RepoFleetManifestPointer {
  repository: string;
  path: string;
}

export interface OrganizationConfig {
  id: string;
  repo_fleet_manifest: RepoFleetManifestPointer;
}

export interface Organization {
  id: string;
  repo_fleet_manifest: RepoFleetManifestPointer;
}

export interface ManifestData {
  version: 1;
  organizations: OrganizationConfig[];
}

export interface Manifest {
  version: 1;
  organizations: Organization[];
  path: string;
  root: string;
}

export function loadManifest(manifestPath: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`${manifestPath}: cannot read manifest: ${errorMessage(error)}`);
  }
  const errors = validateManifestData(raw);
  if (errors.length > 0) {
    throw new Error(`${manifestPath}: invalid manifest\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
  const data = raw as ManifestData;
  return {
    version: data.version,
    organizations: data.organizations.map((org) => ({
      id: org.id,
      repo_fleet_manifest: org.repo_fleet_manifest,
    })),
    path: manifestPath,
    root: path.dirname(path.resolve(manifestPath)),
  };
}

export function validateManifestData(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return ["manifest must be an object"];
  }
  if (raw.version !== 1) {
    errors.push("version must be 1");
  }
  if (!Array.isArray(raw.organizations)) {
    errors.push("organizations must be an array");
    return errors;
  }

  const seenIds = new Set<string>();
  for (const [index, org] of raw.organizations.entries()) {
    const prefix = `organizations[${index}]`;
    if (!isPlainObject(org)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (!nonEmptyString(org.id)) {
      errors.push(`${prefix}.id is required`);
    } else if (seenIds.has(org.id)) {
      errors.push(`${prefix}.id duplicates ${org.id}`);
    } else {
      seenIds.add(org.id);
    }
    if (!isPlainObject(org.repo_fleet_manifest)) {
      errors.push(`${prefix}.repo_fleet_manifest must be an object`);
    } else {
      if (!nonEmptyString(org.repo_fleet_manifest.repository)) {
        errors.push(`${prefix}.repo_fleet_manifest.repository is required`);
      }
      validateRelativePath(org.repo_fleet_manifest.path, `${prefix}.repo_fleet_manifest.path`, errors);
      if (typeof org.repo_fleet_manifest.repository === "string" && org.repo_fleet_manifest.repository.includes("/")) {
        errors.push(`${prefix}.repo_fleet_manifest.repository must be a repository name, not owner/name`);
      }
    }
  }

  return errors;
}

export function resolveWorkspaceRoot(manifest: Manifest, override?: string | null): string {
  if (override) {
    return path.resolve(override);
  }
  return path.resolve(manifest.root, "..", "..");
}

export function manifestRepoRemote(org: Organization): string {
  return `git@github.com:${org.id}/${org.repo_fleet_manifest.repository}.git`;
}

export function manifestRepoPath(org: Organization, workspaceRoot: string): string {
  return path.resolve(workspaceRoot, org.id, org.repo_fleet_manifest.repository);
}

export function repoFleetManifestPath(org: Organization, workspaceRoot: string): string {
  return path.resolve(manifestRepoPath(org, workspaceRoot), org.repo_fleet_manifest.path);
}

function validateRelativePath(value: unknown, field: string, errors: string[]): void {
  if (!nonEmptyString(value)) {
    errors.push(`${field} must be a non-empty string`);
    return;
  }
  if (path.isAbsolute(value)) {
    errors.push(`${field} must be relative`);
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
