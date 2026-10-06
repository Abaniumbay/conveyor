// The packaged default configuration (examples/config), embedded in the executable and selected
// with `!include builtin:<path>`. Embedded files are written to disk before use, because agents read
// their instruction files by path.

import { CryptoHasher } from "bun";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import agents from "../../examples/config/agents.yaml" with { type: "text" };
import harnesses from "../../examples/config/harnesses.yaml" with { type: "text" };
import darya from "../../examples/config/instructions/darya.md" with { type: "text" };
import kaveh from "../../examples/config/instructions/kaveh.md" with { type: "text" };
import omid from "../../examples/config/instructions/omid.md" with { type: "text" };
import reviewer from "../../examples/config/instructions/reviewer.md" with { type: "text" };
import pipelines from "../../examples/config/pipelines.yaml" with { type: "text" };
import providers from "../../examples/config/providers.yaml" with { type: "text" };

import { ConfigError } from "./errors";

export const BUILTIN_FILES: Readonly<Record<string, string>> = {
  "agents.yaml": agents,
  "harnesses.yaml": harnesses,
  "instructions/darya.md": darya,
  "instructions/kaveh.md": kaveh,
  "instructions/omid.md": omid,
  "instructions/reviewer.md": reviewer,
  "pipelines.yaml": pipelines,
  "providers.yaml": providers,
};

/** A short content hash of the packaged defaults; it names their materialised copy. */
export function builtinDigest(): string {
  const hasher = new CryptoHasher("sha256");
  for (const name of Object.keys(BUILTIN_FILES).sort()) hasher.update(`${name}\0${BUILTIN_FILES[name]}\0`);
  return hasher.digest("hex").slice(0, 16);
}

/**
 * Writes the packaged defaults to `<directory>/<digest>/` (idempotently) and returns a resolver
 * from a `builtin:` path to its materialised file.
 */
export function builtinResolver(directory: string): (relative: string) => Promise<string> {
  const root = path.join(directory, builtinDigest());
  let written: Promise<void> | null = null;
  const materialise = async () => {
    for (const [name, content] of Object.entries(BUILTIN_FILES)) {
      const destination = path.join(root, name);
      if ((await readFile(destination, "utf8").catch(() => null)) === content) continue;
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.tmp`;
      await writeFile(temporary, content);
      await rename(temporary, destination);
    }
  };
  return async (relative) => {
    const name = path.posix.normalize(relative);
    if (!Object.hasOwn(BUILTIN_FILES, name)) {
      throw new ConfigError(`builtin:${relative} is not a packaged default; available: ${Object.keys(BUILTIN_FILES).join(", ")}`);
    }
    written ??= materialise();
    await written;
    return path.join(root, name);
  };
}
