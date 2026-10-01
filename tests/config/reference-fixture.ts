import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../../examples");

/**
 * Builds a loadable configuration directory from the shipped reference configuration: a copy of
 * examples/config plus a machine-local file with settings and the example repositories, their
 * folders replaced by directories that exist. `rename` maps repository ids to other names.
 */
export async function referenceConfigDirectory(rename: Record<string, string> = {}): Promise<{ directory: string; base: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "conveyor-reference-"));
  const directory = path.join(base, "config");
  await cp(path.join(ROOT, "config"), directory, { recursive: true });

  const example = parse(await readFile(path.join(ROOT, "local/repositories.example.yaml"), "utf8")) as {
    repositories: Record<string, { folder: string }>;
  };
  const repositories: Record<string, unknown> = {};
  for (const [name, repository] of Object.entries(example.repositories)) {
    const folder = path.join(base, "repos", name);
    await mkdir(folder, { recursive: true });
    repositories[rename[name] ?? name] = { ...repository, folder };
  }
  const local = {
    settings: {
      database: path.join(base, "data/conveyor.sqlite"),
      logs: path.join(base, "data/logs"),
      workspaces: path.join(base, "data/worktrees"),
      artifacts: path.join(base, "data/artifacts"),
    },
    repositories,
  };
  await writeFile(path.join(directory, "local.yaml"), stringify(local));
  return { directory, base };
}
