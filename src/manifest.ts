import path from "node:path";

import { resolveManifestSource } from "./manifest-source.ts";

export interface RepoFleetManifestPointer {
  repository?: string;
  path?: string;
  checkout_path?: string;
  flake?: string;
  attribute?: string;
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
  const resolved = resolveManifestSource(manifestPath);
  const raw = resolved.data;
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
    root: resolved.root,
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
      const hasFile = nonEmptyString(org.repo_fleet_manifest.repository) || nonEmptyString(org.repo_fleet_manifest.path);
      const hasFlake = nonEmptyString(org.repo_fleet_manifest.flake);
      if (hasFile === hasFlake) {
        errors.push(`${prefix}.repo_fleet_manifest must specify either repository/path or flake`);
      }
      if (hasFile) {
        if (!nonEmptyString(org.repo_fleet_manifest.repository)) {
          errors.push(`${prefix}.repo_fleet_manifest.repository is required`);
        }
        validateRelativePath(org.repo_fleet_manifest.path, `${prefix}.repo_fleet_manifest.path`, errors);
      }
      if (org.repo_fleet_manifest.attribute !== undefined && !nonEmptyString(org.repo_fleet_manifest.attribute)) {
        errors.push(`${prefix}.repo_fleet_manifest.attribute must be a non-empty string`);
      }
      if (hasFile && org.repo_fleet_manifest.attribute !== undefined) {
        errors.push(`${prefix}.repo_fleet_manifest.attribute is only valid with flake`);
      }
      if (org.repo_fleet_manifest.checkout_path !== undefined) {
        validateRelativePath(org.repo_fleet_manifest.checkout_path, `${prefix}.repo_fleet_manifest.checkout_path`, errors);
      }
      if (hasFlake && org.repo_fleet_manifest.checkout_path !== undefined) {
        errors.push(`${prefix}.repo_fleet_manifest.checkout_path is only valid with repository/path`);
      }
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
  if (!org.repo_fleet_manifest.repository) {
    throw new Error(`${org.id}: flake manifest has no manifest repository remote`);
  }
  return `git@github.com:${org.id}/${org.repo_fleet_manifest.repository}.git`;
}

export function manifestRepoPath(org: Organization, workspaceRoot: string): string {
  if (org.repo_fleet_manifest.checkout_path) {
    return path.resolve(workspaceRoot, org.repo_fleet_manifest.checkout_path);
  }
  if (!org.repo_fleet_manifest.repository) {
    throw new Error(`${org.id}: flake manifest has no manifest repository path`);
  }
  return path.resolve(workspaceRoot, org.id, org.repo_fleet_manifest.repository);
}

export function repoFleetManifestPath(org: Organization, workspaceRoot: string): string {
  if (org.repo_fleet_manifest.flake) {
    const attribute = org.repo_fleet_manifest.attribute ?? "repoFleetManifest";
    return `flake:${org.repo_fleet_manifest.flake}#${attribute}`;
  }
  if (!org.repo_fleet_manifest.path) {
    throw new Error(`${org.id}: manifest path is missing`);
  }
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
