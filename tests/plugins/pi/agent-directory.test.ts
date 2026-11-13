import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { preparePiAgentDirectory, servicePiAgentDirectory, syncPiAgentDirectory } from "../../../src/plugins/pi/agent-directory";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-pi-agent-dir-"));
  directories.push(root);
  const home = path.join(root, "run", "home");
  const service = path.join(root, "service");
  await mkdir(home, { recursive: true });
  await mkdir(service);
  const prepare = (resumeSessionId?: string) => preparePiAgentDirectory({ home, serviceDirectory: service, settings: { shellPath: "/bin/bash" }, mcp: { mcpServers: {} }, resumeSessionId });
  const sync = () => syncPiAgentDirectory({ home, serviceDirectory: service });
  const stored = path.join(service, "conveyor-sessions");
  return { root, home, service, stored, prepare, sync, privateDirectory: path.join(home, ".pi", "agent") };
}

describe("servicePiAgentDirectory", () => {
  test("is the configured directory first, then the inherited variable, then ~/.pi/agent", () => {
    expect(servicePiAgentDirectory({ PI_CODING_AGENT_DIR: "/srv/pi" }, { HOME: "/home/real", PI_CODING_AGENT_DIR: "/inherited" })).toBe("/srv/pi");
    expect(servicePiAgentDirectory(undefined, { HOME: "/home/real", PI_CODING_AGENT_DIR: "/inherited" })).toBe("/inherited");
    expect(servicePiAgentDirectory(undefined, { HOME: "/home/real" })).toBe("/home/real/.pi/agent");
    expect(() => servicePiAgentDirectory(undefined, {})).toThrow("neither PI_CODING_AGENT_DIR nor HOME");
  });
});

describe("preparePiAgentDirectory", () => {
  test("copies only the login into the run's home and writes Conveyor's settings and servers", async () => {
    const f = await fixture();
    await writeFile(path.join(f.service, "auth.json"), '{"k":1}');
    await writeFile(path.join(f.service, "trust.json"), '{"/":"trusted"}');
    await writeFile(path.join(f.service, "settings.json"), '{"defaultModel":"x"}');

    const prepared = await f.prepare();

    expect(prepared).toEqual({ directory: f.privateDirectory, sessions: path.join(f.privateDirectory, "sessions") });
    expect((await readdir(f.privateDirectory)).sort()).toEqual(["auth.json", "mcp.json", "sessions", "settings.json"]);
    expect(await readFile(path.join(f.privateDirectory, "auth.json"), "utf8")).toBe('{"k":1}');
    expect(JSON.parse(await readFile(path.join(f.privateDirectory, "settings.json"), "utf8"))).toEqual({ shellPath: "/bin/bash" });
  });

  test("copies only the resumed session's record, and refuses an id that is not a pi session id", async () => {
    const f = await fixture();
    await mkdir(f.stored);
    await writeFile(path.join(f.stored, "2026-01-01T00-00-00-000Z_sess-1.jsonl"), "one\n");
    await writeFile(path.join(f.stored, "2026-01-01T00-00-00-000Z_sess-2.jsonl"), "two\n");

    const prepared = await f.prepare("sess-1");

    expect(prepared.resumeFile).toBe(path.join(f.privateDirectory, "sessions", "2026-01-01T00-00-00-000Z_sess-1.jsonl"));
    expect(await readdir(path.join(f.privateDirectory, "sessions"))).toEqual(["2026-01-01T00-00-00-000Z_sess-1.jsonl"]);
    await expect(f.prepare("../sess-1")).rejects.toThrow("is not a pi session id");
  });
});

describe("syncPiAgentDirectory", () => {
  test("returns session records and a refreshed, well-formed login only", async () => {
    const f = await fixture();
    await writeFile(path.join(f.service, "auth.json"), '{"token":"old"}');
    await f.prepare();
    await writeFile(path.join(f.privateDirectory, "sessions", "2026-01-01T00-00-00-000Z_new.jsonl"), "record\n");
    await writeFile(path.join(f.privateDirectory, "sessions", "notes.txt"), "not a session");
    await writeFile(path.join(f.privateDirectory, "auth.json"), '{"token":"new"}');
    await writeFile(path.join(f.privateDirectory, "settings.json"), '{"shellCommandPrefix":"evil"}');
    await writeFile(path.join(f.privateDirectory, "trust.json"), "{}");

    await f.sync();

    expect(await readdir(f.stored)).toEqual(["2026-01-01T00-00-00-000Z_new.jsonl"]);
    expect(await readFile(path.join(f.service, "auth.json"), "utf8")).toBe('{"token":"new"}');
    expect((await readdir(f.service)).sort()).toEqual(["auth.json", "conveyor-sessions"]);
  });

  test("never follows a symbolic link the agent left in its agent directory", async () => {
    const f = await fixture();
    const secret = path.join(f.root, "secret");
    await mkdir(secret);
    await writeFile(path.join(secret, "2026-01-01T00-00-00-000Z_leak.jsonl"), "secret\n");
    await writeFile(path.join(secret, "token.json"), '{"secret":true}');
    await f.prepare();
    await symlink(path.join(secret, "2026-01-01T00-00-00-000Z_leak.jsonl"), path.join(f.privateDirectory, "sessions", "2026-01-01T00-00-00-000Z_link.jsonl"));
    await rm(path.join(f.privateDirectory, "auth.json"), { force: true });
    await symlink(path.join(secret, "token.json"), path.join(f.privateDirectory, "auth.json"));

    await f.sync();

    expect(existsSync(f.stored) ? await readdir(f.stored) : []).toEqual([]);
    expect(existsSync(path.join(f.service, "auth.json"))).toBe(false);
  });

  test("ignores a session directory or agent directory replaced by a symbolic link", async () => {
    const f = await fixture();
    const secret = path.join(f.root, "secret");
    await mkdir(secret);
    await writeFile(path.join(secret, "2026-01-01T00-00-00-000Z_leak.jsonl"), "secret\n");
    await writeFile(path.join(secret, "auth.json"), '{"secret":true}');
    await f.prepare();
    await rm(path.join(f.privateDirectory, "sessions"), { recursive: true });
    await symlink(secret, path.join(f.privateDirectory, "sessions"));
    await f.sync();
    expect(existsSync(f.stored)).toBe(false);

    await rm(path.join(f.home, ".pi"), { recursive: true });
    await symlink(secret, path.join(f.home, ".pi"));
    await mkdir(path.join(secret, "agent"));
    await writeFile(path.join(secret, "agent", "auth.json"), '{"secret":true}');
    await f.sync();
    expect(existsSync(path.join(f.service, "auth.json"))).toBe(false);
  });
});
