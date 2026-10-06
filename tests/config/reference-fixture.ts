import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../../examples");
/** The packaged defaults: each file is the value of the section it is named after. */
const SECTION_FILES = { "providers.yaml": "providers", "harnesses.yaml": "harnesses", "agents.yaml": "agents", "pipelines.yaml": "pipelines" } as const;

/** The example repositories with folders replaced by directories that exist, and the local settings. */
async function localSections(base: string, rename: Record<string, string>) {
  const example = parse(await readFile(path.join(ROOT, "local/repositories.example.yaml"), "utf8")) as {
    repositories: Record<string, { folder: string }>;
  };
  const repositories: Record<string, unknown> = {};
  for (const [name, repository] of Object.entries(example.repositories)) {
    const folder = path.join(base, "repos", name);
    await mkdir(folder, { recursive: true });
    repositories[rename[name] ?? name] = { ...repository, folder };
  }
  const settings = {
    database: path.join(base, "data/conveyor.sqlite"),
    logs: path.join(base, "data/logs"),
    workspaces: path.join(base, "data/worktrees"),
    artifacts: path.join(base, "data/artifacts"),
  };
  return { settings, repositories };
}

/**
 * Builds a loadable configuration directory (the deprecated directory mode) from the shipped
 * reference configuration: each section file wrapped back into a whole document, the instructions,
 * and a machine-local file with settings and the example repositories. `rename` maps repository ids
 * to other names.
 */
export async function referenceConfigDirectory(rename: Record<string, string> = {}): Promise<{ directory: string; base: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "conveyor-reference-"));
  const directory = path.join(base, "config");
  await cp(path.join(ROOT, "config/instructions"), path.join(directory, "instructions"), { recursive: true });
  for (const [file, section] of Object.entries(SECTION_FILES)) {
    const value = parse(await readFile(path.join(ROOT, "config", file), "utf8"), { maxAliasCount: -1 }) as unknown;
    await writeFile(path.join(directory, file), stringify({ [section]: value }, { aliasDuplicateObjects: false }));
  }
  await writeFile(path.join(directory, "local.yaml"), stringify(await localSections(base, rename)));
  return { directory, base };
}

/**
 * Builds a `conveyor.yaml` entrypoint that includes a copy of the packaged defaults, with settings
 * and the example repositories (one file each under `repositories/`).
 */
export async function referenceConfigEntrypoint(rename: Record<string, string> = {}): Promise<{ entrypoint: string; directory: string; base: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "conveyor-reference-"));
  const directory = path.join(base, "config");
  await cp(path.join(ROOT, "config"), path.join(directory, "defaults"), { recursive: true });
  const { settings, repositories } = await localSections(base, rename);
  await mkdir(path.join(directory, "repositories"), { recursive: true });
  for (const [name, repository] of Object.entries(repositories)) {
    await writeFile(path.join(directory, "repositories", `${name}.yaml`), stringify(repository));
  }
  const includes = Object.entries(SECTION_FILES).map(([file, section]) => `${section}: !include defaults/${file}`);
  const entrypoint = path.join(directory, "conveyor.yaml");
  await writeFile(entrypoint, [stringify({ settings }), ...includes, "repositories: !include_dir_named repositories/", ""].join("\n"));
  return { entrypoint, directory, base };
}

/** The YAML files of the packaged defaults, relative to examples/config. */
export async function referenceYamlFiles(): Promise<string[]> {
  return (await readdir(path.join(ROOT, "config"), { recursive: true })).filter((file) => /\.ya?ml$/i.test(file)).sort();
}
