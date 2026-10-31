import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { resolveFilesystemPath } from "../core/paths";

/** Repository-level read-only SDK and toolchain directories an agent run may see. */
export const agentToolchainPathsSchema = z
  .object({
    paths: z
      .array(z.string().min(1).refine((value) => path.isAbsolute(value), "must be an absolute path"))
      .min(1),
  })
  .strict();

export type AgentToolchainPathsConfig = z.output<typeof agentToolchainPathsSchema>;

/** The service's own state which a toolchain path must never expose. */
export interface ProtectedLocationInput {
  /** The Conveyor home, when known. */
  home?: string | undefined;
  root: string;
  settings: { database: string; logs: string; workspaces: string; artifacts: string };
  repositories: Record<string, { folder: string }>;
  runners: Record<string, object>;
}

/** Directories under the service user's home which hold credentials or agent state. */
const CREDENTIAL_ROOTS = [
  ".ssh", ".aws", ".gnupg", ".config", ".claude", ".claude.json", ".codex", ".conveyor", ".docker", ".kube",
  ".netrc", ".npmrc", ".git-credentials", ".local/share", ".azure", ".gcloud",
];

export function protectedServiceLocations(input: ProtectedLocationInput): string[] {
  const home = process.env.CONVEYOR_HOME ?? path.join(homedir(), ".conveyor");
  const serviceHome = homedir();
  const locations = [
    input.home ?? home,
    home,
    input.root,
    path.dirname(input.settings.database),
    input.settings.logs,
    input.settings.workspaces,
    input.settings.artifacts,
    ...Object.values(input.repositories).map((repository) => repository.folder),
    ...Object.values(input.runners).flatMap((runner) => ("configDir" in runner && typeof runner.configDir === "string" ? [runner.configDir] : [])),
    ...CREDENTIAL_ROOTS.map((name) => path.join(serviceHome, name)),
    ...[process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR].filter((value): value is string => Boolean(value)),
  ];
  return [...new Set(locations.map((location) => resolveFilesystemPath(location)))];
}

function overlaps(left: string, right: string): boolean {
  const within = (child: string, parent: string) => child === parent || parent === "/" || child.startsWith(`${parent}/`);
  return within(left, right) || within(right, left);
}

/**
 * Resolves symbolic links and returns the real directories to mount read-only. A path that equals,
 * lies inside, or is an ancestor of a protected location is refused, since mounting it would
 * expose that location.
 */
export function resolveToolchainPaths(paths: readonly string[], protectedLocations: readonly string[]): string[] {
  const resolved: string[] = [];
  for (const declared of paths) {
    if (!path.isAbsolute(declared)) throw new Error(`agentToolchainPaths entry "${declared}" must be an absolute path`);
    const real = resolveFilesystemPath(declared);
    const clash = protectedLocations.find((location) => overlaps(real, location));
    if (clash) {
      const via = real === path.resolve(declared) ? "" : ` (resolves to ${real})`;
      throw new Error(`agentToolchainPaths entry "${declared}"${via} would expose the protected service location ${clash}`);
    }
    if (existsSync(real) && !statSync(real).isDirectory()) {
      throw new Error(`agentToolchainPaths entry "${declared}" is not a directory`);
    }
    resolved.push(real);
  }
  return [...new Set(resolved)];
}
