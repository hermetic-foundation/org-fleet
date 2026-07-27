import { readFileSync } from "node:fs";
import path from "node:path";

export interface ManifestRepositoryConfig {
  remote: string;
  local_path: string;
  default_branch: string;
}

export interface OrganizationConfig {
  id: string;
  vcs_provider?: string;
  manifest_repo: ManifestRepositoryConfig;
  manifest_path: string;
  repo_fleet_workspace_root?: string;
}

export interface Organization {
  id: string;
  vcs_provider: string | null;
  manifest_repo: ManifestRepositoryConfig;
  manifest_path: string;
  repo_fleet_workspace_root: string | null;
}

export interface ManifestData {
  version: 1;
  workspace_root?: string;
  organizations: OrganizationConfig[];
}

export interface Manifest {
  version: 1;
  workspace_root: string | null;
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
    workspace_root: data.workspace_root ?? null,
    organizations: data.organizations.map((org) => ({
      id: org.id,
      vcs_provider: org.vcs_provider ?? null,
      manifest_repo: org.manifest_repo,
      manifest_path: org.manifest_path,
      repo_fleet_workspace_root: org.repo_fleet_workspace_root ?? null,
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
  if (raw.workspace_root !== undefined) {
    validateRelativePath(raw.workspace_root, "workspace_root", errors);
  }
  if (!Array.isArray(raw.organizations)) {
    errors.push("organizations must be an array");
    return errors;
  }

  const seenIds = new Set<string>();
  const seenLocalPaths = new Set<string>();
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
    if (org.vcs_provider !== undefined && !nonEmptyString(org.vcs_provider)) {
      errors.push(`${prefix}.vcs_provider must be a non-empty string`);
    }
    if (!isPlainObject(org.manifest_repo)) {
      errors.push(`${prefix}.manifest_repo must be an object`);
    } else {
      for (const field of ["remote", "local_path", "default_branch"]) {
        if (!nonEmptyString(org.manifest_repo[field])) {
          errors.push(`${prefix}.manifest_repo.${field} is required`);
        }
      }
      if (typeof org.manifest_repo.local_path === "string") {
        validateRelativePath(org.manifest_repo.local_path, `${prefix}.manifest_repo.local_path`, errors);
        if (seenLocalPaths.has(org.manifest_repo.local_path)) {
          errors.push(`${prefix}.manifest_repo.local_path duplicates ${org.manifest_repo.local_path}`);
        } else {
          seenLocalPaths.add(org.manifest_repo.local_path);
        }
      }
    }
    validateRelativePath(org.manifest_path, `${prefix}.manifest_path`, errors);
    if (org.repo_fleet_workspace_root !== undefined) {
      validateRelativePath(org.repo_fleet_workspace_root, `${prefix}.repo_fleet_workspace_root`, errors);
    }
  }

  return errors;
}

export function resolveWorkspaceRoot(manifest: Manifest, override?: string | null): string {
  if (override) {
    return path.resolve(override);
  }
  if (manifest.workspace_root) {
    return path.resolve(manifest.root, manifest.workspace_root);
  }
  return manifest.root;
}

export function manifestRepoPath(org: Organization, workspaceRoot: string): string {
  return path.resolve(workspaceRoot, org.manifest_repo.local_path);
}

export function repoFleetManifestPath(org: Organization, workspaceRoot: string): string {
  return path.resolve(manifestRepoPath(org, workspaceRoot), org.manifest_path);
}

export function repoFleetWorkspaceRoot(org: Organization, workspaceRoot: string): string | null {
  if (!org.repo_fleet_workspace_root) {
    return null;
  }
  return path.resolve(manifestRepoPath(org, workspaceRoot), org.repo_fleet_workspace_root);
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
