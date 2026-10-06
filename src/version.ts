// The running Conveyor's version and build metadata. A release build defines CONVEYOR_BUILD
// (scripts/build.ts passes it to `bun build --define`); a source checkout reports package.json's
// version with commit "development".

import packageJson from "../package.json";

export interface BuildInfo {
  version: string;
  /** The Git commit the executable was built from, or "development" in a source checkout. */
  commit: string;
  /** ISO build time; null in a source checkout. */
  builtAt: string | null;
  /** Bun's version: the runtime embedded in the executable. */
  runtime: string;
  /** True inside the compiled executable. */
  compiled: boolean;
}

declare const CONVEYOR_BUILD: { version: string; commit: string; builtAt: string } | undefined;

const defined = typeof CONVEYOR_BUILD === "undefined" ? undefined : CONVEYOR_BUILD;

export const BUILD: BuildInfo = {
  version: defined?.version ?? packageJson.version,
  commit: defined?.commit ?? "development",
  builtAt: defined?.builtAt ?? null,
  runtime: Bun.version,
  compiled: import.meta.path.startsWith("/$bunfs/"),
};

export function versionLine(build: BuildInfo = BUILD): string {
  const details = [build.commit === "development" ? "development build" : `commit ${build.commit.slice(0, 12)}`];
  if (build.builtAt) details.push(`built ${build.builtAt}`);
  details.push(`bun ${build.runtime}`);
  return `conveyor ${build.version} (${details.join(", ")})`;
}
