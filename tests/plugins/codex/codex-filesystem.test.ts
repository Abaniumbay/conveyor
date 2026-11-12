import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCodex } from "../../../src/plugins/codex/codex";
import { bwrapUnavailableReason } from "../../support/bwrap";
import { shortTemporaryDirectory } from "../../support/short-temporary-directory";

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
result.harnessAuthentication = await readable(process.env.CODEX_HOME + "/auth.json");
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

// Writes through the sandbox; the real codex binary would run the same commands as child processes.
const WRITE_PROBE = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const checks = JSON.parse(process.env.CHECKS);
const attempt = async (file) => {
  try { await Bun.write(file, "probe"); return true; } catch { return false; }
};
const result = {
  args,
  workspace: await attempt(checks.workspace + "/probe"),
  writableRoot: await attempt(checks.writableRoot + "/probe"),
  outside: await attempt(checks.outside + "/probe"),
  privateTmp: await attempt(checks.tmpFile),
};
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
    writeFile(path.join(credentials, "auth.json"), "hidden"),
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

  test.each([false, true])("Codex filesystem confinement mounts the standalone release root read-only (egress %p)", async (egress) => {
    const files = await fixture();
    const root = path.dirname(files.workspace);
    const release = path.join(root, ".codex", "packages", "standalone", "releases", "1.0.0");
    const otherRelease = path.join(root, ".codex", "packages", "standalone", "releases", "0.9.0");
    await Promise.all([mkdir(path.join(release, "bin"), { recursive: true }), mkdir(path.join(release, "codex-resources"), { recursive: true }), mkdir(otherRelease, { recursive: true })]);
    const executable = path.join(release, "bin", "codex");
    await Promise.all([
      writeFile(executable, FAKE_CODEX),
      writeFile(path.join(release, "codex-package.json"), "{}"),
      writeFile(path.join(release, "bin", "codex-code-mode-host"), "helper"),
      writeFile(path.join(release, "codex-resources", "resource"), "resource"),
      writeFile(path.join(otherRelease, "marker"), "hidden"),
      writeFile(path.join(root, ".codex", "auth.json"), "hidden"),
    ]);
    await chmod(executable, 0o755);
    const checks = { ...files.checks, files: {
      helper: path.join(release, "bin", "codex-code-mode-host"),
      resources: path.join(release, "codex-resources", "resource"),
      otherRelease: path.join(otherRelease, "marker"),
      releaseCredentials: path.join(root, ".codex", "auth.json"),
    } };
    await runCodex({
      command: executable,
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      prompt: "verify release",
      sandbox: "read-only",
      automaticApprovals: false,
      mcp: { command: "bun", args: ["x"] },
      env: { CAPTURE: files.capture, CHECKS: JSON.stringify(checks), CODEX_HOME: path.join(root, "credentials") },
      ...(egress ? { egress: { httpsHosts: [], controlPlaneHosts: [] } } : {}),
    });
    const result = JSON.parse(await readFile(files.capture, "utf8"));
    expect(result.helper).toBe(true);
    expect(result.resources).toBe(true);
    expect(result.otherRelease).toBe(false);
    expect(result.releaseCredentials).toBe(false);
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

  describe("Conveyor's wrapper as Codex's only sandbox without agentEgress", () => {
    async function probe(sandbox: "read-only" | "workspace-write") {
      const files = await fixture();
      const root = path.dirname(files.workspace);
      const writableRoot = path.join(root, "writable-root");
      const outside = path.join(root, "outside");
      const tmpFile = `/tmp/codex-private-tmp-${crypto.randomUUID()}`;
      await Promise.all([mkdir(writableRoot), mkdir(outside)]);
      await writeFile(files.executable, WRITE_PROBE);
      await runCodex({
        command: files.executable,
        workspace: files.workspace,
        artifactsDirectory: files.artifacts,
        prompt: "probe writes",
        sandbox,
        automaticApprovals: true,
        mcp: { command: "bun", args: ["x"] },
        writableRoots: [writableRoot],
        env: {
          CAPTURE: files.capture,
          CHECKS: JSON.stringify({ workspace: files.workspace, writableRoot, outside, tmpFile }),
          CODEX_HOME: path.join(root, "credentials"),
        },
      });
      const result = JSON.parse(await readFile(files.capture, "utf8")) as Record<string, any>;
      return { result, hostTmpFile: tmpFile, writableRoot, outside, workspace: files.workspace };
    }

    test("a read-only Codex run cannot write to its worktree", async () => {
      const { result, workspace } = await probe("read-only");
      expect(result.args[result.args.indexOf("--sandbox") + 1]).toBe("danger-full-access");
      expect(result.workspace).toBe(false);
      expect(result.writableRoot).toBe(false);
      expect(existsSync(path.join(workspace, "probe"))).toBe(false);
    });

    test("a workspace-write Codex run writes to its worktree and writable roots", async () => {
      const { result, workspace, writableRoot } = await probe("workspace-write");
      expect(result.args[result.args.indexOf("--sandbox") + 1]).toBe("danger-full-access");
      expect(result.workspace).toBe(true);
      expect(result.writableRoot).toBe(true);
      expect(existsSync(path.join(workspace, "probe"))).toBe(true);
      expect(existsSync(path.join(writableRoot, "probe"))).toBe(true);
    });

    test("a workspace-write Codex run cannot write outside its worktree and writable roots", async () => {
      const { result, outside } = await probe("workspace-write");
      expect(result.outside).toBe(false);
      expect(existsSync(path.join(outside, "probe"))).toBe(false);
    });

    test.each(["read-only", "workspace-write"] as const)("a %s Codex run has a private, writable /tmp", async (sandbox) => {
      const { result, hostTmpFile } = await probe(sandbox);
      expect(result.privateTmp).toBe(true);
      expect(existsSync(hostTmpFile)).toBe(false);
    });

    test.each(["read-only", "workspace-write"] as const)("a %s Codex run needs no nested user namespace: only the wrapper's namespace is created", async (sandbox) => {
      // The probe is started by the wrapper's bwrap and must run to completion; Codex is told not to
      // start a sandbox of its own, which is what would fail where nested namespaces are refused.
      const { result } = await probe(sandbox);
      expect(result.args).toContain("danger-full-access");
      expect(result.args).not.toContain("--approve-for-me");
    });
  });
});
