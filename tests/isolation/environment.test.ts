import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cleanupSanitizedHome, prepareAgentEnvironment, prepareSanitizedHome, resolveBash } from "../../src/isolation/environment";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-isolation-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("prepareSanitizedHome", () => {
  test("creates <root>/<runId>/home with only user.name and user.email", async () => {
    const root = await temporary();
    const home = await prepareSanitizedHome({ root, runId: "run-1", gitUser: { name: "Ada Lovelace", email: "ada@example.com" } });
    expect(home).toBe(path.join(root, "run-1", "home"));
    expect(await readdir(home)).toEqual([".gitconfig"]);
    expect(await readFile(path.join(home, ".gitconfig"), "utf8")).toBe(
      '[user]\n\tname = "Ada Lovelace"\n\temail = "ada@example.com"\n',
    );
  });

  test("writes an empty gitconfig when no identity is known and escapes quotes", async () => {
    const root = await temporary();
    const home = await prepareSanitizedHome({ root, runId: "r", gitUser: {} });
    expect(await readFile(path.join(home, ".gitconfig"), "utf8")).toBe("");
    const quoted = await prepareSanitizedHome({ root, runId: "q", gitUser: { name: 'A "B"\nC' } });
    expect(await readFile(path.join(quoted, ".gitconfig"), "utf8")).toBe('[user]\n\tname = "A \\"B\\" C"\n');
  });

  test("strips control characters from git user values", async () => {
    const root = await temporary();
    const home = await prepareSanitizedHome({ root, runId: "c", gitUser: { name: "A\u0000B\u001bC\u007f", email: "a@b" } });
    expect(await readFile(path.join(home, ".gitconfig"), "utf8")).toBe('[user]\n\tname = "A B C "\n\temail = "a@b"\n');
  });

  test("is idempotent and rewrites a stale home", async () => {
    const root = await temporary();
    const home = await prepareSanitizedHome({ root, runId: "r", gitUser: { name: "A" } });
    await writeFile(path.join(home, ".netrc"), "machine x password y");
    await prepareSanitizedHome({ root, runId: "r", gitUser: { name: "A" } });
    expect(await readdir(home)).toEqual([".gitconfig"]);
  });

  test("removes only a run home without following symbolic links or deleting results", async () => {
    const root = await temporary();
    const run = path.join(root, "run");
    const target = path.join(root, "shared-cache");
    const home = await prepareSanitizedHome({ root, runId: "run", gitUser: {} });
    await mkdir(target);
    await writeFile(path.join(target, "state"), "keep");
    await symlink(target, path.join(home, ".cache"));
    await writeFile(path.join(run, "result.json"), "result");

    await cleanupSanitizedHome(run);

    expect(existsSync(home)).toBe(false);
    expect(await readFile(path.join(target, "state"), "utf8")).toBe("keep");
    expect(await readFile(path.join(run, "result.json"), "utf8")).toBe("result");
  });

  test("surfaces home deletion failures without removing the run result", async () => {
    const root = await temporary();
    const run = path.join(root, "run");
    await prepareSanitizedHome({ root, runId: "run", gitUser: {} });
    await writeFile(path.join(run, "result.json"), "result");
    await chmod(run, 0o500);
    try {
      await expect(cleanupSanitizedHome(run)).rejects.toThrow();
    } finally {
      await chmod(run, 0o700);
    }
    expect(await readFile(path.join(run, "result.json"), "utf8")).toBe("result");
  });
});

describe("an agent's environment", () => {
  test("is exactly the run's variables, with HOME and SHELL Conveyor's: nothing inherited, nothing filtered", async () => {
    const artifacts = path.join(await temporary(), "run-1");
    const env = await prepareAgentEnvironment({
      artifactsDirectory: artifacts,
      workspace: await temporary(),
      parent: { HOME: "/home/real", PATH: process.env.PATH ?? "", GH_TOKEN: "service", CODEX_HOME: "/home/real/.codex" },
      variables: { PATH: process.env.PATH ?? "", NPM_TOKEN: "listed", GH_HOST: "example.com" },
    });
    expect(env).toEqual({
      PATH: process.env.PATH ?? "", NPM_TOKEN: "listed", GH_HOST: "example.com",
      HOME: path.join(artifacts, "home"), SHELL: resolveBash(process.env.PATH)!,
    });
  });

  test("without variables it starts from the root default's, taken from the service", async () => {
    const env = await prepareAgentEnvironment({
      artifactsDirectory: path.join(await temporary(), "run-1"),
      workspace: await temporary(),
      parent: { HOME: "/home/real", PATH: process.env.PATH ?? "", LANG: "C", GH_TOKEN: "service", ANTHROPIC_API_KEY: "k" },
    });
    expect(env.LANG).toBe("C");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("the agent's shell", () => {
  const prepare = async (parent: Record<string, string>) => {
    const artifacts = path.join(await temporary(), "run-1");
    const workspace = await temporary();
    return prepareAgentEnvironment({ artifactsDirectory: artifacts, workspace, parent: { HOME: "/home/real", ...parent } });
  };

  test("is Conveyor's resolved absolute bash when the parent's SHELL is another shell", async () => {
    const env = await prepare({ PATH: process.env.PATH ?? "", SHELL: "/opt/login-shell" });
    expect(env.SHELL).toBe(resolveBash(process.env.PATH));
    expect(path.isAbsolute(env.SHELL!)).toBe(true);
    expect(path.basename(env.SHELL!)).toBe("bash");
  });

  test("is Conveyor's resolved bash when the parent has no SHELL", async () => {
    const env = await prepare({ PATH: process.env.PATH ?? "" });
    expect(env.SHELL).toBe(resolveBash(process.env.PATH));
  });

  test("a run's own SHELL override does not replace it", async () => {
    const artifacts = path.join(await temporary(), "run-1");
    const env = await prepareAgentEnvironment({ artifactsDirectory: artifacts, workspace: await temporary(), parent: { HOME: "/h", PATH: process.env.PATH ?? "" }, variables: { PATH: process.env.PATH ?? "", SHELL: "/opt/login-shell" } });
    expect(env.SHELL).toBe(resolveBash(process.env.PATH));
  });
});
