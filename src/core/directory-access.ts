import { chmod, lstat, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Restores the owning account's access to every directory under `target` (adds owner rwx) so it can be
 * removed. Never dereferences a symlink: a link pointing at a directory elsewhere is left untouched.
 * Rejects with ENOENT when `target` does not exist.
 */
export async function restoreDirectoryAccess(target: string): Promise<void> {
  const info = await lstat(target);
  if (!info.isDirectory()) return;
  await chmod(target, (info.mode & 0o7777) | 0o700);
  for (const entry of await readdir(target)) await restoreDirectoryAccess(path.join(target, entry));
}
