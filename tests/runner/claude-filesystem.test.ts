import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runClaudeCode } from "../../src/runner/claude-code";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const directories: string[] = [];
const unavailable = bwrapUnavailableReason();
if (unavailable) console.warn(`SKIPPED Claude filesystem tests: \`bwrap\` is unavailable (${unavailable})`);
const describeSandbox = unavailable ? describe.skip : describe;

const FAKE_CLAUDE = `#!/usr/bin/env bun
const checks = JSON.parse(process.env.CHECKS);
const readable = async (file) => await Bun.file(file).exists();
const result = {};
for (const [name, file] of Object.entries(checks.files)) result[name] = await readable(file);
result.workspaceContents = await Bun.file(checks.workspaceMarker).text();
try {
  await Bun.write(checks.workspace + "/write-marker", "workspace write");
  result.workspaceWritable = true;
} catch {
  result.workspaceWritable = false;
}
result.home = await readable(process.env.HOME + "/.gitconfig");
const scratchMarker = process.env.TMPDIR + "/scratch-marker";
await Bun.write(scratchMarker, "private scratch");
result.scratch = await Bun.file(scratchMarker).text() === "private scratch";
const git = Bun.spawnSync(["git", "cat-file", "-p", "HEAD"], { cwd: checks.workspace });
result.gitObjectReadable = git.exitCode === 0;
result.resumed = process.argv.includes("--resume");
await Bun.write(process.env.CAPTURE, JSON.stringify(result));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s", usage: { input_tokens: 1, output_tokens: 1 }, structured_output: { version: 1, outcome: "success", status: "done", summary: "ok", reason: null, metrics: {}, artifacts: [] } }));
`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(args: string[], cwd?: string): void {
  const child = Bun.spawnSync(["git", ...args], { ...(cwd ? { cwd } : {}), stdout: "ignore", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
}

async function fixture() {
  const root = await shortTemporaryDirectory("conveyor-clfs-", { visibleInSandbox: true });
  directories.push(root);
  const source = path.join(root, "source");
  const workspace = path.join(root, "workspace");
  const otherWorktree = path.join(root, "other-worktree");
  const otherRepository = path.join(root, "other-repository");
  const artifacts = path.join(root, "artifacts", "run");
  const runtime = path.join(root, "runtime");
  const executable = path.join(runtime, "claude");
  const conveyorHome = path.join(root, "conveyor-home");
  const configuration = path.join(root, "configuration");
  const data = path.join(root, "data");
  const credentials = path.join(root, "credentials");
  const claudeConfig = path.join(root, "claude-config");
  await Promise.all([source, otherRepository, runtime, conveyorHome, configuration, data, credentials, claudeConfig].map((directory) => mkdir(directory)));
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(source, "own-marker"), "own worktree");
  git(["init", "--quiet"], source);
  git(["add", "."], source);
  git(["-c", "user.name=Conveyor", "-c", "user.email=conveyor@example.com", "commit", "--quiet", "-m", "initial"], source);
  git(["worktree", "add", "--quiet", "--detach", workspace, "HEAD"], source);
  git(["worktree", "add", "--quiet", "--detach", otherWorktree, "HEAD"], source);
  await Promise.all([
    writeFile(path.join(otherWorktree, "other-worktree-marker"), "hidden"),
    writeFile(path.join(otherRepository, "other-repository-marker"), "hidden"),
    writeFile(path.join(conveyorHome, "home-marker"), "hidden"),
    writeFile(path.join(configuration, "config-marker"), "hidden"),
    writeFile(path.join(data, "data-marker"), "hidden"),
    writeFile(path.join(credentials, "credential-marker"), "hidden"),
    writeFile(path.join(runtime, "runtime-sibling-marker"), "hidden"),
    writeFile(executable, FAKE_CLAUDE),
  ]);
  await chmod(executable, 0o755);
  return {
    workspace,
    artifacts,
    executable,
    claudeConfig,
    capture: path.join(artifacts, "capture.json"),
    checks: {
      workspace,
      workspaceMarker: path.join(workspace, "own-marker"),
      files: {
        otherWorktree: path.join(otherWorktree, "other-worktree-marker"),
        otherRepository: path.join(otherRepository, "other-repository-marker"),
        conveyorHome: path.join(conveyorHome, "home-marker"),
        configuration: path.join(configuration, "config-marker"),
        data: path.join(data, "data-marker"),
        credentials: path.join(credentials, "credential-marker"),
        runtimeSibling: path.join(runtime, "runtime-sibling-marker"),
      },
    },
  };
}

describeSandbox("Claude Code filesystem confinement", () => {
  async function expectConfinedRun(sandbox: "read-only" | "workspace-write", resumeSessionId?: string): Promise<void> {
    const files = await fixture();
    await runClaudeCode({
      command: files.executable,
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      prompt: "verify filesystem",
      sandbox,
      automaticApprovals: false,
      mcp: { command: "bun", args: ["x"] },
      ...(resumeSessionId ? { resumeSessionId } : {}),
      env: {
        CAPTURE: files.capture,
        CHECKS: JSON.stringify(files.checks),
        CLAUDE_CONFIG_DIR: files.claudeConfig,
      },
    });
    const result = JSON.parse(await readFile(files.capture, "utf8"));
    expect(result.resumed).toBe(resumeSessionId !== undefined);
    expect(result.workspaceContents).toBe("own worktree");
    expect(result.workspaceWritable).toBe(sandbox === "workspace-write");
    expect(result.gitObjectReadable).toBe(true);
    expect(result.home).toBe(true);
    expect(result.scratch).toBe(true);
    expect(result.otherWorktree).toBe(false);
    expect(result.otherRepository).toBe(false);
    expect(result.conveyorHome).toBe(false);
    expect(result.configuration).toBe(false);
    expect(result.data).toBe(false);
    expect(result.credentials).toBe(false);
    expect(result.runtimeSibling).toBe(false);
  }

  test("Claude filesystem confinement allows only this run's paths read-only", async () => {
    await expectConfinedRun("read-only");
  });

  test("Claude filesystem confinement allows only this run's paths workspace-write", async () => {
    await expectConfinedRun("workspace-write");
  });

  test("Claude filesystem confinement allows only this run's paths for a resumed read-only session", async () => {
    await expectConfinedRun("read-only", "session-1");
  });

  test("Claude filesystem confinement allows only this run's paths for a resumed workspace-write session", async () => {
    await expectConfinedRun("workspace-write", "session-1");
  });
});

test("Claude filesystem confinement fails before an agent command starts when it cannot build confinement", async () => {
  const files = await fixture();
  const started = path.join(files.artifacts, "started");
  await expect(runClaudeCode({
    command: path.join(path.dirname(files.executable), "missing-claude"),
    workspace: files.workspace,
    artifactsDirectory: files.artifacts,
    prompt: "verify filesystem",
    sandbox: "read-only",
    automaticApprovals: false,
    mcp: { command: "bun", args: ["x"] },
    env: { STARTED: started, CLAUDE_CONFIG_DIR: files.claudeConfig },
  })).rejects.toThrow("cannot confine a command that is not installed");
  expect(await Bun.file(started).exists()).toBe(false);
});
