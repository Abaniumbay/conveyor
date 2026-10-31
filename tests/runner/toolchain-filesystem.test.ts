import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runClaudeCode } from "../../src/runner/claude-code";
import { runCodex } from "../../src/runner/codex";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const directories: string[] = [];
const unavailable = bwrapUnavailableReason();
if (unavailable) console.warn(`SKIPPED toolchain filesystem tests: \`bwrap\` is unavailable (${unavailable})`);
const describeSandbox = unavailable ? describe.skip : describe;

const PROBE = `
const result = {};
const toolchain = process.env.TOOLCHAIN;
result.marker = (await Bun.file(toolchain + "/marker").exists()) ? await Bun.file(toolchain + "/marker").text() : null;
try {
  await Bun.write(toolchain + "/written", "x");
  result.writable = true;
} catch {
  result.writable = false;
}
await Bun.write(process.env.CAPTURE, JSON.stringify(result));
`;

const FAKE_CODEX = `#!/usr/bin/env bun
${PROBE}
const args = process.argv.slice(2);
await Bun.write(args[args.indexOf("-o") + 1], JSON.stringify({ version: 1, outcome: "success", status: "done", summary: "ok", reason: null, metrics: {}, artifacts: [] }));
`;

const FAKE_CLAUDE = `#!/usr/bin/env bun
${PROBE}
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s", usage: { input_tokens: 1, output_tokens: 1 }, structured_output: { version: 1, outcome: "success", status: "done", summary: "ok", reason: null, metrics: {}, artifacts: [] } }));
`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(program: string) {
  const root = await shortTemporaryDirectory("conveyor-tcfs-", { visibleInSandbox: true });
  directories.push(root);
  const workspace = path.join(root, "workspace");
  const artifacts = path.join(root, "artifacts", "run");
  const runtime = path.join(root, "runtime");
  const toolchain = path.join(root, "sdk");
  const credentials = path.join(root, "credentials");
  const claudeConfig = path.join(root, "claude-config");
  await Promise.all([workspace, artifacts, runtime, toolchain, credentials, claudeConfig].map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(path.join(toolchain, "marker"), "sdk marker");
  await writeFile(path.join(credentials, "auth.json"), "x");
  const executable = path.join(runtime, "agent");
  await writeFile(executable, program);
  await chmod(executable, 0o755);
  const capture = path.join(artifacts, "capture.json");
  const env = { CAPTURE: capture, TOOLCHAIN: toolchain, CODEX_HOME: credentials, CLAUDE_CONFIG_DIR: claudeConfig };
  return { root, workspace, artifacts, executable, toolchain, capture, env };
}

describeSandbox("agent toolchain paths", () => {
  test("a Codex agent reads a marker in a declared toolchain path but cannot write it", async () => {
    const files = await fixture(FAKE_CODEX);
    await runCodex({
      command: files.executable, workspace: files.workspace, artifactsDirectory: files.artifacts,
      prompt: "x", sandbox: "workspace-write", automaticApprovals: false, mcp: { command: "bun", args: ["x"] },
      env: files.env, toolchainPaths: [files.toolchain],
    });
    const result = JSON.parse(await readFile(files.capture, "utf8"));
    expect(result.marker).toBe("sdk marker");
    expect(result.writable).toBe(false);
    expect(await Bun.file(path.join(files.toolchain, "written")).exists()).toBe(false);
  });

  test("a Claude Code agent reads a marker in a declared toolchain path but cannot write it", async () => {
    const files = await fixture(FAKE_CLAUDE);
    await runClaudeCode({
      command: files.executable, workspace: files.workspace, artifactsDirectory: files.artifacts,
      prompt: "x", sandbox: "workspace-write", automaticApprovals: false, mcp: { command: "bun", args: ["x"] },
      env: files.env, toolchainPaths: [files.toolchain],
    });
    const result = JSON.parse(await readFile(files.capture, "utf8"));
    expect(result.marker).toBe("sdk marker");
    expect(result.writable).toBe(false);
  });

  test("a toolchain path that is also a writable root is refused instead of becoming writable", async () => {
    const files = await fixture(FAKE_CODEX);
    await expect(runCodex({
      command: files.executable, workspace: files.workspace, artifactsDirectory: files.artifacts,
      prompt: "x", sandbox: "workspace-write", automaticApprovals: false, mcp: { command: "bun", args: ["x"] },
      env: files.env, toolchainPaths: [files.toolchain], writableRoots: [files.toolchain],
    })).rejects.toThrow("overlaps run path");
    expect(await Bun.file(files.capture).exists()).toBe(false);
  });

  for (const [name, run, program] of [["Codex", runCodex, FAKE_CODEX], ["Claude Code", runClaudeCode, FAKE_CLAUDE]] as const) {
    test(`a ${name} run fails before any agent command starts when a toolchain path cannot be mounted`, async () => {
      const files = await fixture(program);
      await expect(run({
        command: files.executable, workspace: files.workspace, artifactsDirectory: files.artifacts,
        prompt: "x", sandbox: "read-only", automaticApprovals: false, mcp: { command: "bun", args: ["x"] },
        env: files.env, toolchainPaths: [path.join(files.root, "missing-sdk")],
      })).rejects.toThrow("agent toolchain path cannot be mounted");
      expect(await Bun.file(files.capture).exists()).toBe(false);
    });
  }
});
