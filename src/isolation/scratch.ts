import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveFilesystemPath } from "../core/paths";

export interface ScratchDirectory {
  path: string;
  /** Removes only runner-owned, workspace-free scratch. */
  cleanup(): Promise<void>;
}

/** Uses persistent item scratch when supplied, otherwise creates disposable per-run storage. */
export async function acquireScratch(directory?: string): Promise<ScratchDirectory> {
  if (directory) {
    await mkdir(path.resolve(directory), { recursive: true });
    return { path: resolveFilesystemPath(directory), cleanup: async () => {} };
  }
  const created = await mkdtemp(path.join(tmpdir(), "conveyor-run-"));
  return { path: resolveFilesystemPath(created), cleanup: () => rm(created, { recursive: true, force: true }) };
}

/** Configured writable roots must not turn host /tmp back into durable agent storage. */
export function assertNoHostTmpWritableRoots(roots: readonly string[] | undefined): void {
  for (const root of roots ?? []) {
    // Nonexistent optional roots are omitted by all launchers.
    if (!existsSync(root)) continue;
    const resolved = resolveFilesystemPath(root);
    if (resolved === "/tmp" || resolved.startsWith("/tmp/")) {
      throw new Error(`agent writable root must not be host /tmp: ${root}`);
    }
  }
}
