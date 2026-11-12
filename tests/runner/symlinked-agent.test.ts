import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { agentFilesystemCommand, verifyAgentWrapper } from "../../src/isolation/sandbox";
import { runClaudeCode } from "../../src/plugins/claude-code/claude-code";
import { runCodex } from "../../src/plugins/codex/codex";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const unavailable = bwrapUnavailableReason();
if (unavailable) console.warn(`SKIPPED symlinked agent tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);
const describeSandbox = unavailable ? describe.skip : describe;

const directories: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// Serves both harnesses: Codex takes its answer from `-o`, Claude Code prints it as a result event.
const FAKE_AGENT = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const exists = (file) => Bun.file(file).exists();
const checks = JSON.parse(process.env.CHECKS);
await Bun.write(process.env.CAPTURE, JSON.stringify({
  started: true,
  symlinkSibling: await exists(checks.symlinkSibling),
  installationSibling: await exists(checks.installationSibling),
}));
const answer = { version: 1, outcome: "success", status: "done", summary: "ok", reason: null, metrics: {}, artifacts: [] };
if (args.includes("-o")) await Bun.write(args[args.indexOf("-o") + 1], JSON.stringify(answer));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s", usage: { input_tokens: 1, output_tokens: 1 }, structured_output: answer }));
`;

/** Installs `bin/agent` -> `current/bin/agent` -> `releases/1/bin/agent`, the standalone installer's layout. */
async function install() {
  const root = await shortTemporaryDirectory("conveyor-sl-", { socketPath: "artifacts/run-1/net/control.sock", visibleInSandbox: true });
  directories.push(root);
  const release = path.join(root, "releases", "1");
  const bin = path.join(root, "bin");
  await Promise.all([path.join(release, "bin"), bin, path.join(root, "workspace"), path.join(root, "artifacts", "run-1")].map((directory) => mkdir(directory, { recursive: true })));
  const real = path.join(release, "bin", "agent");
  await writeFile(real, FAKE_AGENT);
  await chmod(real, 0o755);
  await writeFile(path.join(bin, "sibling"), "hidden");
  await writeFile(path.join(release, "sibling"), "hidden");
  await symlink(release, path.join(root, "current"));
  await symlink(path.join(root, "current", "bin", "agent"), path.join(bin, "agent"));
  return {
    root,
    link: path.join(bin, "agent"),
    bin,
    real,
    workspace: path.join(root, "workspace"),
    artifacts: path.join(root, "artifacts", "run-1"),
    checks: JSON.stringify({ symlinkSibling: path.join(bin, "sibling"), installationSibling: path.join(release, "sibling") }),
  };
}

async function model(): Promise<net.Server> {
  const server = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server;
}

async function egress() {
  const server = await model();
  return {
    httpsHosts: ["registry.fake.test"],
    controlPlaneHosts: ["model.fake.test"],
    resolve: async () => ["203.0.113.1"],
    dial: () => net.connect((server.address() as net.AddressInfo).port, "127.0.0.1"),
  };
}

type Naming = "path" | "absolute";

async function launch(harness: "codex" | "claude", naming: Naming, withEgress: boolean, hops: "one" | "chain" = "chain") {
  const files = await install();
  if (hops === "one") {
    await rm(path.join(files.bin, "agent"));
    await symlink(files.real, path.join(files.bin, "agent"));
  }
  const capture = path.join(files.artifacts, "capture.json");
  const base = {
    command: naming === "path" ? "agent" : files.link,
    workspace: files.workspace,
    artifactsDirectory: files.artifacts,
    prompt: "go",
    sandbox: "read-only" as const,
    automaticApprovals: false,
    mcp: { command: "bun", args: ["x"] },
    env: { CAPTURE: capture, CHECKS: files.checks, PATH: `${files.bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: path.join(files.root, "claude-config") },
    ...(withEgress ? { egress: await egress() } : {}),
  };
  await (harness === "codex" ? runCodex(base) : runClaudeCode(base));
  return JSON.parse(await readFile(capture, "utf8")) as { started: boolean; symlinkSibling: boolean; installationSibling: boolean };
}

describeSandbox("agents installed behind a symlink", () => {
  test("Codex behind a one-hop symlink named by PATH lookup starts", async () => {
    expect((await launch("codex", "path", false, "one")).started).toBe(true);
  });

  test("Codex behind a symlink chain named by PATH lookup starts", async () => {
    expect((await launch("codex", "path", false)).started).toBe(true);
  });

  test("Codex behind a symlink chain named by its absolute symlink path starts", async () => {
    expect((await launch("codex", "absolute", false)).started).toBe(true);
  });

  test("Codex behind a symlink chain starts in the egress-isolated launch", async () => {
    expect((await launch("codex", "path", true)).started).toBe(true);
  });

  test("Claude Code behind a symlink chain named by PATH lookup starts", async () => {
    expect((await launch("claude", "path", false)).started).toBe(true);
  });

  test("Claude Code behind a symlink chain named by its absolute symlink path starts", async () => {
    expect((await launch("claude", "absolute", false)).started).toBe(true);
  });

  test("Claude Code behind a symlink chain starts in the egress-isolated launch", async () => {
    expect((await launch("claude", "path", true)).started).toBe(true);
  });

  test("exposing a symlinked command does not reveal the symlink's or the installation's directory", async () => {
    for (const harness of ["codex", "claude"] as const) {
      const result = await launch(harness, "path", false);
      expect(result).toEqual({ started: true, symlinkSibling: false, installationSibling: false });
    }
    const egressResult = await launch("claude", "path", true);
    expect(egressResult).toEqual({ started: true, symlinkSibling: false, installationSibling: false });
  });

  test("the launch probe fails before any agent starts when the command is missing in the namespace", async () => {
    const files = await install();
    const home = path.join(files.artifacts, "home");
    const scratch = path.join(files.artifacts, "scratch");
    await Promise.all([mkdir(home), mkdir(scratch)]);
    const wrapped = agentFilesystemCommand({
      command: files.link, env: { PATH: process.env.PATH ?? "", HOME: home },
      workspace: files.workspace, artifacts: files.artifacts, home, scratch,
    }, [files.real]);

    expect(() => verifyAgentWrapper(wrapped, files.real)).not.toThrow();
    const missing = path.join(files.bin, "not-mounted");
    expect(() => verifyAgentWrapper(wrapped, missing)).toThrow(`Agent command ${missing} cannot be found inside the confined filesystem`);
    expect(() => verifyAgentWrapper(wrapped, missing)).toThrow("Set the runner's command");
  });
});
