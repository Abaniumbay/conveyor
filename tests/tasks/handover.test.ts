import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { ReviewFindings } from "../../src/engine/review-findings";
import { ItemTodos } from "../../src/engine/todos";
import type { TaskDeps } from "../../src/tasks/deps";
import { buildHandover, HANDOVER_LIMITS } from "../../src/tasks/handover";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out: out.trim(), code };
}

async function setup(options: { ci?: "ok" | "throws" | "none"; changeHead?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-handover-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  store.upsertIssue({ id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://x/7", title: "T", body: "", sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
  store.activateEnrollment("i1");
  if (options.changeHead !== undefined) store.upsertPullRequest({ issueId: "i1", id: "github:o/r#5", number: 5, url: "https://x/pull/5", state: "open" });
  const workspace = path.join(root, "ws");
  await mkdir(workspace);
  const listed: Array<{ name: string; state: string }> = [];
  const requestedHeads: string[] = [];
  const deps = {
    store, git: {} as never,
    config: { agents: { kaveh: { name: "Kaveh", title: "Implementer" }, jamshid: { name: "Jamshid", title: "Implementer" } } },
    repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main" },
    issueId: "i1",
    codeHost: options.changeHead === undefined ? null : {
      getChangeDelivery: async () => ({ change: { number: 5, url: "https://x/pull/5", headSha: options.changeHead, mergeable: true }, checks: [] }),
    },
    ci: options.ci === "none" ? undefined : {
      provider: () => ({
        list: async (_change: unknown, head: string) => {
          requestedHeads.push(head);
          if (options.ci === "throws") throw new Error("provider down");
          return listed.map((run, index) => ({ id: String(index), url: null, canRerun: false, hasLog: false, ...run }));
        },
      }),
    },
  } as unknown as TaskDeps;
  const build = (agentId = "kaveh", runId = "current") =>
    buildHandover(deps, { runId, stageId: "implementation", agentId, kind: "producer", workspace: { path: workspace, branch: "conveyor/7" } });
  return { store, deps, workspace, listed, requestedHeads, build, root };
}

function priorRun(store: ConveyorStore, id: string, agentId: string, result: Record<string, unknown>, status = "succeeded") {
  store.createRun({ id, issueId: "i1", stageId: "implementation", attempt: 1, kind: "producer", status: "running", configHash: "c", startedAt: `2026-01-01T00:00:0${id.length}Z` });
  store.appendRunEvent(id, "execution", { idempotencyKey: "k", agentId });
  store.finishRun(id, { status, exitCode: 0, result, sessionId: null, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, amount: 0, currency: "USD", source: "unavailable", durationMs: 1 } } as never);
}

describe("handover", () => {
  test("states absence explicitly", async () => {
    const w = await setup({ ci: "none" });
    const h = await w.build();
    expect(h.todos).toMatchObject({ present: false, items: [] });
    expect(h.openFindings).toMatchObject({ count: 0, items: [] });
    expect(h.change).toMatchObject({ exists: false });
    expect(h.previousRun).toMatchObject({ present: false });
    expect(h.worktree).toMatchObject({ branch: "unavailable", headSha: "unavailable", clean: "unavailable", gitOperation: "unavailable" });
  });

  test("shows todos, only open findings, the change and CI for the current head", async () => {
    const w = await setup({ changeHead: "head-2" });
    new ItemTodos(w.store.sqlite()).set("i1", [
      { id: "t1", text: "Do A", status: "done" }, { id: "t2", text: "Do B", status: "in_progress", note: "stopped here" },
    ], null, "2026-01-01T00:00:00Z");
    const findings = new ReviewFindings(w.store.sqlite());
    findings.create({ issueId: "i1", runId: null, author: "reviewer", headSha: "head-1", path: "a.ts", line: 3, body: "Open one" });
    const resolved = findings.create({ issueId: "i1", runId: null, author: "reviewer", headSha: "head-1", body: "Closed one" });
    findings.resolve("i1", resolved.id, "kaveh");
    w.listed.push({ name: "Check", state: "failed" }, { name: "Check", state: "passed" }, { name: "E2E", state: "running" });
    const h = await w.build();
    expect(h.todos).toMatchObject({ progress: "1/2 done", items: [{ id: "t1", status: "done" }, { id: "t2", status: "in_progress", note: "stopped here" }] });
    expect(h.openFindings).toMatchObject({ count: 1, items: [{ author: "reviewer", file: "a.ts", line: 3, text: "Open one" }] });
    expect(h.change).toMatchObject({ number: 5, url: "https://x/pull/5", headSha: "head-2", mergeable: "yes" });
    expect((h.change as { ci: unknown }).ci).toEqual({
      available: true, headSha: "head-2", checks: [{ name: "Check", state: "passed" }, { name: "E2E", state: "running" }], truncated: null,
    });
    expect(w.requestedHeads).toEqual(["head-2"]);
  });

  test("reports CI that cannot be read or has no results without inventing one", async () => {
    {
      const w = await setup({ changeHead: "h", ci: "throws" });
      expect(((await w.build()).change as { ci: { available: boolean; note: string } }).ci).toMatchObject({ available: false, note: expect.stringContaining("provider down") });
    }
    const empty = await setup({ changeHead: "h" });
    expect(((await empty.build()).change as { ci: unknown }).ci).toMatchObject({ available: true, checks: [], note: expect.stringContaining("No CI results") });
  });

  test("names the previous agent when it differs, and not otherwise", async () => {
    const w = await setup({ ci: "none" });
    priorRun(w.store, "run-a", "kaveh", { outcome: "success", status: "done", summary: "Rebased it" });
    const other = (await w.build("jamshid")).previousRun as Record<string, unknown>;
    expect(other).toMatchObject({ agent: "Kaveh", outcome: "success", status: "done", summary: "Rebased it" });
    expect(String(other.handoff)).toContain("Kaveh");
    expect(((await w.build("kaveh")).previousRun as Record<string, unknown>).handoff).toBeUndefined();
    expect(((await w.build("kaveh", "run-a")).previousRun as Record<string, unknown>).present).toBe(false);
  });

  test("truncates each part and says which tool returns the rest", async () => {
    const w = await setup({ changeHead: "h" });
    new ItemTodos(w.store.sqlite()).set("i1", Array.from({ length: HANDOVER_LIMITS.todos + 5 }, (_, i) => ({ id: `t${i}`, text: "x", status: "pending" as const })), null, "2026-01-01T00:00:00Z");
    const findings = new ReviewFindings(w.store.sqlite());
    for (let i = 0; i < HANDOVER_LIMITS.findings + 2; i++) findings.create({ issueId: "i1", runId: null, author: "r", headSha: "h", body: "y".repeat(HANDOVER_LIMITS.findingText + 10) });
    for (let i = 0; i < HANDOVER_LIMITS.checks + 3; i++) w.listed.push({ name: `c${i}`, state: "passed" });
    priorRun(w.store, "run-a", "kaveh", { outcome: "success", status: "done", summary: "s".repeat(HANDOVER_LIMITS.summary + 50) });
    const h = await w.build();
    expect(h.todos.items).toHaveLength(HANDOVER_LIMITS.todos);
    expect(h.todos.truncated).toMatchObject({ omitted: expect.stringContaining("5 more todos"), fullState: "todo.get" });
    expect(h.openFindings.items).toHaveLength(HANDOVER_LIMITS.findings);
    expect(h.openFindings.truncated).toMatchObject({ omitted: expect.stringContaining("2 more open findings"), fullState: "change.listFindings" });
    expect(h.openFindings.items[0]!.text.length).toBeLessThanOrEqual(HANDOVER_LIMITS.findingText);
    const ci = (h.change as { ci: { checks: unknown[]; truncated: { fullState: string } } }).ci;
    expect(ci.checks).toHaveLength(HANDOVER_LIMITS.checks);
    expect(ci.truncated.fullState).toBe("change.get");
    const previous = h.previousRun as { summary: string; truncated: { fullState: string } };
    expect(previous.summary.length).toBeLessThanOrEqual(HANDOVER_LIMITS.summary);
    expect(previous.truncated.fullState).toBe("conversation.get");
  });

  describe("worktree", () => {
    async function repository(w: Awaited<ReturnType<typeof setup>>) {
      await git(w.workspace, "init", "-b", "main");
      await writeFile(path.join(w.workspace, "f.txt"), "base\n");
      await git(w.workspace, "add", ".");
      await git(w.workspace, "commit", "-m", "base");
      await git(w.workspace, "update-ref", "refs/remotes/origin/main", "HEAD");
    }

    test("reports branch, head, cleanliness and ahead/behind", async () => {
      const w = await setup({ ci: "none" });
      await repository(w);
      await git(w.workspace, "checkout", "-b", "feature");
      await writeFile(path.join(w.workspace, "g.txt"), "g\n");
      await git(w.workspace, "add", ".");
      await git(w.workspace, "commit", "-m", "feature");
      await writeFile(path.join(w.workspace, "dirty.txt"), "d\n");
      expect((await w.build()).worktree).toMatchObject({ branch: "feature", clean: false, gitOperation: "none", againstFetchedBase: { base: "origin/main", ahead: 1, behind: 0 } });
    });

    for (const kind of ["rebase", "cherry-pick", "merge"] as const) {
      test(`detects a ${kind} stopped on a conflict and forbids discarding it`, async () => {
        const w = await setup({ ci: "none" });
        await repository(w);
        await git(w.workspace, "checkout", "-b", "feature");
        await writeFile(path.join(w.workspace, "f.txt"), "feature\n");
        await git(w.workspace, "commit", "-am", "feature change");
        const feature = (await git(w.workspace, "rev-parse", "HEAD")).out;
        await git(w.workspace, "checkout", "main");
        await writeFile(path.join(w.workspace, "f.txt"), "main\n");
        await git(w.workspace, "commit", "-am", "main change");
        if (kind === "rebase") { await git(w.workspace, "checkout", "feature"); await git(w.workspace, "rebase", "main"); }
        else if (kind === "cherry-pick") await git(w.workspace, "cherry-pick", feature);
        else await git(w.workspace, "merge", "feature");
        const { worktree } = await w.build();
        const operation = worktree.gitOperation as { kind: string; stoppedOn: string; warning: string };
        expect(operation.kind).toBe(kind);
        expect(operation.stoppedOn).toBe(feature);
        expect(operation.warning).toContain(`stopped on commit ${feature}`);
        expect(operation.warning).toContain("do not discard");
        expect(worktree.clean).toBe(false);
      });
    }
  });
});
