import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { agentFilesystemPlan, sandboxCommand } from "../../src/isolation/sandbox";
import { codexLaunch } from "../../src/isolation/run-network";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(args: string[], cwd: string): void {
  const child = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
}

async function fixture() {
  const root = await shortTemporaryDirectory("conveyor-ewc-", { socketPath: "artifacts/run/net/control.sock", visibleInSandbox: true });
  directories.push(root);
  const source = path.join(root, "source");
  const workspace = path.join(root, "workspace");
  const artifacts = path.join(root, "artifacts", "run");
  const home = path.join(artifacts, "home");
  const scratch = path.join(artifacts, "scratch");
  const extraRoot = path.join(root, "extra-root");
  const missingRoot = path.join(root, "missing-root");
  const hostDirectory = path.join(root, "host");
  for (const directory of [source, artifacts, home, scratch, extraRoot, hostDirectory]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(source, "marker"), "x");
  git(["init", "--quiet"], source);
  git(["add", "."], source);
  git(["-c", "user.name=C", "-c", "user.email=c@example.com", "commit", "--quiet", "-m", "initial"], source);
  git(["worktree", "add", "--quiet", "--detach", workspace, "HEAD"], source);
  const gitAdmin = (await readFile(path.join(workspace, ".git"), "utf8")).replace(/^gitdir:\s*/, "").trim();
  return { root, workspace, artifacts, home, scratch, extraRoot, missingRoot, hostDirectory, gitAdmin };
}

type Files = Awaited<ReturnType<typeof fixture>>;

function planFor(files: Files, sandbox: "workspace-write" | "read-only") {
  const writable = sandbox === "workspace-write" ? [files.workspace, files.extraRoot, files.missingRoot, files.home, files.scratch] : [];
  return agentFilesystemPlan({
    command: process.execPath,
    env: { PATH: process.env.PATH ?? "" },
    workspace: files.workspace,
    artifacts: files.artifacts,
    home: files.home,
    scratch: files.scratch,
    writableGit: sandbox === "workspace-write",
    writable,
  }).mounts;
}

/** Bind targets by access, read from the plan's `--bind` / `--ro-bind` triples. */
function binds(mounts: string[]): { writable: string[]; readOnly: string[] } {
  const result = { writable: [] as string[], readOnly: [] as string[] };
  for (let index = 0; index < mounts.length; index++) {
    if (mounts[index] === "--bind") result.writable.push(mounts[index + 2]!);
    if (mounts[index] === "--ro-bind") result.readOnly.push(mounts[index + 2]!);
  }
  return result;
}

describe("egress-wrapped Codex mount plan", () => {
  test("workspace-write leaves every path outside the authorized write set read-only", async () => {
    const files = await fixture();
    const mounts = planFor(files, "workspace-write");
    const { writable, readOnly } = binds(mounts);
    const authorized = [files.workspace, files.artifacts, files.home, files.scratch, files.extraRoot, files.gitAdmin, path.join(files.root, "source", ".git")];
    for (const target of writable) {
      expect(authorized.some((root) => target === root || target.startsWith(`${root}/`))).toBe(true);
    }
    expect(readOnly).toContain("/usr");
    expect(writable).not.toContain("/usr");
    // The tmpfs root itself is remounted read-only, after every mount that could be created under it.
    expect(mounts.slice(-2)).toEqual(["--remount-ro", "/"]);
  });

  test("workspace-write makes the worktree writable", async () => {
    const files = await fixture();
    expect(binds(planFor(files, "workspace-write")).writable).toContain(files.workspace);
  });

  test("workspace-write makes a linked worktree's Git administration path writable", async () => {
    const files = await fixture();
    expect(files.gitAdmin).toContain("/worktrees/");
    expect(binds(planFor(files, "workspace-write")).writable).toContain(files.gitAdmin);
  });

  test("workspace-write makes each existing configured writable root writable and skips missing ones", async () => {
    const files = await fixture();
    const { writable } = binds(planFor(files, "workspace-write"));
    expect(writable).toContain(files.extraRoot);
    expect(writable).not.toContain(files.missingRoot);
  });

  test("read-only grants no writable mount for the worktree, Git administration path or writable roots", async () => {
    const files = await fixture();
    const { writable, readOnly } = binds(planFor(files, "read-only"));
    for (const protectedPath of [files.workspace, files.gitAdmin]) {
      expect(writable).not.toContain(protectedPath);
      expect(readOnly).toContain(protectedPath);
    }
    expect(writable).not.toContain(files.extraRoot);
  });
});

