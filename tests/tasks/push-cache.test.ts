import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { GitHubAdapter, type GitHubTransport, type GitHubTransportRequest } from "../../src/plugins/github/shared/adapter";
import { GitHubCodeHost } from "../../src/plugins/github/code/codehost";
import { GitHubReadCache } from "../../src/plugins/github/shared/read-cache";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import type { TaskDeps } from "../../src/tasks/deps";
import { dispatchTool, type DispatchEnv } from "../../src/tasks/dispatch";
import { cliGit } from "../../src/workspace/git";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function commit(workspace: string, filename: string, message: string): Promise<string> {
  await writeFile(path.join(workspace, filename), `${message}\n`);
  await git(workspace, ["add", filename]);
  await git(workspace, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
  return git(workspace, ["rev-parse", "HEAD"]);
}

const ADDRESS = "owner/my-app";
const actor = { id: "kaveh", name: "Kaveh", title: "Implementer" };

/** A GitHub that serves the pull request head the test says, counting every request. */
function githubFake() {
  const state = { head: "", requests: [] as string[] };
  const transport: GitHubTransport = {
    async request<T>(request: GitHubTransportRequest): Promise<T> {
      state.requests.push(`${request.method} ${request.path}`);
      if (request.path === `repos/${ADDRESS}/pulls/5`) {
        return {
          number: 5, html_url: "https://github.com/owner/my-app/pull/5", state: "open", draft: false,
          head: { sha: state.head, ref: "conveyor/7-r1-push" }, base: { ref: "main" }, body: "",
        } as T;
      }
      if (request.path.startsWith(`repos/${ADDRESS}/commits/`)) return { check_runs: [] } as T;
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    },
  };
  const pullReads = () => state.requests.filter((r) => r === `GET repos/${ADDRESS}/pulls/5`).length;
  return { state, transport, pullReads };
}

/** A real workspace, a real bare remote, a real read cache and the real dispatcher. */
async function world(options: { withChange?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-push-cache-"));
  directories.push(root);
  const remote = path.join(root, "remote.git");
  const workspace = path.join(root, "workspace");
  const branch = "conveyor/7-r1-push";
  await git(root, ["init", "--bare", "--initial-branch=main", remote]);
  await git(root, ["clone", remote, workspace]);
  await commit(workspace, "base.txt", "base");
  await git(workspace, ["push", "origin", "main"]);
  await git(workspace, ["checkout", "-b", branch]);
  const a = await commit(workspace, "a.txt", "a");
  await cliGit.push(workspace, branch, { forceWithLease: false });

  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: ADDRESS, folder: root, configHash: "hash" });
  store.upsertIssue({
    id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://example.com/issues/7", title: "Push", body: "",
    sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  const enrollment = store.activateEnrollment("i1");
  store.recordWorkspace({ id: "workspace", enrollmentId: enrollment.id, path: workspace, branch, status: "active" });
  if (options.withChange !== false) {
    store.upsertPullRequest({ issueId: "i1", id: `github:${ADDRESS}#pr-5`, number: 5, url: "https://github.com/owner/my-app/pull/5", state: "open" });
  }

  const fake = githubFake();
  fake.state.head = a;
  const adapter = new GitHubAdapter(new GitHubReadCache(fake.transport), "conveyor");
  const host = new GitHubCodeHost(adapter, undefined, { isTrusted: async () => true });
  const deliveredHead = async (): Promise<string | null> => {
    const stored = store.getCurrentPullRequest("i1");
    return stored ? (await host.getChangeDelivery({ address: ADDRESS, id: stored.id })).change.headSha : null;
  };
  const deps: TaskDeps = {
    store, config: {} as never, items: {} as never,
    repository: { id: "repo", address: ADDRESS, folder: root, baseBranch: "main" },
    issueId: "i1", sourceGuidance: "", git: cliGit, workspaces: {} as never,
    delivery: async () => {
      const stored = store.getCurrentPullRequest("i1");
      return stored ? { ...(await host.getChangeDelivery({ address: ADDRESS, id: stored.id })) } as never : { change: null, pullRequest: null, checks: [] } as never;
    },
    forgetChange: () => {
      const stored = store.getCurrentPullRequest("i1");
      if (stored) adapter.forgetChange(ADDRESS, stored.number);
    },
  };
  const env: DispatchEnv = {
    registry: createTaskRegistry(), deps: () => deps, store,
    liveHeadSha: async (options) => {
      if (options?.refresh) deps.forgetChange?.();
      return deliveredHead();
    },
  };
  const push = (input: Record<string, unknown>) => dispatchTool({
    name: "workspace.push", input, actor,
    grant: { runId: "run-1", stageId: "implementation", issueScoped: true, actor, tasks: new Set(["workspace.push"]) },
  }, env);
  return { workspace, branch, a, fake, deliveredHead, push, remoteHead: () => git(remote, ["rev-parse", `refs/heads/${branch}`]) };
}

describe("a push refreshes the cached pull request", () => {
  test("a plain push drops the cached pull request, so the next read sees the new head", async () => {
    const w = await world();
    expect(await w.deliveredHead()).toBe(w.a);
    const b = await commit(w.workspace, "b.txt", "b");
    w.fake.state.head = b;
    expect(await w.deliveredHead()).toBe(w.a);

    await w.push({});
    expect(await w.deliveredHead()).toBe(b);
  });

  test("a lease push drops the cached pull request without any webhook, and drops its delivery and check reads", async () => {
    const w = await world();
    await w.deliveredHead();
    const b = await commit(w.workspace, "b.txt", "b");
    w.fake.state.head = b;

    await w.push({ forceWithLease: true, headSha: w.a });
    expect(await w.remoteHead()).toBe(b);
    const before = w.fake.state.requests.length;
    expect(await w.deliveredHead()).toBe(b);
    const reread = w.fake.state.requests.slice(before);
    expect(reread).toEqual([`GET repos/${ADDRESS}/pulls/5`, `GET repos/${ADDRESS}/commits/${b}/check-runs?per_page=100`]);
  });

  test("a lease push of head B passes the head fence after B was pushed with no webhook", async () => {
    const w = await world();
    await w.deliveredHead();
    const b = await commit(w.workspace, "b.txt", "b");
    await cliGit.push(w.workspace, w.branch, { forceWithLease: false });
    w.fake.state.head = b;
    const c = await commit(w.workspace, "c.txt", "c");

    await w.push({ forceWithLease: true, headSha: b });
    expect(await w.remoteHead()).toBe(c);
  });

  test("a head that differs from the cached one is read again once before the call proceeds", async () => {
    const w = await world();
    await w.deliveredHead();
    const b = await commit(w.workspace, "b.txt", "b");
    await cliGit.push(w.workspace, w.branch, { forceWithLease: false });
    w.fake.state.head = b;
    const reads = w.fake.pullReads();

    await w.push({ forceWithLease: true, headSha: b });
    expect(w.fake.pullReads()).toBe(reads + 1);
  });

  test("a head that still differs after the re-read is refused", async () => {
    const w = await world();
    await w.deliveredHead();
    const stale = "f".repeat(40);
    const reads = w.fake.pullReads();

    await expect(w.push({ forceWithLease: true, headSha: stale })).rejects.toThrow(`headSha ${stale} is not the current change head ${w.a}`);
    expect(w.fake.pullReads()).toBe(reads + 1);
    expect(await w.remoteHead()).toBe(w.a);
  });

  test("a lease push finding the remote at another SHA than the cached head re-reads the pull request before refusing", async () => {
    const w = await world();
    await w.deliveredHead();
    // Another push moved the remote and GitHub's pull request, and no webhook arrived.
    const other = await mkClone(w);
    w.fake.state.head = other;
    const reads = w.fake.pullReads();

    await expect(w.push({ forceWithLease: true, headSha: w.a })).rejects.toThrow(`The remote branch moved to ${other}`);
    expect(w.fake.pullReads()).toBe(reads + 1);
    expect(await w.deliveredHead()).toBe(other);
    // The retry after fetch and rebase now passes the fence.
    await git(w.workspace, ["fetch", "origin", w.branch]);
    await git(w.workspace, ["reset", "--hard", other]);
    await commit(w.workspace, "d.txt", "d");
    await w.push({ forceWithLease: true, headSha: other });
  });

  test("a matching head does not read the pull request again", async () => {
    const w = await world();
    await w.deliveredHead();
    const reads = w.fake.pullReads();
    await commit(w.workspace, "b.txt", "b");

    await w.push({ forceWithLease: true, headSha: w.a });
    // Only the read the push itself caused afterwards, and none at the fence.
    expect(w.fake.pullReads()).toBe(reads);
  });

  test("a push for a branch with no change request makes no GitHub request", async () => {
    const w = await world({ withChange: false });
    await commit(w.workspace, "b.txt", "b");

    await w.push({});
    await commit(w.workspace, "c.txt", "c");
    await w.push({ forceWithLease: true, headSha: await w.remoteHead() });
    expect(w.fake.state.requests).toEqual([]);
  });
});

/** Moves the remote branch from another clone, as a second pusher would. */
async function mkClone(w: { workspace: string; branch: string }): Promise<string> {
  const remote = await git(w.workspace, ["remote", "get-url", "origin"]);
  const other = `${w.workspace}-other`;
  await git(path.dirname(w.workspace), ["clone", "--branch", w.branch, remote, other]);
  const sha = await commit(other, "other.txt", "other");
  await git(other, ["push", "origin", w.branch]);
  return sha;
}
