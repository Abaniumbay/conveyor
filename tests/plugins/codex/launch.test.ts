import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { codexLaunch } from "../../../src/plugins/codex/launch";
import { shortTemporaryDirectory } from "../../support/short-temporary-directory";

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
