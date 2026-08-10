import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export interface ResolvedManifestSource {
  data: unknown;
  source: string;
  root: string;
  kind: "file" | "flake";
}

export function resolveManifestSource(source: string): ResolvedManifestSource {
  if (!source.startsWith("flake:")) {
    try {
      return { data: JSON.parse(readFileSync(source, "utf8")), source, root: path.dirname(path.resolve(source)), kind: "file" };
    } catch (error) {
      throw new Error(`${source}: cannot read manifest: ${errorMessage(error)}`);
    }
  }
  const installable = source.slice("flake:".length);
  if (installable.length === 0 || !installable.includes("#")) {
    throw new Error(`${source}: flake manifest source must include an attribute, for example flake:.#orgFleetManifest`);
  }
  const result = spawnSync("nix", ["eval", "--option", "substituters", "", "--json", installable], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = (result.error?.message ?? result.stderr.trim()) || `nix eval exited ${result.status ?? "without a status"}`;
    throw new Error(`${source}: cannot evaluate manifest: ${detail}`);
  }
  try {
    return { data: JSON.parse(result.stdout), source, root: process.cwd(), kind: "flake" };
  } catch (error) {
    throw new Error(`${source}: nix eval returned invalid JSON: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
