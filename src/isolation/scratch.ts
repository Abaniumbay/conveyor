import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ScratchDirectory {
  path: string;
  /** Removes only runner-owned, workspace-free scratch. */
  cleanup(): Promise<void>;
}

/** Uses persistent item scratch when supplied, otherwise creates disposable per-run storage. */
export async function acquireScratch(directory?: string): Promise<ScratchDirectory> {
  if (directory) {
    const resolved = path.resolve(directory);
    await mkdir(resolved, { recursive: true });
    return { path: resolved, cleanup: async () => {} };
  }
  const created = await mkdtemp(path.join(tmpdir(), "conveyor-run-"));
  return { path: created, cleanup: () => rm(created, { recursive: true, force: true }) };
}

/** Configured writable roots must not turn host /tmp back into durable agent storage. */
export function assertNoHostTmpWritableRoots(roots: readonly string[] | undefined): void {
  for (const root of roots ?? []) {
    const resolved = physicalPath(root);
    if (resolved === "/tmp" || resolved.startsWith("/tmp/")) {
      throw new Error(`agent writable root must not be host /tmp: ${root}`);
    }
  }
}

/** Resolves links in the deepest existing ancestor so configured roots cannot traverse into host /tmp. */
function physicalPath(root: string): string {
  const suffix: string[] = [];
  let candidate = path.resolve(root);
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    suffix.unshift(path.basename(candidate));
    candidate = parent;
  }
  return path.join(realpathSync(candidate), ...suffix);
}
