import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { acquireScratch } from "../../src/isolation/scratch";
import { agentFilesystemCommand, agentFilesystemPlan, sandboxCommand, type AgentFilesystemOptions } from "../../src/isolation/sandbox";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function run(): Promise<AgentFilesystemOptions & { root: string }> {
  const root = await shortTemporaryDirectory("conveyor-ptmp-", { visibleInSandbox: true });
  cleanup.push(root);
  const workspace = path.join(root, "workspace");
  const artifacts = path.join(root, "artifacts", "run");
  const home = path.join(artifacts, "home");
  const scratch = path.join(artifacts, "scratch");
  for (const directory of [workspace, home, scratch]) await mkdir(directory, { recursive: true });
  return { root, command: process.execPath, env: { PATH: process.env.PATH ?? "" }, workspace, artifacts, home, scratch };
}

function inside(options: AgentFilesystemOptions, script: string, egress = false) {
  const argv = [process.execPath, "-e", script];
  const launch = egress
    ? sandboxCommand({
        argv,
        env: { PATH: process.env.PATH ?? "", HOME: options.home },
        dataProxySocket: path.join(options.artifacts, "data.sock"),
        filesystem: { mounts: agentFilesystemPlan(options).mounts },
      })
    : agentFilesystemCommand(options, argv);
  const child = Bun.spawnSync(launch.argv, { env: launch.env, stdout: "pipe", stderr: "pipe" });
  return { code: child.exitCode, out: child.stdout.toString().trim(), err: child.stderr.toString() };
}

const roundTrip = `
  const fs = require("node:fs");
  fs.writeFileSync("/tmp/probe", "hello");
  fs.mkdirSync("/tmp/nested/dir", { recursive: true });
  console.log(fs.readFileSync("/tmp/probe", "utf8"));`;

describe("plan", () => {
  test("every launch variant mounts a private tmpfs at /tmp", async () => {
    const options = await run();
    for (const variant of [options, { ...options, writableGit: true, writable: [options.workspace] }, { ...options, readable: [] }]) {
      const mounts = agentFilesystemPlan(variant).mounts;
      expect(mounts.join("\0")).toContain(["--tmpfs", "/tmp"].join("\0"));
      expect(mounts.indexOf("--tmpfs")).toBeLessThan(mounts.indexOf("--remount-ro"));
    }
  });
});

const unavailable = bwrapUnavailableReason();
const describeSandbox = unavailable ? describe.skip : describe;

describeSandbox("private /tmp in a real bubblewrap run", () => {
  test("a Claude-style launch (no egress, write access) can create, write and read under /tmp", async () => {
    const options = await run();
    const result = inside({ ...options, writableGit: true, writable: [options.workspace] }, roundTrip);
    expect(result.err).toBe("");
    expect(result.out).toBe("hello");
  });

  test("a Codex-style egress-wrapped launch can create, write and read under /tmp", async () => {
    const options = await run();
    const result = inside({ ...options, writableGit: true, writable: [options.workspace] }, roundTrip, true);
    expect(result.err).toBe("");
    expect(result.out).toBe("hello");
  });

  test("a file in the host /tmp is not visible inside", async () => {
    const options = await run();
    const marker = `/tmp/conveyor-host-marker-${process.pid}-${Date.now()}`;
    await writeFile(marker, "host");
    cleanup.push(marker);
    for (const egress of [false, true]) {
      const result = inside(options, `console.log(require("node:fs").existsSync(${JSON.stringify(marker)}))`, egress);
      expect(result.out).toBe("false");
    }
  });

  test("a file written to /tmp by one run is not visible in another run or on the host", async () => {
    const options = await run();
    const marker = `/tmp/conveyor-shared-${process.pid}-${Date.now()}`;
    expect(inside(options, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"); console.log("written")`).out).toBe("written");
    expect(inside(options, `console.log(require("node:fs").existsSync(${JSON.stringify(marker)}))`).out).toBe("false");
    const other = await run();
    expect(inside(other, `console.log(require("node:fs").existsSync(${JSON.stringify(marker)}))`).out).toBe("false");
    expect(existsSync(marker)).toBe(false);
  });

  test("a read-only run can write under /tmp but not to its worktree", async () => {
    const options = await run();
    const script = `
      const fs = require("node:fs");
      fs.writeFileSync("/tmp/scratch-file", "x");
      let worktree = true;
      try { fs.writeFileSync(${JSON.stringify(path.join(options.workspace, "written"))}, "x"); } catch { worktree = false; }
      console.log(JSON.stringify({ tmp: fs.readFileSync("/tmp/scratch-file", "utf8"), worktree }));`;
    for (const egress of [false, true]) {
      const result = inside(options, script, egress);
      expect(result.err).toBe("");
      expect(JSON.parse(result.out)).toEqual({ tmp: "x", worktree: false });
    }
    expect(existsSync(path.join(options.workspace, "written"))).toBe(false);
  });

  test("a run directory under host /tmp stays visible, and a /tmp file does not outlive the run's scratch", async () => {
    const scratch = await acquireScratch();
    const options = await run();
    const configured = { ...options, scratch: scratch.path };
    const result = inside(configured, `require("node:fs").writeFileSync("/tmp/file", "x"); console.log(require("node:fs").existsSync(${JSON.stringify(scratch.path)}))`);
    expect(result.err).toBe("");
    expect(result.out).toBe("true");
    await scratch.cleanup();
    expect(existsSync(scratch.path)).toBe(false);
    const next = await acquireScratch();
    try {
      expect(inside({ ...options, scratch: next.path }, `console.log(require("node:fs").existsSync("/tmp/file"))`).out).toBe("false");
    } finally {
      await next.cleanup();
    }
  });
});


describe("documentation", () => {
  test("configuration docs and SPEC state confined agents have a private, writable /tmp", async () => {
    const root = path.resolve(import.meta.dir, "../..");
    const docs = await Bun.file(path.join(root, "docs/configuration.md")).text();
    const spec = await Bun.file(path.join(root, "SPEC.md")).text();
    expect(docs).toContain("private, writable `/tmp`");
    expect(spec).toContain("private, writable `/tmp`");
  });
});
