import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Returns one canonical spelling for a filesystem path.
 *
 * Existing paths are resolved with realpath. For a path a process will create,
 * its deepest existing parent is resolved first, preserving the new suffix.
 */
export function resolveFilesystemPath(value: string): string {
  const suffix: string[] = [];
  let candidate = path.resolve(value);
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    suffix.unshift(path.basename(candidate));
    candidate = parent;
  }
  return path.join(realpathSync(candidate), ...suffix);
}

/** Resolves absolute environment values while leaving non-path values unchanged. */
export function resolvePathEnvironment<T extends Record<string, string | undefined>>(environment: T): T {
  const resolved = { ...environment } as T;
  for (const [name, value] of Object.entries(resolved)) {
    if (value && path.isAbsolute(value) && !value.includes(path.delimiter)) {
      resolved[name as keyof T] = resolveFilesystemPath(value) as T[keyof T];
    }
  }
  return resolved;
}
