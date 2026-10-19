import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { ConveyorStore } from "../../src/db/store";
import { canonicalToolName, AGENT_DENIED_TOOLS } from "../../src/tasks/aliases";
import { defineGroup, fail, pass, TaskInputError, TaskRegistry } from "../../src/tasks/contract";
import type { TaskDeps } from "../../src/tasks/deps";
import { dispatchTool, type DispatchEnv, type ToolGrant } from "../../src/tasks/dispatch";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import { ToolRequestError } from "../../src/tasks/errors";
import { cliGit } from "../../src/workspace/git";

const runs: string[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function registry(): TaskRegistry {
  const r = new TaskRegistry();
  r.register(defineGroup("item", [
    {
      name: "item.setThing", kind: "tool", description: "Sets a thing", reads: [], writes: [], invalidates: ["item"], mutating: true,
      input: z.object({ value: z.string().min(1), headSha: z.string().optional() }),
      run({ input, instance }) { runs.push(`${(input as { value: string }).value}@${instance.idempotencyKey}`); return pass({ done: true }); },
    },
    {
      name: "item.getThing", kind: "tool", description: "Gets a thing", reads: [], writes: [], invalidates: [],
      input: z.object({}), run() { return pass({ thing: 1 }); },
    },
    {
      name: "item.syncThing", kind: "tool", description: "Syncs a thing", reads: [], writes: [], invalidates: [], mutating: true, journal: false,
      input: z.object({}), run() { runs.push("sync"); return pass({ accepted: true }); },
    },
    {
      name: "item.broken", kind: "tool", description: "Fails", reads: [], writes: [], invalidates: [], mutating: true,
      input: z.object({}), run() { return fail("nope"); },
    },
  ]));
  r.register(defineGroup("agent", [
    {
      name: "agent.reportProgress", kind: "tool", description: "Reports", reads: [], writes: [], invalidates: [],
      input: z.object({ message: z.string() }), run() { return pass({ accepted: true }); },
    },
  ]));
  return r;
}

function env(head: string | null = "abc", taskRegistry: TaskRegistry = registry()): DispatchEnv & { journal: Map<string, { status: string; response: unknown }> } {
  const journal = new Map<string, { status: string; response: unknown }>();
  let id = 0;
  return {
    registry: taskRegistry,
    deps: () => ({}) as never,
    liveHeadSha: async () => head,
    journal,
    store: {
      beginSourceMutation: ({ idempotencyKey }) => {
        const found = [...journal.entries()].find(([key]) => key === idempotencyKey);
        if (found) return { id: found[0], idempotencyKey, status: found[1].status, response: found[1].response } as never;
        journal.set(idempotencyKey, { status: "pending", response: null });
        id += 1;
        return { id: idempotencyKey, idempotencyKey, status: "pending", response: null, seq: id } as never;
      },
      completeSourceMutation: (key, response) => { journal.set(key, { status: "succeeded", response }); },
      failSourceMutation: (key) => { journal.set(key, { status: "failed", response: null }); },
    },
  };
}

const actor = { id: "kaveh", name: "Kaveh", title: "Implementer" };
const grant = (tasks: string[], over: Partial<ToolGrant> = {}): ToolGrant => ({
  runId: "run-1", stageId: "implementation", issueScoped: true, actor, tasks: new Set(tasks), ...over,
});

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function gitOptional(cwd: string, args: string[]): Promise<string | null> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return exitCode === 0 ? stdout.trim() : null;
}

