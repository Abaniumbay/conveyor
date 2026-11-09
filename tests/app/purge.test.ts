import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ItemTodos } from "../../src/engine/todos";
import { WorkspaceManager } from "../../src/workspace/manager";
import { createWorkspace } from "../../src/workspace/lifecycle";
import { deliveryWorld, git, type DeliveryWorld } from "../support/delivery-world";

let world: DeliveryWorld | null = null;
afterEach(async () => { await world?.close(); world = null; });

const HANGING_DEPLOY = [
  'import { writeFile } from "node:fs/promises";',
  'await writeFile("script-ready", String(process.pid));',
  'await new Promise<never>(() => {});',
].join("\n");

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Every table that may hold a row of the item, with the column naming it. */
const ITEM_TABLES: Array<[string, string]> = [
  ["issues", "id"], ["stage_states", "issue_id"], ["stage_cursors", "issue_id"], ["task_executions", "issue_id"],
  ["item_todos", "issue_id"], ["questions", "issue_id"], ["issue_relationships", "parent_id"], ["issue_relationships", "child_id"],
  ["dependencies", "issue_id"], ["dependencies", "blocker_id"], ["enrollments", "issue_id"], ["stage_transitions", "issue_id"],
  ["conversation_messages", "issue_id"], ["runs", "issue_id"],
];

function rowsOf(w: DeliveryWorld, issueId: string): Record<string, number> {
  return Object.fromEntries(ITEM_TABLES.map(([table, column]) => [
    `${table}.${column}`,
    (w.store.sqlite().query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(issueId) as { count: number }).count,
  ]));
}

