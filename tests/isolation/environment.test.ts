import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cleanupSanitizedHome, prepareAgentEnvironment, prepareSanitizedHome, resolveBash, sanitizedAgentEnvironment } from "../../src/isolation/environment";

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

  test("keeps explicitly listed control-plane variables and still drops unlisted secrets", () => {
    const env = sanitizedAgentEnvironment({ ...base, CODEX_HOME: "/custom/codex", CODEX_API_KEY: "k", OPENAI_API_KEY: "o" }, {
      home: "/run/home",
      controlPlane: ["CODEX_HOME"],
    });
    expect(env.CODEX_HOME).toBe("/custom/codex");
    expect(env.HOME).toBe("/run/home");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
  });

  test("invents no value for a listed control-plane variable the base does not set", () => {
    const env = sanitizedAgentEnvironment(base, { home: "/run/home", controlPlane: ["CODEX_HOME"] });
    expect(env.CODEX_HOME).toBeUndefined();
  });

  test("a control-plane name overrides the secret pattern", () => {
    const env = sanitizedAgentEnvironment({ ...base, HARNESS_TOKEN: "h" }, { home: "/h", controlPlane: ["HARNESS_TOKEN"] });
    expect(env.HARNESS_TOKEN).toBe("h");
    expect(env.GH_TOKEN).toBeUndefined();
  });

  test("drops git, gh, xdg, credential and cloud-key variables", () => {
    const names = [
      "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_SYSTEM", "GIT_SSH", "GIT_SSH_COMMAND",
      "GIT_CREDENTIAL_HELPER", "GIT_ASKPASS", "GH_HOST", "GH_PROMPT_DISABLED", "XDG_CONFIG_HOME",
      "XDG_DATA_HOME", "GOOGLE_APPLICATION_CREDENTIALS", "AWS_SHARED_CREDENTIAL", "AWS_ACCESS_KEY_ID",
    ];
    const env = sanitizedAgentEnvironment(
      { PATH: "/p", XDG_RUNTIME_DIR: "/run/user/1", ...Object.fromEntries(names.map((n) => [n, "x"])) },
      { home: "/h", controlPlane: [] },
    );
    expect(env).toEqual({ PATH: "/p", XDG_RUNTIME_DIR: "/run/user/1", HOME: "/h" });
  });

  test("strips userinfo from proxy values", () => {
    const env = sanitizedAgentEnvironment(
      { HTTPS_PROXY: "http://user:pw@proxy.local:3128", HTTP_PROXY: "http://proxy.local:3128", NO_PROXY: "localhost" },
      { home: "/h", controlPlane: [] },
    );
    expect(env).toMatchObject({ HTTPS_PROXY: "http://proxy.local:3128", HTTP_PROXY: "http://proxy.local:3128", NO_PROXY: "localhost" });
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

describe("a harness's control-plane variables", () => {
  test("a harness that does not list CODEX_HOME never inherits the parent's", async () => {
    const artifacts = path.join(await temporary(), "run-1");
    const env = await prepareAgentEnvironment({
      artifactsDirectory: artifacts,
      workspace: await temporary(),
      parent: { HOME: "/home/real", PATH: process.env.PATH ?? "", CODEX_HOME: "/home/real/.codex", CLAUDE_CONFIG_DIR: "/home/real/.claude" },
      controlPlane: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    });
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/real/.claude");
  });

  test("a harness inherits only the parent variables its control plane lists", async () => {
    const artifacts = path.join(await temporary(), "run-1");
    const env = await prepareAgentEnvironment({
      artifactsDirectory: artifacts,
      workspace: await temporary(),
      parent: { HOME: "/home/real", PATH: process.env.PATH ?? "", CODEX_HOME: "/home/real/.codex" },
      controlPlane: ["CODEX_HOME"],
    });
    expect(env.CODEX_HOME).toBe("/home/real/.codex");
  });
});

describe("the agent's shell", () => {
  const prepare = async (parent: Record<string, string>) => {
    const artifacts = path.join(await temporary(), "run-1");
    const workspace = await temporary();
    return prepareAgentEnvironment({ artifactsDirectory: artifacts, workspace, parent: { HOME: "/home/real", ...parent }, controlPlane: [] });
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
    const env = await prepareAgentEnvironment({ artifactsDirectory: artifacts, workspace: await temporary(), parent: { HOME: "/h", PATH: process.env.PATH ?? "" }, overrides: { SHELL: "/opt/login-shell" }, controlPlane: [] });
    expect(env.SHELL).toBe(resolveBash(process.env.PATH));
  });
});
