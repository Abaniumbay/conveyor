import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LiveIssueStatus } from "../../src/app/dashboard-sources";
import { StatusCommentWriter } from "../../src/app/status-comments";
import { ConveyorStore } from "../../src/db/store";

const directories: string[] = [];
const stores: ConveyorStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Upsert { address: string; issueNumber: number; markdown: string; knownCommentId: number | undefined }

async function writer(options: { labels?: string[]; upsert?: (call: Upsert) => Promise<number>; status?: LiveIssueStatus | null; stopReason?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-status-comments-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  stores.push(store);
  store.upsertRepository({ id: "app", configName: "app", source: "github", address: "owner/app", folder: root, configHash: "h" });
  const issue = (title: string) => store.upsertIssue({
    id: "issue", repositoryId: "app", sourceNumber: 1, sourceUrl: "https://example.com/1", title, body: "",
    sourceState: "open", labels: options.labels ?? ["conveyor", "conveyor:build"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  issue("Add search");
  store.setIssueProjection("issue", { stage: "build", state: "active", warning: null });
  const upserts: Upsert[] = [];
  const refreshed: string[] = [];
  const comments = new StatusCommentWriter({
    config: { labels: { enrollment: "conveyor" }, repositories: { app: { source: "github", address: "owner/app" } } },
    store,
    source: () => ({
      async upsertStatusComment(address, issueNumber, markdown, knownCommentId) {
        const call = { address, issueNumber, markdown, knownCommentId };
        upserts.push(call);
        return options.upsert ? options.upsert(call) : 42;
      },
    }),
    refreshChangeHead: async (stored) => { refreshed.push(stored.id); },
    criteria: () => [{ text: "Search finds issues by title", approved: true }],
    status: () => options.status ?? null,
    stopReason: () => options.stopReason ?? null,
  });
  return { comments, store, upserts, refreshed, retitle: issue };
}

describe("status comments", () => {
  test("an enrolled item's comment shows its stage, state and criteria, read after the live change head", async () => {
    const { comments, upserts, refreshed } = await writer();
    await comments.update("issue");
    expect(refreshed).toEqual(["issue"]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.address).toBe("owner/app");
    expect(upserts[0]!.issueNumber).toBe(1);
    expect(upserts[0]!.knownCommentId).toBeUndefined();
    expect(upserts[0]!.markdown).toContain("build");
    expect(upserts[0]!.markdown).toContain("Search finds issues by title");
  });

  test("unchanged content is not written again", async () => {
    const { comments, upserts } = await writer();
    await comments.update("issue");
    await comments.update("issue");
    expect(upserts).toHaveLength(1);
  });

  test("changed content goes straight to the comment written last time", async () => {
    const { comments, upserts, retitle } = await writer();
    await comments.update("issue");
    retitle("Add full-text search");
    await comments.update("issue");
    expect(upserts).toHaveLength(2);
    expect(upserts[1]!.knownCommentId).toBe(42);
  });

  test("an item without Conveyor's label gets no comment", async () => {
    const { comments, upserts } = await writer({ labels: ["bug"] });
    await comments.update("issue");
    expect(upserts).toEqual([]);
  });

  test("a paused repository gets no comment", async () => {
    const { comments, store, upserts } = await writer();
    store.pauseRepository("app", "owner", null);
    await comments.update("issue");
    expect(upserts).toEqual([]);
  });

  test("a waiting item shows why it waits", async () => {
    const { comments, upserts } = await writer({ status: { kind: "waiting", reason: "Waiting for CI", since: "2026-01-01T00:00:00Z", nextCheckAt: null, deadline: null } });
    await comments.update("issue");
    expect(upserts[0]!.markdown).toContain("Waiting · Waiting for CI");
  });

  test("a stopped item shows its recorded stop reason", async () => {
    const { comments, store, upserts } = await writer({ stopReason: "The review found a blocking problem." });
    store.setIssueProjection("issue", { stage: "build", state: "blocked", warning: null });
    await comments.update("issue");
    expect(upserts[0]!.markdown).toContain("The review found a blocking problem.");
  });

  test("writes for one item run one after another, and a failed write is recorded and retried", async () => {
    let release: () => void = () => {};
    const first = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const { comments, store, upserts, retitle } = await writer({
      upsert: async () => {
        calls += 1;
        if (calls === 1) { await first; throw new Error("GitHub is unavailable"); }
        return 42;
      },
    });
    const failing = comments.update("issue");
    retitle("Add full-text search");
    const next = comments.update("issue");
    while (upserts.length === 0) await Bun.sleep(1);
    await Bun.sleep(1);
    expect(upserts).toHaveLength(1);
    expect(comments.busy).toBe(true);
    release();
    await expect(failing).rejects.toThrow("GitHub is unavailable");
    await next;
    expect(upserts).toHaveLength(2);
    expect(comments.busy).toBe(false);
    expect(store.getLatestSourceMutationByKeyPrefix("status:issue:")?.status).toBe("succeeded");
  });
});