/** An item with a deploy script running in its real workspace, plus a todo, a question and a relationship. */
async function runningItem(options: { onGithubCall?: (method: string) => void | Promise<void>; deployScript?: string } = {}): Promise<{ w: DeliveryWorld; pid: number; workspacePath: string; branch: string }> {
  world = await deliveryWorld({ interruptGrace: "50ms", publicLifecycle: true, ...options, deployScript: options.deployScript ?? HANGING_DEPLOY });
  const w = world;
  w.store.setIssueProjection("issue", { stage: "deploy", state: "active", warning: null });
  w.editLabelsOnGitHub(() => ["conveyor", "conveyor:deploy"]);
  w.store.setStageState({ issueId: "issue", stageId: "deploy", status: "ready", feedbackCycle: 0, configHash: w.config.hash });
  const folder = w.config.repositories.conveyor!.folder;
  // The item's real worktree and branch, cut from the repository the way a stage run cuts them.
  const workspace = await createWorkspace({
    store: w.store, manager: new WorkspaceManager(w.config.settings.workspaces), issue: w.store.getIssue("issue")!,
    repository: { id: "conveyor", folder, baseBranch: "main" },
  });
  const ready = path.join(workspace.path, "script-ready");
  await w.service.postIssueMessage("issue", "Start deploy", "operator");
  await until(() => existsSync(ready), "the deploy script to start");
  new ItemTodos(w.store.sqlite()).set("issue", [{ id: "t1", text: "Do it", status: "pending" }], null, new Date().toISOString());
  w.store.openQuestion({ issueId: "issue", runId: null, prompt: "Which?", reason: "needs a choice", options: ["a", "b"] });
  w.store.upsertIssue({
    id: "child", repositoryId: "conveyor", sourceNumber: 2, sourceUrl: "https://github.com/owner/conveyor/issues/2",
    title: "Child", body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  w.store.replaceRelationships("child", { parentId: "issue", siblingOrder: 1 }, []);
  return { w, pid: Number(readFileSync(ready, "utf8")), workspacePath: workspace.path, branch: workspace.branch };
}

describe("purging an item that lost its Conveyor labels", () => {
  test("kills the running agent before any GitHub request for the item, then removes workspace, worktree and branch and every row", async () => {
    const calls: Array<{ method: string; agentAlive: boolean }> = [];
    let pid = 0;
    const { w, pid: agentPid, workspacePath, branch } = await runningItem({
      onGithubCall: (method) => { calls.push({ method, agentAlive: pid !== 0 && alive(pid) }); },
    });
    pid = agentPid;
    expect(alive(pid)).toBe(true);
    expect(existsSync(workspacePath)).toBe(true);
    expect(await git(w.config.repositories.conveyor!.folder, "branch", "--list", branch)).not.toBe("");
    expect(rowsOf(w, "issue")["issues.id"]).toBe(1);
    calls.length = 0;

    w.editLabelsOnGitHub(() => []);
    await w.deliverIssueEvent("unlabeled", "unlabel-1");
    await w.service.purgesSettled();

    // AC-1: the process was dead at every GitHub request made while the delivery was handled.
    expect(alive(pid)).toBe(false);
    expect(calls.filter((call) => call.agentAlive)).toEqual([]);
    // AC-2: workspace, worktree and branch are gone.
    expect(existsSync(workspacePath)).toBe(false);
    expect(await git(w.config.repositories.conveyor!.folder, "worktree", "list")).not.toContain(workspacePath);
    expect(await git(w.config.repositories.conveyor!.folder, "branch", "--list", branch)).toBe("");
    // AC-3: no row of the item is left, in the real database.
    expect(Object.entries(rowsOf(w, "issue")).filter(([, count]) => count > 0)).toEqual([]);
    expect(w.store.getIssue("issue")).toBeNull();
    expect(w.store.listPendingPurges()).toEqual([]);
    // The child survives its parent, unattached.
    expect(w.store.getIssue("child")).not.toBeNull();
    expect(w.store.getIssue("child")!.parentId).toBeNull();
  });

  test("a purge does not wait for the follow-up reconcile of a run whose agent has ended", async () => {
    let gate: Promise<void> | null = null;
    let reached = false;
    let open = () => {};
    const { w, workspacePath } = await runningItem({
      deployScript: [
        'import { existsSync, writeFileSync } from "node:fs";',
        'writeFileSync("script-ready", String(process.pid));',
        'while (!existsSync("script-release")) await new Promise((r) => setTimeout(r, 10));',
        'console.log(JSON.stringify({ outcome: "success", summary: "deploy done" }));',
      ].join("\n"),
      onGithubCall: (method) => {
        if (!gate || reached || method === "upsertStatusComment") return;
        reached = true;
        return gate;
      },
    });
    gate = new Promise<void>((resolve) => { open = resolve; });

    // A sync holds the repository lock. The stage ends and its follow-up reconcile queues behind the
    // sync, so it cannot finish while the lock is held.
    const sync = w.service.syncRepository("conveyor");
    await until(() => reached, "the sync to hold the repository lock");
    writeFileSync(path.join(workspacePath, "script-release"), "");
    await until(() => w.store.getStageState("issue")?.stageId === "verify", "the stage to end");
    await Bun.sleep(100);

    // The purge only needs the agent gone; it must finish while the lock is still held.
    const purge = w.service.purgeItem("issue");
    const outcome = await Promise.race([purge.then(() => "purged"), Bun.sleep(3000).then(() => "stalled")]);
    open();
    await sync;
    await purge;
    expect(outcome).toBe("purged");
  }, 15_000);

  test("the event log keeps the item's events after the purge", async () => {
    const { w } = await runningItem();
    const before = w.store.events().read({ issueId: "issue" }).length;
    expect(before).toBeGreaterThan(0);

    w.editLabelsOnGitHub(() => []);
    await w.deliverIssueEvent("unlabeled", "unlabel-1");
    await w.service.purgesSettled();

    const after = w.store.events().read({ issueId: "issue" });
    expect(after.length).toBeGreaterThanOrEqual(before);
    expect(after.map((event) => event.type)).toEqual(expect.arrayContaining(["item.discovered", "item.purged"]));
  });

  test("a closed item without a merge stops its run before closed-item recovery makes any GitHub call", async () => {
    const calls: Array<{ method: string; agentAlive: boolean }> = [];
    let pid = 0;
    const { w, pid: agentPid } = await runningItem({
      onGithubCall: (method) => { calls.push({ method, agentAlive: pid !== 0 && alive(pid) }); },
    });
    pid = agentPid;
    calls.length = 0;

    await w.closeIssueOnGitHub();
    await w.service.purgesSettled();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.agentAlive)).toEqual([]);
    expect(alive(pid)).toBe(false);
    // Closed without a merge: Conveyor removed its labels, then purged the item.
    expect(w.sourceLabels()).toEqual([]);
    expect(w.store.getIssue("issue")).toBeNull();
  });

  test("a purge interrupted by a restart finishes after it without repeating the workspace removal or a GitHub write", async () => {
    const { w, workspacePath } = await runningItem();
    // The service stops mid-purge: the item is queued for purging, its agent is gone, nothing else happened.
    w.store.beginPurge("issue");
    expect(w.store.listPendingPurges()).toEqual([{ issueId: "issue", repositoryId: "conveyor" }]);
    expect(existsSync(workspacePath)).toBe(true);
    const writesBefore = w.labelWrites.length;
    const removals = () => w.store.events().read({ type: "workspace.removed" }).length;

    await w.service.tick();
    await w.service.purgesSettled();
    expect(existsSync(workspacePath)).toBe(false);
    expect(w.store.getIssue("issue")).toBeNull();
    expect(removals()).toBe(1);

    // A second pass after the finish repeats nothing.
    await w.service.tick();
    await w.service.purgesSettled();
    expect(removals()).toBe(1);
    expect(w.labelWrites.length).toBe(writesBefore);
  });

  test("a closed item whose purge stopped after the GitHub write finishes later without writing again or removing twice", async () => {
    let interrupt: (() => void) | null = null;
    const { w, workspacePath } = await runningItem({
      onGithubCall: (method) => { if (method === "replaceConveyorLabels") interrupt?.(); },
    });
    // The service is held up right after the label write succeeded: the repository pause stops the cleanup there.
    interrupt = () => w.store.pauseRepository("conveyor", "operator", "interrupt the purge");
    const writesBefore = w.labelWrites.length;
    await w.closeIssueOnGitHub();
    await w.service.purgesSettled();
    expect(w.labelWrites.slice(writesBefore)).toEqual([[]]);
    expect(w.store.listPendingPurges()).toEqual([{ issueId: "issue", repositoryId: "conveyor" }]);
    expect(existsSync(workspacePath)).toBe(true);

    interrupt = null;
    w.store.resumeRepository("conveyor");
    await w.service.tick();
    await w.service.purgesSettled();
    await w.service.tick();
    await w.service.purgesSettled();

    expect(existsSync(workspacePath)).toBe(false);
    expect(w.store.getIssue("issue")).toBeNull();
    expect(w.labelWrites.slice(writesBefore)).toEqual([[]]);
    expect(w.store.events().read({ type: "workspace.removed" })).toHaveLength(1);
  });

  test("a board without the purged item shows no trace of it and no missing or offboarded state exists", async () => {
    const { w } = await runningItem();
    w.editLabelsOnGitHub(() => []);
    await w.deliverIssueEvent("unlabeled", "unlabel-1");
    await w.service.purgesSettled();

    expect(JSON.stringify(w.service.dashboard("csrf"))).not.toContain("Add the feature");
    expect(w.store.listIssues("conveyor").map((issue) => issue.id)).not.toContain("issue");
    const states = (w.store.sqlite().query("SELECT DISTINCT projected_state AS state FROM issues").all() as Array<{ state: string | null }>).map((row) => row.state);
    expect(states).not.toContain("missing");
    expect(states).not.toContain("offboarded");
  });

  test("adding the conveyor label back to a purged issue onboards it as a new item", async () => {
    const { w } = await runningItem();
    w.editLabelsOnGitHub(() => []);
    await w.deliverIssueEvent("unlabeled", "unlabel-1");
    await w.service.purgesSettled();
    expect(w.store.getIssue("issue")).toBeNull();

    w.editLabelsOnGitHub(() => ["conveyor"]);
    await w.deliverIssueEvent("labeled", "label-1");

    const onboarded = w.store.getIssueByNumber("conveyor", 1);
    expect(onboarded).not.toBeNull();
    expect(onboarded!.projectedState).not.toBe("unlisted");
    // The purged item's generation is not reused: its workspace and branch names would collide with
    // work left on the remote.
    expect(w.store.listStageTransitions(onboarded!.id).map((transition) => transition.kind)).not.toContain("offboarded");
  });

  test("the purge removes the artifact directories of the item's runs with their records", async () => {
    const { w } = await runningItem();
    const runId = "run-with-artifacts";
    const directory = path.join(w.config.settings.artifacts, runId);
    mkdirSync(path.join(directory, "home"), { recursive: true });
    writeFileSync(path.join(directory, "home", "note"), "x");
    chmodSync(path.join(directory, "home"), 0o500);
    w.store.sqlite().query(
      "INSERT INTO runs(id, issue_id, stage_id, attempt, kind, status, config_hash, started_at, finished_at) VALUES (?, 'issue', 'deploy', 1, 'stage', 'succeeded', 'h', ?, ?)",
    ).run(runId, "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z");

    w.editLabelsOnGitHub(() => []);
    await w.deliverIssueEvent("unlabeled", "unlabel-1");
    await w.service.purgesSettled();

    expect(existsSync(directory)).toBe(false);
    expect(w.store.getRun(runId)).toBeNull();
  });
});

describe("purging an item whose GitHub issue was deleted or transferred", () => {
  for (const action of ["deleted", "transferred"]) {
    test(`an issues.${action} delivery kills the running agent before any GitHub request and purges the item without a sync`, async () => {
      const calls: Array<{ method: string; agentAlive: boolean }> = [];
      let pid = 0;
      const { w, pid: agentPid, workspacePath } = await runningItem({
        onGithubCall: (method) => { calls.push({ method, agentAlive: pid !== 0 && alive(pid) }); },
      });
      pid = agentPid;
      expect(alive(pid)).toBe(true);
      calls.length = 0;

      await w.deliverIssueEvent(action, `${action}-1`);
      await w.service.purgesSettled();

      expect(alive(pid)).toBe(false);
      expect(calls.filter((call) => call.agentAlive)).toEqual([]);
      // No listing and no read of the issue: the delivery alone is the proof.
      expect(calls.map((call) => call.method).filter((method) => method === "listIssues" || method === "getIssue")).toEqual([]);
      expect(existsSync(workspacePath)).toBe(false);
      expect(w.store.getIssue("issue")).toBeNull();
      expect(Object.entries(rowsOf(w, "issue")).filter(([, count]) => count > 0)).toEqual([]);
    });
  }
});