async function commit(workspace: string, filename: string, contents: string, message: string): Promise<void> {
  await writeFile(path.join(workspace, filename), contents);
  await git(workspace, ["add", filename]);
  await git(workspace, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
}

async function leaseWorld(options: { published?: boolean; liveHead?: string | null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-dispatch-"));
  directories.push(root);
  const remote = path.join(root, "remote.git");
  const workspace = path.join(root, "workspace");
  const branch = "conveyor/7-r1-lease";
  await git(root, ["init", "--bare", "--initial-branch=main", remote]);
  await git(root, ["clone", remote, workspace]);
  await commit(workspace, "base.txt", "base\n", "base");
  await git(workspace, ["checkout", "-b", branch]);
  await commit(workspace, "feature.txt", "feature\n", "feature");
  if (options.published !== false) await cliGit.push(workspace, branch, { forceWithLease: false });

  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: "hash" });
  store.upsertIssue({
    id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://example.com/issues/7", title: "Lease", body: "",
    sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  const enrollment = store.activateEnrollment("i1");
  store.recordWorkspace({ id: "workspace", enrollmentId: enrollment.id, path: workspace, branch, status: "active" });
  const deps: TaskDeps = {
    store, config: {} as never, items: {} as never,
    repository: { id: "repo", address: "owner/my-app", folder: root, baseBranch: "main" },
    issueId: "i1", sourceGuidance: "", git: cliGit, workspaces: {} as never,
  };
  const env: DispatchEnv = {
    registry: createTaskRegistry(), deps: () => deps, liveHeadSha: async () => options.liveHead ?? null, store,
  };
  return { remote, workspace, branch, env };
}

describe("alias table", () => {
  test("maps legacy names to canonical camelCase and leaves canonical names alone", () => {
    expect(canonicalToolName("source.get_issue")).toBe("item.get");
    expect(canonicalToolName("workspace.get_context")).toBe("workspace.get");
    expect(canonicalToolName("delivery.get_check_logs")).toBe("ci.getLogs");
    expect(canonicalToolName("workspace.record_artifact")).toBe("agent.recordArtifact");
    expect(canonicalToolName("item.comment")).toBe("item.comment");
  });

  test("every alias target is a registered tool task", () => {
    const tools = new Set(createTaskRegistry().list("tool").map((t) => t.name));
    for (const legacy of ["source.get_issue", "source.get_guidance", "workspace.get_context", "delivery.get_state", "run.ask_question", "run.record_artifact"]) {
      expect(tools.has(canonicalToolName(legacy))).toBe(true);
    }
    expect(createTaskRegistry().require("agent.recordArtifact").mutating).toBe(true);
    expect(AGENT_DENIED_TOOLS).toContain("change.dismissFinding");
  });
});

describe("dispatchTool", () => {
  test("enforces the grant, by canonical or legacy name", async () => {
    const e = env();
    await expect(dispatchTool({ name: "item.getThing", input: {}, grant: grant([]), actor }, e)).rejects.toThrow("MCP tool is not granted: item.getThing");
    expect(await dispatchTool({ name: "item.getThing", input: {}, grant: grant(["item.getThing"]), actor }, e)).toEqual({ thing: 1 });
  });

  test("resolves a legacy alias before checking the grant", async () => {
    const e = env();
    expect(await dispatchTool({ name: "run.report_progress", input: { message: "hi" }, grant: grant(["agent.reportProgress"]), actor }, e)).toEqual({ accepted: true });
  });

  test("rejects an unknown tool", async () => {
    await expect(dispatchTool({ name: "item.nothing", input: {}, grant: grant(["item.nothing"]), actor }, env())).rejects.toThrow("Unknown MCP tool: item.nothing");
  });

  test("invalid input fails with the zod message and runs nothing", async () => {
    const e = env();
    runs.length = 0;
    const call = dispatchTool({ name: "item.setThing", input: { value: "" }, grant: grant(["item.setThing"]), actor }, e);
    await expect(call).rejects.toBeInstanceOf(TaskInputError);
    await expect(call).rejects.toThrow("Invalid input for task item.setThing");
    expect(runs).toEqual([]);
    expect(e.journal.size).toBe(0);
  });

  test("an item tool needs an issue-scoped grant; report tools do not", async () => {
    const e = env();
    const system = grant(["item.getThing", "agent.reportProgress"], { issueScoped: false, actor: null });
    await expect(dispatchTool({ name: "item.getThing", input: {}, grant: system, actor: null }, e)).rejects.toThrow("item.getThing requires an issue-scoped MCP grant");
    expect(await dispatchTool({ name: "agent.reportProgress", input: { message: "x" }, grant: system, actor: null }, e)).toEqual({ accepted: true });
  });

  test("an issue-scoped call needs an actor", async () => {
    await expect(dispatchTool({ name: "item.getThing", input: {}, grant: grant(["item.getThing"], { actor: null }), actor: null }, env())).rejects.toThrow("requires an actor");
  });

  test("a mutating call is journaled by run, tool and input: a retried identical call returns the stored response", async () => {
    const e = env();
    runs.length = 0;
    const g = grant(["item.setThing"]);
    const first = await dispatchTool({ name: "item.setThing", input: { value: "a" }, grant: g, actor }, e);
    const again = await dispatchTool({ name: "item.setThing", input: { value: "a" }, grant: g, actor }, e);
    expect(first).toEqual({ done: true });
    expect(again).toEqual({ done: true });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/^a@mcp:run-1:item\.setThing:[0-9a-f]{64}$/);
    await dispatchTool({ name: "item.setThing", input: { value: "b" }, grant: g, actor }, e);
    expect(runs).toHaveLength(2);
    await dispatchTool({ name: "item.setThing", input: { value: "a" }, grant: { ...g, runId: "run-2" }, actor }, e);
    expect(runs).toHaveLength(3);
  });

  test("an unjournaled mutating call runs every time, even with identical input in the same run", async () => {
    const e = env();
    runs.length = 0;
    const g = grant(["item.syncThing"]);
    await dispatchTool({ name: "item.syncThing", input: {}, grant: g, actor }, e);
    await dispatchTool({ name: "item.syncThing", input: {}, grant: g, actor }, e);
    expect(runs).toEqual(["sync", "sync"]);
    expect(e.journal.size).toBe(0);
  });

  test("a failed mutating call is marked failed and may be retried", async () => {
    const e = env();
    const g = grant(["item.broken"]);
    await expect(dispatchTool({ name: "item.broken", input: {}, grant: g, actor }, e)).rejects.toThrow("nope");
    expect([...e.journal.values()].map((entry) => entry.status)).toEqual(["failed"]);
  });

  test("an input headSha must equal the live change head", async () => {
    const g = grant(["item.setThing"]);
    const stale = dispatchTool({ name: "item.setThing", input: { value: "a", headSha: "old" }, grant: g, actor }, env("new"));
    await expect(stale).rejects.toBeInstanceOf(ToolRequestError);
    await expect(stale)
      .rejects.toThrow("headSha old is not the current change head new");
    runs.length = 0;
    await dispatchTool({ name: "item.setThing", input: { value: "a", headSha: "new" }, grant: g, actor }, env("new"));
    expect(runs).toHaveLength(1);
  });

  test("a headSha with no change to compare against fails clearly", async () => {
    const missing = dispatchTool({ name: "item.setThing", input: { value: "a", headSha: "x" }, grant: grant(["item.setThing"]), actor }, env(null));
    await expect(missing).rejects.toBeInstanceOf(ToolRequestError);
    await expect(missing)
      .rejects.toThrow("has no change request");
  });

  test("a stale workspace.push head is an actionable tool request error", async () => {
    const observedHead = "a".repeat(40);
    const liveHead = "b".repeat(40);
    const e = env(liveHead, createTaskRegistry());
    const push = dispatchTool({
      name: "workspace.push", input: { forceWithLease: true, headSha: observedHead }, grant: grant(["workspace.push"]), actor,
    }, e);

    await expect(push).rejects.toBeInstanceOf(ToolRequestError);
    await expect(push).rejects.toThrow(`headSha ${observedHead} is not the current change head ${liveHead}; read change.get and retry`);
    expect(e.journal.size).toBe(0);
  });

  test("a no-change lease push publishes a reconciled branch through the dispatcher", async () => {
    const w = await leaseWorld();
    const server = path.join(path.dirname(w.workspace), "server");
    await git(path.dirname(w.workspace), ["clone", w.remote, server]);
    await git(server, ["checkout", w.branch]);
    await commit(server, "server.txt", "server\n", "server");
    await git(server, ["push", "origin", w.branch]);
    await commit(w.workspace, "local.txt", "local\n", "local");
    await cliGit.fetch(w.workspace, "origin", w.branch);
    const observedHead = await cliGit.remoteBranchHead(w.workspace, w.branch);
    if (observedHead === null) throw new Error("published branch unexpectedly disappeared");
    await git(w.workspace, ["rebase", observedHead]);

    expect(await dispatchTool({
      name: "workspace.push", input: { forceWithLease: true, headSha: observedHead }, grant: grant(["workspace.push"]), actor,
    }, w.env)).toEqual({ accepted: true });
    expect(await git(path.dirname(w.workspace), ["--git-dir", w.remote, "rev-parse", `refs/heads/${w.branch}`]))
      .toBe(await git(w.workspace, ["rev-parse", "HEAD"]));
  });

  test("a no-change lease push publishes a feature rebased onto a moved base", async () => {
    const w = await leaseWorld();
    const observedHead = await cliGit.remoteBranchHead(w.workspace, w.branch);
    if (observedHead === null) throw new Error("published branch unexpectedly disappeared");
    const server = path.join(path.dirname(w.workspace), "server");
    await git(path.dirname(w.workspace), ["clone", w.remote, server]);
    await commit(server, "base-update.txt", "base update\n", "base update");
    await git(server, ["push", "origin", "main"]);
    await cliGit.fetch(w.workspace, "origin", "main");
    await git(w.workspace, ["rebase", "origin/main"]);

    expect(await dispatchTool({
      name: "workspace.push", input: { forceWithLease: true, headSha: observedHead }, grant: grant(["workspace.push"]), actor,
    }, w.env)).toEqual({ accepted: true });
    expect(await git(path.dirname(w.workspace), ["--git-dir", w.remote, "rev-parse", `refs/heads/${w.branch}`]))
      .toBe(await git(w.workspace, ["rev-parse", "HEAD"]));
  });

  test("a no-change lease push accepts a published patch already on the new base", async () => {
    const w = await leaseWorld();
    const observedHead = await cliGit.remoteBranchHead(w.workspace, w.branch);
    if (observedHead === null) throw new Error("published branch unexpectedly disappeared");
    const server = path.join(path.dirname(w.workspace), "server");
    await git(path.dirname(w.workspace), ["clone", w.remote, server]);
    await git(server, ["cherry-pick", observedHead]);
    await git(server, ["push", "origin", "main"]);
    await cliGit.fetch(w.workspace, "origin", "main");
    await git(w.workspace, ["rebase", "origin/main"]);

    expect(await dispatchTool({
      name: "workspace.push", input: { forceWithLease: true, headSha: observedHead }, grant: grant(["workspace.push"]), actor,
    }, w.env)).toEqual({ accepted: true });
    expect(await git(path.dirname(w.workspace), ["--git-dir", w.remote, "rev-parse", `refs/heads/${w.branch}`]))
      .toBe(await git(w.workspace, ["rev-parse", "HEAD"]));
  });

  test("a no-change lease push refuses to drop a published branch patch", async () => {
    const w = await leaseWorld();
    const observedHead = await cliGit.remoteBranchHead(w.workspace, w.branch);
    if (observedHead === null) throw new Error("published branch unexpectedly disappeared");
    const server = path.join(path.dirname(w.workspace), "server");
    await git(path.dirname(w.workspace), ["clone", w.remote, server]);
    await commit(server, "base-update.txt", "base update\n", "base update");
    await git(server, ["push", "origin", "main"]);
    await cliGit.fetch(w.workspace, "origin", "main");
    await git(w.workspace, ["reset", "--hard", "origin/main"]);

    const error = await dispatchTool({
      name: "workspace.push", input: { forceWithLease: true, headSha: observedHead }, grant: grant(["workspace.push"]), actor,
    }, w.env).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    const omitted = (error as Error).message.match(/[0-9a-f]{40}/i)?.[0];
    if (omitted === undefined) throw new Error("omitted commit was not named");
    expect((await git(w.workspace, ["rev-list", "origin/main..origin/" + w.branch])).split("\n")).toContain(omitted);
    expect((error as Error).message).toContain("reconcile or reapply the missing change");
    expect(await git(path.dirname(w.workspace), ["--git-dir", w.remote, "rev-parse", `refs/heads/${w.branch}`])).toBe(observedHead);
  });

  test("a no-change lease push rejects a stale supplied head despite a stale tracking ref", async () => {
    const w = await leaseWorld();
    const staleHead = await git(w.workspace, ["rev-parse", "HEAD"]);
    const server = path.join(path.dirname(w.workspace), "server");
    await git(path.dirname(w.workspace), ["clone", w.remote, server]);
    await git(server, ["checkout", w.branch]);
    await commit(server, "server.txt", "server\n", "server");
    await git(server, ["push", "origin", w.branch]);
    const currentHead = await git(path.dirname(w.workspace), ["--git-dir", w.remote, "rev-parse", `refs/heads/${w.branch}`]);
    await git(w.workspace, ["update-ref", `refs/remotes/origin/${w.branch}`, staleHead]);

    await expect(dispatchTool({
      name: "workspace.push", input: { forceWithLease: true, headSha: staleHead }, grant: grant(["workspace.push"]), actor,
    }, w.env)).rejects.toThrow(`The remote branch moved to ${currentHead}; use workspace.fetch, rebase, and retry.`);
    expect(await git(path.dirname(w.workspace), ["--git-dir", w.remote, "rev-parse", `refs/heads/${w.branch}`])).toBe(currentHead);
  });

  test("a no-change lease push does not create a branch that origin lacks", async () => {
    const w = await leaseWorld({ published: false });
    const localHead = await git(w.workspace, ["rev-parse", "HEAD"]);

    await expect(dispatchTool({
      name: "workspace.push", input: { forceWithLease: true, headSha: localHead }, grant: grant(["workspace.push"]), actor,
    }, w.env)).rejects.toThrow("push without forceWithLease to create it");
    expect(await gitOptional(path.dirname(w.workspace), ["--git-dir", w.remote, "rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`])).toBeNull();
  });

  test("a no-change lease push refuses an observed remote head that is unavailable locally", async () => {
    const w = await leaseWorld();
    const server = path.join(path.dirname(w.workspace), "server");
    await git(path.dirname(w.workspace), ["clone", w.remote, server]);
    await git(server, ["checkout", w.branch]);
    await commit(server, "server.txt", "server\n", "server");
    await git(server, ["push", "origin", w.branch]);
    const observedHead = await git(server, ["rev-parse", "HEAD"]);

    await expect(dispatchTool({
      name: "workspace.push", input: { forceWithLease: true, headSha: observedHead }, grant: grant(["workspace.push"]), actor,
    }, w.env)).rejects.toThrow(`The observed remote head ${observedHead} is unavailable locally; use workspace.fetch, rebase onto origin/main, and retry.`);
    expect(await git(path.dirname(w.workspace), ["--git-dir", w.remote, "rev-parse", `refs/heads/${w.branch}`])).toBe(observedHead);
  });

  test("an ordinary workspace push creates an unpublished branch", async () => {
    const w = await leaseWorld({ published: false });

    expect(await dispatchTool({
      name: "workspace.push", input: {}, grant: grant(["workspace.push"]), actor,
    }, w.env)).toEqual({ accepted: true });
    expect(await git(path.dirname(w.workspace), ["--git-dir", w.remote, "rev-parse", `refs/heads/${w.branch}`]))
      .toBe(await git(w.workspace, ["rev-parse", "HEAD"]));
  });

  test("an ordinary workspace push cannot overwrite a divergent remote branch", async () => {
    const w = await leaseWorld();
    const server = path.join(path.dirname(w.workspace), "server");
    await git(path.dirname(w.workspace), ["clone", w.remote, server]);
    await git(server, ["checkout", w.branch]);
    await commit(server, "server.txt", "server\n", "server");
    await git(server, ["push", "origin", w.branch]);
    const remoteHead = await git(server, ["rev-parse", "HEAD"]);
    await commit(w.workspace, "local.txt", "local\n", "local");

    await expect(dispatchTool({
      name: "workspace.push", input: {}, grant: grant(["workspace.push"]), actor,
    }, w.env)).rejects.toThrow("git push failed");
    expect(await git(path.dirname(w.workspace), ["--git-dir", w.remote, "rev-parse", `refs/heads/${w.branch}`])).toBe(remoteHead);
  });

  test("a no-change lease push preserves a concurrent remote commit that arrives after validation", async () => {
    const w = await leaseWorld();
    const observedHead = await cliGit.remoteBranchHead(w.workspace, w.branch);
    if (observedHead === null) throw new Error("published branch unexpectedly disappeared");
    await commit(w.workspace, "local.txt", "local\n", "local");
    const mover = path.join(path.dirname(w.workspace), "mover");
    await git(path.dirname(w.workspace), ["clone", w.remote, mover]);
    await git(mover, ["checkout", w.branch]);
    await commit(mover, "moved.txt", "moved\n", "moved");
    const movedHead = await git(mover, ["rev-parse", "HEAD"]);
    await git(mover, ["push", "origin", `HEAD:prepared-${w.branch}`]);
    await writeFile(path.join(w.workspace, ".git", "hooks", "pre-push"), `#!/bin/sh\ngit --git-dir="$2" update-ref refs/heads/${w.branch} ${movedHead}\n`);
    await chmod(path.join(w.workspace, ".git", "hooks", "pre-push"), 0o755);

    await expect(dispatchTool({
      name: "workspace.push", input: { forceWithLease: true, headSha: observedHead }, grant: grant(["workspace.push"]), actor,
    }, w.env)).rejects.toThrow(`The remote branch moved to ${movedHead}; use workspace.fetch, rebase, and retry.`);
    expect(await git(path.dirname(w.workspace), ["--git-dir", w.remote, "rev-parse", `refs/heads/${w.branch}`])).toBe(movedHead);
  });
});