const unavailable = bwrapUnavailableReason();
const describeSandbox = unavailable ? describe.skip : describe;

describeSandbox("egress wrapper in a real bubblewrap run", () => {
  test("a command cannot write a host file outside its authorized write set", async () => {
    const files = await fixture();
    const readOnlyFile = path.join(files.hostDirectory, "host-file");
    await writeFile(readOnlyFile, "original");
    const script = `
      const out = {};
      const attempt = async (name, file) => { try { await Bun.write(file, "changed"); out[name] = true; } catch { out[name] = false; } };
      await attempt("hostFile", ${JSON.stringify(readOnlyFile)});
      await attempt("root", "/escaped");
      await attempt("worktree", ${JSON.stringify(path.join(files.workspace, "written"))});
      await attempt("extraRoot", ${JSON.stringify(path.join(files.extraRoot, "written"))});
      await attempt("scratch", ${JSON.stringify(path.join(files.scratch, "written"))});
      console.log(JSON.stringify(out));`;
    const launch = sandboxCommand({
      argv: [process.execPath, "-e", script],
      env: { PATH: process.env.PATH ?? "", HOME: files.home },
      dataProxySocket: path.join(files.artifacts, "data.sock"),
      filesystem: {
        mounts: agentFilesystemPlan({
          command: process.execPath,
          env: { PATH: process.env.PATH ?? "" },
          workspace: files.workspace,
          artifacts: files.artifacts,
          home: files.home,
          scratch: files.scratch,
          writableGit: true,
          writable: [files.workspace, files.extraRoot],
          readable: [files.hostDirectory],
        }).mounts,
      },
    });
    const child = Bun.spawnSync(launch.argv, { env: launch.env, stdout: "pipe", stderr: "pipe" });
    expect(child.stderr.toString()).toBe("");
    expect(JSON.parse(child.stdout.toString())).toEqual({ hostFile: false, root: false, worktree: true, extraRoot: true, scratch: true });
    expect(await readFile(readOnlyFile, "utf8")).toBe("original");
  });
});

describe("egress wrapper that cannot be established", () => {
  async function launch(files: Files, bin: string) {
    return codexLaunch({
      command: process.execPath,
      environment: { PATH: bin, HOME: files.home, TMPDIR: files.scratch },
      artifactsDirectory: files.artifacts,
      egress: { httpsHosts: [] },
      filesystem: {
        command: process.execPath,
        env: { PATH: bin },
        workspace: files.workspace,
        artifacts: files.artifacts,
        home: files.home,
        scratch: files.scratch,
      },
      buildArguments: () => ["--should-not-run"],
    });
  }

  test("fails with an actionable error when bubblewrap is not installed", async () => {
    const files = await fixture();
    const empty = path.join(files.root, "empty-bin");
    await mkdir(empty);
    await expect(launch(files, empty)).rejects.toThrow("requires bubblewrap on PATH");
  });

  test("fails before the agent command starts when bubblewrap cannot create the namespace", async () => {
    const files = await fixture();
    const bin = path.join(files.root, "bin");
    const started = path.join(files.root, "started");
    await mkdir(bin);
    await writeFile(path.join(bin, "bwrap"), `#!/bin/sh\necho "bwrap: No permissions to create new namespace" >&2\ntouch ${started}\nexit 1\n`);
    await chmod(path.join(bin, "bwrap"), 0o755);
    await expect(launch(files, bin)).rejects.toThrow(/Cannot establish the agent filesystem wrapper.*No permissions to create new namespace.*conveyor doctor/s);
  });
});
