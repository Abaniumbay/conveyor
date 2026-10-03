import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import type { TaskContext, WorkspaceContext } from "../../src/tasks/context";
import { runTask, type TaskResult } from "../../src/tasks/contract";
import type { TaskDeps } from "../../src/tasks/deps";
import type { GitOps } from "../../src/workspace/git";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const registry = createTaskRegistry();
const run = (name: string, args: Record<string, unknown>) =>
  runTask(registry.require(name), { config: {}, instance: { id: name, stage: "impl", idempotencyKey: "k", resumed: false }, ...args } as never);
type Pass = Extract<TaskResult, { status: "pass" }>;

function gitFake(state: {
  clean?: boolean; head?: string | null; remote?: string | null; ahead?: number; behind?: number;
} = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const git: GitOps = {
    status: async (p) => { calls.push(["status", p]); return { clean: state.clean ?? true }; },
    revParse: async (p, ref) => { calls.push(["revParse", p, ref]); return ref === "HEAD" ? (state.head ?? "aaa") : (state.remote === undefined ? "aaa" : state.remote); },
    aheadBehind: async (p, branch) => { calls.push(["aheadBehind", p, branch]); return { ahead: state.ahead ?? 0, behind: state.behind ?? 0 }; },
    fetch: async (p, remote, branch) => { calls.push(["fetch", p, remote, branch]); },
    push: async (p, branch, options) => { calls.push(["push", p, branch, options]); },
  };
  return { git, calls };
}

