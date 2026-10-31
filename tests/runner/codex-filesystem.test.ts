import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCodex } from "../../src/runner/codex";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const directories: string[] = [];
const unavailable = bwrapUnavailableReason();
if (unavailable) console.warn(`SKIPPED Codex filesystem tests: \`bwrap\` is unavailable (${unavailable})`);
const describeSandbox = unavailable ? describe.skip : describe;

const FAKE_CODEX = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const checks = JSON.parse(process.env.CHECKS);
const readable = async (file) => await Bun.file(file).exists();
const result = {};
for (const [name, file] of Object.entries(checks.files)) result[name] = await readable(file);
const authentication = process.env.CODEX_HOME + "/auth.json";
result.harnessAuthentication = await readable(authentication);
result.harnessAuthenticationContents = result.harnessAuthentication ? await Bun.file(authentication).text() : null;
// Agent commands run through the shell found by the harness, with CODEX_HOME removed from their environment.
const command = Bun.spawnSync([process.env.SHELL, "-c", "cat " + authentication]);
result.commandAuthentication = command.exitCode === 0 || new TextDecoder().decode(command.stdout).length > 0;
const commandEnvironment = Bun.spawnSync(["bash", "-c", "pwd"], { cwd: checks.workspace });
result.commandWorkingDirectory = new TextDecoder().decode(commandEnvironment.stdout).trim();
result.agentEnvironmentExcludesCodexHome = args.includes('shell_environment_policy.exclude=["CODEX_HOME"]');
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
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: checks.workspace });
const headSha = new TextDecoder().decode(head.stdout).trim();
const packedRef = Bun.spawnSync(["git", "rev-parse", "refs/heads/packed-ref"], { cwd: checks.workspace });
result.gitPackedRefReadable = packedRef.exitCode === 0;
const gitWrite = Bun.spawnSync(["git", "update-ref", "refs/heads/agent-filesystem-test", headSha], { cwd: checks.workspace });
result.gitMetadataWritable = gitWrite.exitCode === 0;
await Bun.write(process.env.CAPTURE, JSON.stringify(result));
await Bun.write(args[args.indexOf("-o") + 1], JSON.stringify({ version: 1, outcome: "success", status: "done", summary: "ok", reason: null, metrics: {}, artifacts: [] }));
`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(args: string[], cwd?: string): void {
  const child = Bun.spawnSync(["git", ...args], { ...(cwd ? { cwd } : {}), stdout: "ignore", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
}

async function fixture() {
  const root = await shortTemporaryDirectory("conveyor-cfs-", {
    socketPath: "artifacts/run/net/control.sock",
    visibleInSandbox: true,
  });
  directories.push(root);
  const source = path.join(root, "source");
  const workspace = path.join(root, "workspace");
  const otherWorktree = path.join(root, "other-worktree");
  const otherRepository = path.join(root, "other-repository");
  const artifacts = path.join(root, "artifacts", "run");
  const runtime = path.join(root, "runtime");
  const executable = path.join(runtime, "codex");
  const conveyorHome = path.join(root, "conveyor-home");
  const configuration = path.join(root, "configuration");
  const data = path.join(root, "data");
  const credentials = path.join(root, "credentials");
  const otherRun = path.join(root, "artifacts", "other-run");
  await Promise.all([mkdir(source), mkdir(otherRepository), mkdir(artifacts, { recursive: true }), mkdir(runtime), mkdir(conveyorHome), mkdir(configuration), mkdir(data), mkdir(credentials), mkdir(path.join(otherRun, "home"), { recursive: true })]);
  await writeFile(path.join(source, "own-marker"), "own worktree");
  git(["init", "--quiet"], source);
  git(["add", "."], source);
  git(["-c", "user.name=Conveyor", "-c", "user.email=conveyor@example.com", "commit", "--quiet", "-m", "initial"], source);
  git(["branch", "packed-ref"], source);
  git(["pack-refs", "--all"], source);
  git(["worktree", "add", "--quiet", "--detach", workspace, "HEAD"], source);
  git(["worktree", "add", "--quiet", "--detach", otherWorktree, "HEAD"], source);
  await Promise.all([
    writeFile(path.join(otherWorktree, "other-worktree-marker"), "hidden"),
    writeFile(path.join(otherRepository, "other-repository-marker"), "hidden"),
    writeFile(path.join(conveyorHome, "home-marker"), "hidden"),
    writeFile(path.join(configuration, "config-marker"), "hidden"),
    writeFile(path.join(data, "data-marker"), "hidden"),
    writeFile(path.join(credentials, "auth.json"), "fixture-codex-credential"),
    writeFile(path.join(otherRun, "artifact-marker"), "hidden"),
    writeFile(path.join(otherRun, "home", "home-marker"), "hidden"),
    writeFile(path.join(runtime, "runtime-sibling-marker"), "hidden"),
    writeFile(executable, FAKE_CODEX),
  ]);
  await chmod(executable, 0o755);
  const capture = path.join(artifacts, "capture.json");
  return {
    workspace,
    artifacts,
    executable,
    capture,
    checks: {
      workspace,
      workspaceMarker: path.join(workspace, "own-marker"),
      files: {
        otherWorktree: path.join(otherWorktree, "other-worktree-marker"),
        otherRepository: path.join(otherRepository, "other-repository-marker"),
        conveyorHome: path.join(conveyorHome, "home-marker"),
        configuration: path.join(configuration, "config-marker"),
        data: path.join(data, "data-marker"),
        credentials: path.join(credentials, "auth.json"),
        otherRunArtifacts: path.join(otherRun, "artifact-marker"),
        otherRunHome: path.join(otherRun, "home", "home-marker"),
        runtimeSibling: path.join(runtime, "runtime-sibling-marker"),
      },
    },
  };
}

describeSandbox("Codex filesystem confinement", () => {
  async function expectConfinedRun(
    sandbox: "read-only" | "workspace-write" | "danger-full-access",
    egress: boolean,
  ): Promise<void> {
    const files = await fixture();
    await runCodex({
      command: files.executable,
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      prompt: "verify filesystem",
      sandbox,
      automaticApprovals: false,
      mcp: { command: "bun", args: ["x"] },
      env: {
        CAPTURE: files.capture,
        CHECKS: JSON.stringify(files.checks),
        CODEX_HOME: path.join(path.dirname(files.workspace), "credentials"),
      },
      ...(egress ? { egress: { httpsHosts: [], controlPlaneHosts: [] } } : {}),
    });
    const result = JSON.parse(await readFile(files.capture, "utf8"));
    expect(result.workspaceContents).toBe("own worktree");
    expect(result.workspaceWritable).toBe(sandbox !== "read-only");
    expect(result.gitObjectReadable).toBe(true);
    expect(result.gitPackedRefReadable).toBe(true);
    expect(result.gitMetadataWritable).toBe(sandbox !== "read-only");
    expect(result.harnessAuthentication).toBe(true);
    expect(result.harnessAuthenticationContents).toBe("fixture-codex-credential");
    expect(result.commandAuthentication).toBe(false);
    expect(result.commandWorkingDirectory).toBe(files.workspace);
    expect(result.agentEnvironmentExcludesCodexHome).toBe(true);
    expect(result.home).toBe(true);
    expect(result.scratch).toBe(true);
    expect(result.otherWorktree).toBe(false);
    expect(result.otherRepository).toBe(false);
    expect(result.conveyorHome).toBe(false);
    expect(result.configuration).toBe(false);
    expect(result.data).toBe(false);
    expect(result.credentials).toBe(false);
    expect(result.runtimeSibling).toBe(false);
    expect(result.otherRunArtifacts).toBe(false);
    expect(result.otherRunHome).toBe(false);
  }

  test("Codex filesystem confinement allows only this run's paths read-only without egress", async () => {
    await expectConfinedRun("read-only", false);
  });

  test("Codex filesystem confinement allows only this run's paths workspace-write without egress", async () => {
    await expectConfinedRun("workspace-write", false);
  });

  test("Codex filesystem confinement allows only this run's paths read-only with egress", async () => {
    await expectConfinedRun("read-only", true);
  });

  test("Codex filesystem confinement allows only this run's paths workspace-write with egress", async () => {
    await expectConfinedRun("workspace-write", true);
  });

  test("Codex filesystem confinement preserves full-access writes with egress", async () => {
    await expectConfinedRun("danger-full-access", true);
  });

  test("Codex filesystem confinement fails before an agent command starts when it cannot build confinement", async () => {
    const files = await fixture();
    const started = path.join(files.artifacts, "started");
    await expect(runCodex({
      command: path.join(path.dirname(files.executable), "missing-codex"),
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      prompt: "verify filesystem",
      sandbox: "read-only",
      automaticApprovals: false,
      mcp: { command: "bun", args: ["x"] },
      env: { STARTED: started },
    })).rejects.toThrow("cannot confine a command that is not installed");
    expect(await Bun.file(started).exists()).toBe(false);
  });
});
