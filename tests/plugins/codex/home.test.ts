import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareCodexEnvironment, serviceCodexHome, syncCodexHome } from "../../../src/plugins/codex/home";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-codex-home-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("serviceCodexHome", () => {
  test("is an explicit override first, then the inherited variable", () => {
    expect(serviceCodexHome({ CODEX_HOME: "/custom/codex" }, { HOME: "/home/real", CODEX_HOME: "/inherited/codex" })).toBe("/custom/codex");
    expect(serviceCodexHome(undefined, { HOME: "/home/real", CODEX_HOME: "/inherited/codex" })).toBe("/inherited/codex");
  });

  test("resolves ~/.codex from the original HOME", () => {
    expect(serviceCodexHome(undefined, { HOME: "/home/real" })).toBe("/home/real/.codex");
  });

  test("throws when ~/.codex cannot be located", () => {
    expect(() => serviceCodexHome(undefined, { PATH: "/p" })).toThrow("neither CODEX_HOME nor HOME");
  });
});

describe("prepareCodexEnvironment", () => {
  async function workspaceIn(root: string): Promise<string> {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    return workspace;
  }

  test("gives the run a private Codex home holding a copy of the login and the resumed session only", async () => {
    const root = await temporary();
    const serviceHome = path.join(root, "service-codex");
    await mkdir(path.join(serviceHome, "sessions", "2026"), { recursive: true });
    await writeFile(path.join(serviceHome, "auth.json"), '{"tokens":"service"}');
    await writeFile(path.join(serviceHome, "sessions", "2026", "rollout-resumed.jsonl"), "resumed\n");
    await writeFile(path.join(serviceHome, "sessions", "2026", "rollout-other.jsonl"), "other\n");

    const env = await prepareCodexEnvironment({
      artifactsDirectory: path.join(root, "artifacts", "run-1"),
      workspace: await workspaceIn(root),
      parent: { HOME: "/home/real", PATH: process.env.PATH ?? "", CODEX_HOME: serviceHome, OPENAI_API_KEY: "secret" },
      resumeSessionId: "resumed",
    });

    const privateHome = path.join(env.HOME!, ".codex");
    expect(env.CODEX_HOME).toBe(privateHome);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(await readFile(path.join(privateHome, "auth.json"), "utf8")).toBe('{"tokens":"service"}');
    expect(await readFile(path.join(privateHome, "sessions", "2026", "rollout-resumed.jsonl"), "utf8")).toBe("resumed\n");
    expect(existsSync(path.join(privateHome, "sessions", "2026", "rollout-other.jsonl"))).toBe(false);
  });

  test("reads the login from ~/.codex when CODEX_HOME is not set", async () => {
    const root = await temporary();
    const home = path.join(root, "home");
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "auth.json"), '{"tokens":"default"}');

    const env = await prepareCodexEnvironment({
      artifactsDirectory: path.join(root, "artifacts", "run-1"),
      workspace: await workspaceIn(root),
      parent: { HOME: home, PATH: process.env.PATH ?? "" },
    });

    expect(await readFile(path.join(env.CODEX_HOME!, "auth.json"), "utf8")).toBe('{"tokens":"default"}');
  });
});

describe("syncCodexHome", () => {
  async function homes() {
    const root = await temporary();
    const privateHome = path.join(root, "private");
    const serviceHome = path.join(root, "service");
    await mkdir(path.join(privateHome, "sessions", "2026"), { recursive: true });
    await mkdir(serviceHome, { recursive: true });
    return { root, privateHome, serviceHome };
  }

  test("does not promote an auth.json symlink to a host file", async () => {
    const { root, privateHome, serviceHome } = await homes();
    await writeFile(path.join(serviceHome, "auth.json"), '{"tokens":"service"}');
    await writeFile(path.join(root, "ssh-key"), '{"secret":"key"}');
    await symlink(path.join(root, "ssh-key"), path.join(privateHome, "auth.json"));
    await syncCodexHome({ privateHome, serviceHome });
    expect(await readFile(path.join(serviceHome, "auth.json"), "utf8")).toBe('{"tokens":"service"}');
  });

  test("does not promote a malformed auth.json", async () => {
    const { privateHome, serviceHome } = await homes();
    await writeFile(path.join(serviceHome, "auth.json"), '{"tokens":"service"}');
    await writeFile(path.join(privateHome, "auth.json"), "junk");
    await syncCodexHome({ privateHome, serviceHome });
    expect(await readFile(path.join(serviceHome, "auth.json"), "utf8")).toBe('{"tokens":"service"}');
  });

  test("promotes a refreshed auth record and regular session files but not symlinked sessions", async () => {
    const { root, privateHome, serviceHome } = await homes();
    await writeFile(path.join(serviceHome, "auth.json"), '{"tokens":"old"}');
    await writeFile(path.join(privateHome, "auth.json"), '{"tokens":"new"}');
    await writeFile(path.join(privateHome, "sessions", "2026", "rollout-abc.jsonl"), "{}\n");
    await writeFile(path.join(root, "outside"), "private");
    await symlink(path.join(root, "outside"), path.join(privateHome, "sessions", "2026", "rollout-link.jsonl"));
    await syncCodexHome({ privateHome, serviceHome });
    expect(await readFile(path.join(serviceHome, "auth.json"), "utf8")).toBe('{"tokens":"new"}');
    expect(await readFile(path.join(serviceHome, "sessions", "2026", "rollout-abc.jsonl"), "utf8")).toBe("{}\n");
    expect(existsSync(path.join(serviceHome, "sessions", "2026", "rollout-link.jsonl"))).toBe(false);
  });
});
