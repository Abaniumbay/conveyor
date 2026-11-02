import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { BUILD } from "../../src/version";
import { agentFilesystemCommand, agentFilesystemPlan, sandboxCommand, type AgentFilesystemOptions } from "../../src/isolation/sandbox";
import { INTERNAL, selfCommand } from "../../src/self";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const unavailable = bwrapUnavailableReason();
const describeSandbox = unavailable ? describe.skip : describe;
if (unavailable) console.warn(`SKIPPED source MCP sandbox tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);

const checkout = path.resolve(import.meta.dir, "../..");
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function run() {
  const root = await shortTemporaryDirectory("conveyor-smcp-", { visibleInSandbox: true });
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const artifacts = path.join(root, "artifacts");
  const home = path.join(artifacts, "home");
  const scratch = path.join(artifacts, "scratch");
  const otherRun = path.join(root, "other-run");
  for (const directory of [workspace, home, scratch, otherRun]) await mkdir(directory, { recursive: true });
  const context = path.join(scratch, "context.json");
  await writeFile(context, JSON.stringify({
    version: 1, runId: "r1", stageId: "implementation",
    repository: { id: "r", address: "o/r", baseBranch: "main" },
    issue: { id: "i", number: 1, title: "t", body: "", labels: [], url: "http://127.0.0.1:1/" },
    workspace: { path: workspace, branch: "b" },
    delivery: { pullRequest: null, checks: [] },
    sourceGuidance: "",
    control: { url: "http://127.0.0.1:1/internal/mcp", token: "t" },
    allowedTools: ["agent.reportProgress"],
  }));
  const env = { PATH: process.env.PATH ?? "", HOME: home };
  const options: AgentFilesystemOptions = {
    command: "/bin/sh", env, workspace, artifacts, home, scratch, writable: [workspace, home, scratch], readable: [context],
  };
  return { options, context, otherRun, env, root };
}

const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

async function initialize(argv: string[], env: Record<string, string>) {
  const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
  child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
  child.stdin.end();
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const line = out.trim().split("\n")[0] ?? "";
  return { err, response: line ? JSON.parse(line) as { id?: number; result?: { protocolVersion?: string; serverInfo?: unknown } } : undefined };
}

describeSandbox("source-mode MCP server in the confined filesystem", () => {
  test("Codex filesystem plan answers initialize", async () => {
    const files = await run();
    const launch = agentFilesystemCommand({ ...files.options, command: "/bin/sh" }, selfCommand(INTERNAL.mcp, "--context", files.context));
    const { response, err } = await initialize(launch.argv, launch.env);
    expect(err).not.toContain("Cannot find");
    expect(response?.id).toBe(1);
    expect(response?.result?.protocolVersion).toBeString();
  });

  test("Claude Code filesystem plan (writable git, home, toolchain-free) answers initialize", async () => {
    const files = await run();
    const launch = agentFilesystemCommand({ ...files.options, command: "/bin/sh", writableGit: true, runtime: ["/usr/bin/git"] }, selfCommand(INTERNAL.mcp, "--context", files.context));
    const { response } = await initialize(launch.argv, launch.env);
    expect(response?.id).toBe(1);
    expect(response?.result?.serverInfo).toBeDefined();
  });

  test("answers initialize with network egress isolation enabled", async () => {
    const files = await run();
    const sandboxed = sandboxCommand({
      argv: selfCommand(INTERNAL.mcp, "--context", files.context),
      env: files.env,
      dataProxySocket: path.join(files.root, "data.sock"),
      filesystem: agentFilesystemPlan(files.options),
    });
    const { response } = await initialize(sandboxed.argv, sandboxed.env);
    expect(response?.id).toBe(1);
    expect(response?.result?.protocolVersion).toBeString();
  });

  async function probe(script: string) {
    const files = await run();
    const launch = agentFilesystemCommand(files.options, ["/bin/sh", "-c", script.replaceAll("$OTHER", files.otherRun)]);
    const child = Bun.spawnSync(launch.argv, { env: launch.env, stdout: "pipe", stderr: "pipe" });
    return { code: child.exitCode, out: child.stdout.toString() };
  }

  test("the checkout's .git and other entries are not visible", async () => {
    const result = await probe(`for p in ${checkout}/.git ${checkout}/tests ${checkout}/bun.lock; do test -e "$p" && echo "visible $p"; done; test -f ${checkout}/src/cli.ts && echo src-ok`);
    expect(result.out.trim()).toBe("src-ok");
  });

  test("the service home, configuration, secrets and other runs are not visible", async () => {
    const result = await probe(`for p in ${homedir()}/.local/share/conveyor-v2 ${homedir()}/.config ${homedir()}/.ssh ${homedir()}/.codex $OTHER; do test -e "$p" && echo "visible $p"; done; echo done`);
    expect(result.out.trim()).toBe("done");
  });

  test("what is mounted from the checkout is read-only", async () => {
    const result = await probe(`touch ${checkout}/src/new-file 2>/dev/null && echo src-written; touch ${checkout}/node_modules/new-file 2>/dev/null && echo deps-written; rm ${checkout}/package.json 2>/dev/null && echo pkg-removed; echo done`);
    expect(result.out.trim()).toBe("done");
  });
});

test("a compiled build mounts nothing from a source checkout", async () => {
  if (BUILD.compiled) return;
  const { sourceCheckoutRuntime } = await import("../../src/self");
  expect(sourceCheckoutRuntime().every((entry) => entry.startsWith(`${checkout}/`))).toBe(true);
  const original = Object.getOwnPropertyDescriptor(BUILD, "compiled")!;
  Object.defineProperty(BUILD, "compiled", { value: true, configurable: true });
  try {
    expect(sourceCheckoutRuntime()).toEqual([]);
    const files = await run();
    const mounted = agentFilesystemPlan(files.options).mounts;
    expect(mounted.some((mount) => mount === checkout || mount.startsWith(`${checkout}/`))).toBe(false);
  } finally {
    Object.defineProperty(BUILD, "compiled", original);
  }
});
