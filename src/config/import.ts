import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { ConfigError } from "./errors";

export interface ImportSpec {
  repository: string;
  ref: string;
  path: string;
}

export interface ResolvedImport extends ImportSpec {
  /** The commit the ref resolved to; the pin recorded in the configuration hash. */
  sha: string;
  /** Materialised YAML files (sorted), each at its place in the copy under artifacts. */
  yamlFiles: string[];
}

export function parseImportSpec(value: unknown, filename: string): ImportSpec {
  const fail = (message: string): never => {
    throw new ConfigError(`${filename}: import${message}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(" must be an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["repository", "ref", "path"].includes(key)) fail(`.${key} is not a known key (repository, ref, path)`);
  }
  for (const key of ["repository", "ref", "path"]) {
    if (typeof record[key] !== "string" || record[key] === "") fail(`.${key} must be a non-empty string`);
  }
  if ((record.ref as string).startsWith("-")) fail('.ref must not start with "-"');
  const repository = record.repository as string;
  if (!path.isAbsolute(repository)) fail(".repository must be an absolute path to a git checkout");
  const directory = path.posix.normalize(record.path as string).replace(/\/+$/, "");
  if (directory === "" || directory === "." || directory.startsWith("..") || path.posix.isAbsolute(directory)) {
    fail(".path must be a directory inside the repository");
  }
  return { repository, ref: record.ref as string, path: directory };
}

async function git(repository: string, args: string[]): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  const child = Bun.spawn(["git", "-C", repository, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { ok: code === 0, stdout: Buffer.from(stdout), stderr: stderr.trim() };
}

/**
 * Reads the directory at the pinned ref (never the working tree) and writes every file
 * under it to `<artifacts>/config-imports/<sha>/<path>/...`, idempotently.
 */
export async function materialiseImport(spec: ImportSpec, artifacts: string): Promise<ResolvedImport> {
  const resolved = await git(spec.repository, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${spec.ref}^{commit}`]);
  if (!resolved.ok) {
    throw new ConfigError(
      `import.ref "${spec.ref}" does not resolve to a commit in ${spec.repository}${resolved.stderr ? `: ${resolved.stderr}` : ""}`,
    );
  }
  const sha = resolved.stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new ConfigError(`import.ref "${spec.ref}" resolved to an unexpected value`);

  const listing = await git(spec.repository, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha, "--", spec.path]);
  if (!listing.ok) throw new ConfigError(`cannot list ${spec.path} at ${spec.ref} in ${spec.repository}: ${listing.stderr}`);
  const files = listing.stdout.toString("utf8").split("\0").filter(Boolean).sort();

  const copy = path.join(artifacts, "config-imports", sha);
  const yamlFiles: string[] = [];
  for (const file of files) {
    const content = await git(spec.repository, ["show", `${sha}:${file}`]);
    if (!content.ok) throw new ConfigError(`cannot read ${file} at ${spec.ref}: ${content.stderr}`);
    const destination = path.join(copy, file);
    const inside = path.relative(path.join(copy, spec.path), destination);
    if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
      throw new ConfigError(`refusing to materialise ${file}: it is outside import.path ${spec.path}`);
    }
    const existing = await readFile(destination).catch(() => undefined);
    if (!existing || !existing.equals(content.stdout)) {
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, content.stdout);
      await rename(temporary, destination);
    }
    if (/\.ya?ml$/i.test(file)) yamlFiles.push(destination);
  }
  if (yamlFiles.length === 0) {
    throw new ConfigError(`no YAML configuration files found at ${spec.ref}:${spec.path} in ${spec.repository}`);
  }
  return { ...spec, sha, yamlFiles };
}
