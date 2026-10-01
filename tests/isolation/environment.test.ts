import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareSanitizedHome, sanitizedAgentEnvironment } from "../../src/isolation/environment";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-isolation-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("sanitizedAgentEnvironment", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/real",
    LANG: "C",
    GH_TOKEN: "a",
    GITHUB_TOKEN: "b",
    GH_ENTERPRISE_TOKEN: "c",
    GITHUB_ENTERPRISE_TOKEN: "d",
    GIT_ASKPASS: "/bin/ask",
    SSH_AUTH_SOCK: "/run/ssh",
    GH_CONFIG_DIR: "/home/real/.config/gh",
    GIT_CONFIG_GLOBAL: "/home/real/.gitconfig",
    CONVEYOR_CONFIG: "x",
    NPM_TOKEN: "t",
    AWS_SECRET_ACCESS_KEY: "s",
    DB_PASSWORD: "p",
    STRIPE_API_KEY: "k",
    MY_PRIVATE_KEY: "k",
    TOKENIZER_MODE: "fast",
    UNDEFINED_ONE: undefined,
  };

  test("drops provider credentials and secret-looking names, keeps the rest", () => {
    const env = sanitizedAgentEnvironment(base, { home: "/run/home", controlPlane: [] });
    expect(env).toEqual({ PATH: "/usr/bin", LANG: "C", HOME: "/run/home", TOKENIZER_MODE: "fast" });
  });

  test("keeps explicitly listed control-plane variables, resolving CODEX_HOME from the original HOME", () => {
    const secretish = sanitizedAgentEnvironment({ ...base, CODEX_API_KEY: "k", OPENAI_API_KEY: "o" }, {
      home: "/run/home",
      controlPlane: ["CODEX_HOME"],
    });
    expect(secretish.CODEX_HOME).toBe("/home/real/.codex");
    expect(secretish.HOME).toBe("/run/home");
    expect(secretish.OPENAI_API_KEY).toBeUndefined();
    expect(secretish.CODEX_API_KEY).toBeUndefined();
    const explicit = sanitizedAgentEnvironment({ ...base, CODEX_HOME: "/custom/codex" }, {
      home: "/run/home",
      controlPlane: ["CODEX_HOME"],
    });
    expect(explicit.CODEX_HOME).toBe("/custom/codex");
  });

  test("a control-plane name overrides the secret pattern", () => {
    const env = sanitizedAgentEnvironment({ ...base, HARNESS_TOKEN: "h" }, { home: "/h", controlPlane: ["HARNESS_TOKEN"] });
    expect(env.HARNESS_TOKEN).toBe("h");
    expect(env.GH_TOKEN).toBeUndefined();
  });

  test("never mutates the base", () => {
    const copy = { ...base };
    sanitizedAgentEnvironment(base, { home: "/h", controlPlane: [] });
    expect(base).toEqual(copy);
  });
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

  test("is idempotent and rewrites a stale home", async () => {
    const root = await temporary();
    const home = await prepareSanitizedHome({ root, runId: "r", gitUser: { name: "A" } });
    await writeFile(path.join(home, ".netrc"), "machine x password y");
    await prepareSanitizedHome({ root, runId: "r", gitUser: { name: "A" } });
    expect(await readdir(home)).toEqual([".gitconfig"]);
  });
});
