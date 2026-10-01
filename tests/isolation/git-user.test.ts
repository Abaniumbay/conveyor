import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readGitUser } from "../../src/isolation/environment";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function git(cwd: string, env: Record<string, string>, ...args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, env: { PATH: process.env.PATH!, ...env }, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

describe("readGitUser", () => {
  test("prefers the repository's local identity and reads nothing else", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-gituser-"));
    directories.push(directory);
    const globalConfig = path.join(directory, "global");
    await writeFile(globalConfig, '[user]\n\tname = Global\n\temail = g@example.com\n[credential]\n\thelper = store\n');
    const env = { GIT_CONFIG_GLOBAL: globalConfig, HOME: directory };
    await git(directory, env, "init", "-q");
    expect(await readGitUser(directory, env)).toEqual({ name: "Global", email: "g@example.com" });
    await git(directory, env, "config", "user.name", "Local");
    expect(await readGitUser(directory, env)).toEqual({ name: "Local", email: "g@example.com" });
  });

  test("returns an empty identity when none is configured", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-gituser-"));
    directories.push(directory);
    const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", HOME: directory };
    await git(directory, env, "init", "-q");
    expect(await readGitUser(directory, env)).toEqual({});
  });
});
