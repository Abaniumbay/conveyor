// pi is an npm package: its `pi` command is a Node script (`dist/bundle/cli.js`) that loads the rest of
// its bundle, assets and dependencies relative to itself. Conveyor launches that script with the
// interpreter its `#!` line names, both resolved to real files, and mounts the package read-only.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";

import { resolveFilesystemPath } from "../../core/paths";
import { agentLaunchCommand } from "../../isolation/sandbox";

/** The npm package pi is published as. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export interface PiInstallation {
  /** The resolved `pi` executable: the package's CLI script, or a standalone build. */
  executable: string;
  /** The installed package's root, mounted read-only so pi finds its bundle, assets and dependencies. */
  packageRoot: string;
  /** The resolved interpreter a script executable names in its `#!` line, with its arguments; absent for a binary. */
  interpreter?: { path: string; args: string[] };
}

/**
 * Finds the pi installation a runner's command names. The interpreter is resolved here and launched
 * by its real path, so a Node installed through symbolic links (a version manager, Homebrew) works
 * without exposing the directories that hold the links.
 */
export function piInstallation(command: string, env: Record<string, string>): PiInstallation {
  const executable = agentLaunchCommand({ command, env });
  const packageRoot = findPackageRoot(executable);
  if (!packageRoot) {
    throw new Error(`${command} (${executable}) is not part of an installed ${PI_PACKAGE} package; install pi with npm (npm install -g ${PI_PACKAGE}) and set the runner's command to its pi`);
  }
  const shebang = interpreterLine(executable);
  if (!shebang) return { executable, packageRoot };
  const [name, ...args] = shebang;
  const found = path.isAbsolute(name!) ? name! : Bun.which(name!, { PATH: env.PATH ?? "" });
  if (!found || !existsSync(found)) {
    throw new Error(`pi (${executable}) runs on ${name}, which cannot be found${path.isAbsolute(name!) ? "" : ` on PATH (${env.PATH ?? "unset"})`}; install it (pi needs Node.js 22.19 or newer)`);
  }
  return { executable, packageRoot, interpreter: { path: resolveFilesystemPath(found), args } };
}

/** The directory, at or above the executable, whose package.json names pi's package. */
function findPackageRoot(executable: string): string | undefined {
  let directory = path.dirname(executable);
  for (let depth = 0; depth < 6; depth++) {
    const manifest = path.join(directory, "package.json");
    try {
      if (statSync(manifest).isFile() && (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === PI_PACKAGE) return directory;
    } catch {
      // A missing or unreadable manifest is not pi's; keep looking above it.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

/** The interpreter and its arguments from a script's `#!` line (`env` and its options skipped); undefined for a binary. */
function interpreterLine(executable: string): string[] | undefined {
  let line: string;
  try {
    // Only the first line matters; a standalone build is a large binary.
    const descriptor = openSync(executable, "r");
    try {
      const head = Buffer.alloc(512);
      line = head.subarray(0, readSync(descriptor, head, 0, head.length, 0)).toString("utf8").split("\n", 1)[0] ?? "";
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
  if (!line.startsWith("#!")) return undefined;
  const words = line.slice(2).trim().split(/\s+/).filter(Boolean);
  if (path.basename(words[0] ?? "") !== "env") return words.length > 0 ? words : undefined;
  const rest = words.slice(1);
  while (rest[0]?.startsWith("-")) rest.shift();
  return rest.length > 0 ? rest : undefined;
}