async function world(gitState: Parameters<typeof gitFake>[0] = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-ws-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  store.upsertIssue({
    id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://x/7", title: "Fix the Thing!", body: "",
    sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  const fake = gitFake(gitState);
  const manager = {
    created: [] as unknown[], removed: [] as unknown[], restored: [] as unknown[],
    async restore(input: unknown) { this.restored.push(input); },
    async create(input: unknown) {
      this.created.push(input);
      const p = path.join(root, "ws", "created");
      await mkdir(p, { recursive: true });
      return { path: p, branch: "conveyor/7-r1-fix-the-thing", baseRevision: "base" };
    },
    async remove(input: unknown) { this.removed.push(input); },
  };
  const deps: TaskDeps = {
    store, config: {} as never, items: {} as never,
    repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main" },
    issueId: "i1", sourceGuidance: "", git: fake.git, workspaces: manager as never,
  };
  /** Records an active workspace at a path that exists on disk. */
  const record = async (name = "existing") => {
    const enrollment = store.activateEnrollment("i1");
    const p = path.join(root, "ws", name);
    await mkdir(p, { recursive: true });
    store.recordWorkspace({ id: "w1", enrollmentId: enrollment.id, path: p, branch: "conveyor/7-r1-x", status: "active" });
    return p;
  };
  return { root, store, deps, manager, git: fake, record };
}

const ws = (over: Partial<WorkspaceContext> = {}): Partial<TaskContext> => ({
  workspace: {
    path: "/w", branch: "conveyor/7", exists: true, clean: true, ahead: 0, behind: 0,
    remoteHeadSha: "aaa", localHeadSha: "aaa", ...over,
  },
});

describe("workspace.load", () => {
  test("reports exists:false without a stored workspace", async () => {
    const w = await world();
    const result = await run("workspace.load", { context: {}, deps: w.deps }) as Pass;
    expect(result.output).toEqual({
      path: null, branch: null, exists: false, clean: true, ahead: 0, behind: 0, remoteHeadSha: null, localHeadSha: null,
    });
    expect(w.git.calls).toEqual([]);
  });

  test("combines the stored workspace with local git facts and never fetches", async () => {
    const w = await world({ clean: false, head: "abc", remote: "def", ahead: 2, behind: 1 });
    const p = await w.record();
    const result = await run("workspace.load", { context: {}, deps: w.deps }) as Pass;
    expect(result.output).toEqual({
      path: p, branch: "conveyor/7-r1-x", exists: true, clean: false, ahead: 2, behind: 1, remoteHeadSha: "def", localHeadSha: "abc",
    });
    expect(w.git.calls.map((c) => c[0]).sort()).toEqual(["aheadBehind", "revParse", "revParse", "status"]);
    expect(w.git.calls.some((c) => c[0] === "fetch")).toBe(false);
  });

  test("a stored workspace whose directory is gone does not exist and runs no git", async () => {
    const w = await world();
    const p = await w.record();
    await rm(p, { recursive: true });
    const result = await run("workspace.load", { context: {}, deps: w.deps }) as Pass;
    expect(result.output).toMatchObject({ path: p, exists: false, localHeadSha: null, remoteHeadSha: null });
    expect(w.git.calls).toEqual([]);
  });

  test("an unpushed branch has no remote head and no ahead/behind", async () => {
    const w = await world({ remote: null });
    await w.record();
    const result = await run("workspace.load", { context: {}, deps: w.deps }) as Pass;
    expect(result.output).toMatchObject({ remoteHeadSha: null, ahead: 0, behind: 0, localHeadSha: "aaa" });
  });
});

describe("workspace.pushed", () => {
  test("passes when clean, not ahead, and heads match", async () => {
    expect((await run("workspace.pushed", { context: ws() })).status).toBe("pass");
  });
  test("names each failed condition", async () => {
    const msg = async (over: Partial<WorkspaceContext>) => (await run("workspace.pushed", { context: ws(over) }) as { message: string }).message;
    expect(await msg({ exists: false })).toBe("No workspace exists");
    expect(await msg({ clean: false })).toBe("Workspace has uncommitted changes");
    expect(await msg({ remoteHeadSha: null })).toBe("Branch conveyor/7 has not been pushed to origin");
    expect(await msg({ ahead: 3 })).toBe("Branch conveyor/7 is 3 commit(s) ahead of origin");
    expect(await msg({ remoteHeadSha: "bbb" })).toBe("Local head aaa differs from origin/conveyor/7 at bbb");
  });
  test("is a check without writes", () => {
    const def = registry.require("workspace.pushed");
    expect([def.kind, def.reads, def.writes, def.invalidates]).toEqual(["check", ["workspace"], [], []]);
  });
});

describe("workspace.removed", () => {
  test("passes when no workspace exists, fails naming the path otherwise", async () => {
    expect((await run("workspace.removed", { context: ws({ exists: false }) })).status).toBe("pass");
    expect(await run("workspace.removed", { context: ws() })).toEqual({ status: "fail", message: "Workspace /w still exists" });
  });
});

describe("workspace.ensure", () => {
  const ensure = (w: Awaited<ReturnType<typeof world>>) =>
    run("workspace.ensure", { context: {}, deps: w.deps });

  test("creates and records the workspace exactly as the executor does", async () => {
    const w = await world();
    expect((await ensure(w)).status).toBe("pass");
    expect(w.manager.created).toEqual([{
      repositoryPath: "/f", repositoryId: "repo", issueNumber: 7, enrollment: 1, slug: "fix-the-thing", baseBranch: "main",
    }]);
    expect(w.store.getActiveWorkspace("i1")).toMatchObject({ branch: "conveyor/7-r1-fix-the-thing", generation: 1, status: "active" });
  });

  test("is a no-op when an active workspace exists on disk, and idempotent", async () => {
    const w = await world();
    await w.record();
    await ensure(w);
    await ensure(w);
    expect(w.manager.created).toEqual([]);
    const fresh = await world();
    await ensure(fresh);
    await ensure(fresh);
    expect(fresh.manager.created).toHaveLength(1);
  });

  test("re-attaches the recorded path and branch when the directory is gone, keeping the record", async () => {
    const w = await world();
    const p = await w.record();
    await rm(p, { recursive: true });
    expect((await ensure(w)).status).toBe("pass");
    expect(w.manager.created).toEqual([]);
    expect(w.manager.restored).toEqual([{ repositoryPath: "/f", workspacePath: p, branch: "conveyor/7-r1-x", baseBranch: "main" }]);
    expect(w.store.getActiveWorkspace("i1")).toMatchObject({ id: "w1", path: p, branch: "conveyor/7-r1-x" });
  });

  test("declares that it invalidates the workspace snapshot", () => {
    const def = registry.require("workspace.ensure");
    expect([def.kind, def.invalidates]).toEqual(["act", ["workspace"]]);
  });
});

describe("workspace.cleanup", () => {
  test("removes the worktree and branch and marks the record removed; repeating is a no-op", async () => {
    const w = await world();
    await w.record();
    const cleanup = () => run("workspace.cleanup", { context: {}, deps: w.deps });
    expect((await cleanup()).status).toBe("pass");
    expect(w.manager.removed).toEqual([{
      repositoryPath: "/f", workspacePath: expect.stringContaining("existing"), branch: "conveyor/7-r1-x", deleteBranch: true,
    }]);
    expect(w.store.getActiveWorkspace("i1")).toBeNull();
    expect((await cleanup()).status).toBe("pass");
    expect(w.manager.removed).toHaveLength(1);
  });
  test("deletes the remote branch through the code host after the local cleanup, best effort", async () => {
    for (const [answer, expected] of [["deleted", "deleted"], ["kept", "kept"], [new Error("GitHub is down"), "failed"]] as const) {
      const w = await world();
      await w.record();
      const calls: unknown[] = [];
      w.deps.codeHost = {
        async deleteBranch(input: unknown) {
          calls.push(input);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      } as never;
      const result = await run("workspace.cleanup", { context: {}, deps: w.deps }) as Pass;
      expect(result.status).toBe("pass");
      expect(result.output).toMatchObject({ branch: "conveyor/7-r1-x", remote: expected });
      expect(calls).toEqual([{ address: "o/r", branch: "conveyor/7-r1-x" }]);
      expect(w.store.getActiveWorkspace("i1")).toBeNull();
    }
  });
  test("a missing workspace is done", async () => {
    const w = await world();
    expect((await run("workspace.cleanup", { context: {}, deps: w.deps })).status).toBe("pass");
    expect(w.manager.removed).toEqual([]);
    expect(registry.require("workspace.cleanup").invalidates).toEqual(["workspace"]);
  });
});

describe("workspace tools", () => {
  const tool = (name: string, w: Awaited<ReturnType<typeof world>>, input: unknown = {}) =>
    run(name, { context: {}, deps: w.deps, input, actor: "agent" });

  test("workspace.get returns the stored path and branch", async () => {
    const w = await world();
    const p = await w.record();
    expect(((await tool("workspace.get", w)) as Pass).output).toEqual({ path: p, branch: "conveyor/7-r1-x" });
  });
  test("workspace.fetch fetches the base branch from origin inside the workspace", async () => {
    const w = await world();
    const p = await w.record();
    await tool("workspace.fetch", w);
    expect(w.git.calls).toEqual([["fetch", p, "origin", "main"]]);
  });
  test("workspace.push pushes the workspace branch, with force-with-lease only when asked", async () => {
    const w = await world();
    const p = await w.record();
    await tool("workspace.push", w);
    await tool("workspace.push", w, { forceWithLease: true });
    expect(w.git.calls).toEqual([
      ["push", p, "conveyor/7-r1-x", { forceWithLease: false }],
      ["push", p, "conveyor/7-r1-x", { forceWithLease: true }],
    ]);
  });
  test("tools fail without a workspace", async () => {
    const w = await world();
    for (const name of ["workspace.get", "workspace.fetch", "workspace.push"]) {
      expect(await tool(name, w)).toEqual({ status: "fail", message: "run has no workspace" });
    }
  });
  test("mutation flags: push and fetch mutate, get does not; push invalidates workspace", () => {
    expect(registry.require("workspace.get").mutating).toBeFalsy();
    expect(registry.require("workspace.fetch").mutating).toBe(true);
    expect(registry.require("workspace.push").mutating).toBe(true);
    expect(registry.require("workspace.push").invalidates).toEqual(["workspace"]);
  });
  test("push and fetch are not journaled: an agent may push or fetch again after new commits in the same run", () => {
    expect(registry.require("workspace.push").journal).toBe(false);
    expect(registry.require("workspace.fetch").journal).toBe(false);
  });
});
