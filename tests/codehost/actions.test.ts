import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { changeAction, linkExistingChange, recoverClosedChange } from "../../src/codehost/actions";
import { ConveyorStore } from "../../src/db/store";
import type { ChangeRequest, CodeHost } from "../../src/codehost/types";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const change = (over: Partial<ChangeRequest>): ChangeRequest => ({
  id: "github:owner/repository#pr-17", number: 17, url: "https://example.com/pr/17",
  state: "open", headSha: "a".repeat(40), draft: false, mergeable: null, ...over,
});

async function recoveryWorld() {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-change-recovery-"));
  directories.push(directory);
  const store = await ConveyorStore.open(path.join(directory, "db.sqlite"));
  store.upsertRepository({ id: "repository", configName: "repository", source: "github", address: "owner/repository", folder: "/workspace", configHash: "h" });
  store.upsertIssue({
    id: "issue-1", repositoryId: "repository", sourceNumber: 17, sourceUrl: "https://example.com/issues/17", title: "Recover a change",
    body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
  const enrollment = store.activateEnrollment("issue-1");
  store.recordWorkspace({ id: "workspace-1", enrollmentId: enrollment.id, path: "/workspace", branch: "conveyor/17-r1-recover", status: "active" });
  store.createRun({ id: "run-1", issueId: "issue-1", stageId: "implementation", attempt: 1, kind: "agent", status: "running", configHash: "h", startedAt: "2026-01-01T00:00:00.000Z" });
  return { store, enrollment };
}

describe("change stage action aliases", () => {
  test("maps ensure names to the same operation", () => {
    expect(changeAction("change.ensure")).toBe("ensure");
    expect(changeAction("pullRequest.ensure")).toBe(changeAction("change.ensure"));
  });

  test("maps squash merge names to the same operation", () => {
    expect(changeAction("change.merge")).toBe("merge");
    expect(changeAction("pullRequest.squashMerge")).toBe(changeAction("change.merge"));
  });

  test("leaves unrelated actions available to their own handlers", () => {
    expect(changeAction("pullRequest.awaitChecks")).toBeNull();
  });
});

describe("linkExistingChange", () => {
  test("records an already-open branch change without creating another", async () => {
    const calls: unknown[] = [];
    const stored: unknown[] = [];
    const linked = await linkExistingChange({
      codeHost: {
        async findOpenChange(input) {
          calls.push(input);
          return { id: "github:owner/repository#pr-17", number: 17, url: "https://example.test/pr/17", state: "open", headSha: "a".repeat(40), draft: false, mergeable: null };
        },
      },
      store: {
        getCurrentPullRequest: () => null,
        upsertPullRequest: (input) => { stored.push(input); },
      },
      address: "owner/repository", issueId: "issue-1", branch: "conveyor/17-r1-existing",
    });

    expect(calls).toEqual([{ address: "owner/repository", branch: "conveyor/17-r1-existing" }]);
    expect(stored).toEqual([{ issueId: "issue-1", id: "github:owner/repository#pr-17", number: 17, url: "https://example.test/pr/17", state: "open" }]);
    expect(linked?.headSha).toBe("a".repeat(40));
  });

  test("leaves an existing change record untouched on retries", async () => {
    let lookups = 0;
    const linked = await linkExistingChange({
      codeHost: { async findOpenChange() { lookups += 1; return null; } },
      store: {
        getCurrentPullRequest: () => ({}) as never,
        upsertPullRequest: () => { throw new Error("must not replace the record"); },
      },
      address: "owner/repository", issueId: "issue-1", branch: "conveyor/17-r1-existing",
    });

    expect(linked).toBeNull();
    expect(lookups).toBe(0);
  });
});

describe("recoverClosedChange", () => {
  test("replaces a closed unmerged current change with the branch's open change while retaining item history", async () => {
    const w = await recoveryWorld();
    const closed = change({ id: "github:owner/repository#pr-3", number: 3, state: "closed", headSha: "old".repeat(13) + "o" });
    const open = change({ id: "github:owner/repository#pr-19", number: 19, headSha: "new".repeat(13) + "n" });
    w.store.upsertPullRequest({ issueId: "issue-1", id: closed.id, number: closed.number, url: closed.url, state: closed.state });
    const calls: string[] = [];
    const codeHost: Pick<CodeHost, "getChange" | "findOpenChange" | "ensureChange"> = {
      async getChange(input) { calls.push(`get:${input.id}`); return closed; },
      async findOpenChange() { calls.push("find-open"); return open; },
      async ensureChange() { throw new Error("must reuse the open change"); },
    };

    const recovered = await recoverClosedChange({
      codeHost, store: w.store, source: "github", address: "owner/repository",
      issue: { id: "issue-1", sourceNumber: 17, title: "Recover a change" },
      workspace: { branch: "conveyor/17-r1-recover" }, base: "main", closes: true,
    });

    expect(recovered).toMatchObject({ id: open.id, state: "open", headSha: open.headSha });
    expect(w.store.getCurrentPullRequest("issue-1")).toMatchObject({ id: open.id, state: "open" });
    expect(w.store.getActiveEnrollment("issue-1")?.id).toBe(w.enrollment.id);
    expect(w.store.getActiveWorkspace("issue-1")).toMatchObject({ id: "workspace-1", branch: "conveyor/17-r1-recover" });
    expect(w.store.getRun("run-1")).toMatchObject({ issueId: "issue-1", status: "running" });
    expect(calls).toEqual([`get:${closed.id}`, "find-open"]);
  });

  test("creates one replacement for a closed unmerged current change and reuses it on retry", async () => {
    const w = await recoveryWorld();
    const closed = change({ id: "github:owner/repository#pr-3", number: 3, state: "closed" });
    const replacement = change({ id: "github:owner/repository#pr-20", number: 20, headSha: "b".repeat(40) });
    w.store.upsertPullRequest({ issueId: "issue-1", id: closed.id, number: closed.number, url: closed.url, state: closed.state });
    let ensured = 0;
    const codeHost: Pick<CodeHost, "getChange" | "findOpenChange" | "ensureChange"> = {
      async getChange(input) { return input.id === closed.id ? closed : replacement; },
      async findOpenChange() { return null; },
      async ensureChange() { ensured += 1; return replacement; },
    };
    const input = {
      codeHost, store: w.store, source: "github", address: "owner/repository",
      issue: { id: "issue-1", sourceNumber: 17, title: "Recover a change" },
      workspace: { branch: "conveyor/17-r1-recover" }, base: "main", closes: true,
    };

    expect((await recoverClosedChange(input))?.id).toBe(replacement.id);
    expect((await recoverClosedChange(input))?.id).toBe(replacement.id);
    expect(w.store.getCurrentPullRequest("issue-1")).toMatchObject({ id: replacement.id, state: "open" });
    expect(ensured).toBe(1);
  });

  test("keeps a merged current change for post-merge work", async () => {
    const w = await recoveryWorld();
    const merged = change({ state: "merged", mergedAt: "2026-01-01T00:00:00.000Z" });
    w.store.upsertPullRequest({
      issueId: "issue-1", id: merged.id, number: merged.number, url: merged.url, state: merged.state,
      ...(merged.mergedAt === undefined ? {} : { mergedAt: merged.mergedAt }),
    });
    const codeHost: Pick<CodeHost, "getChange" | "findOpenChange" | "ensureChange"> = {
      async getChange() { return merged; },
      async findOpenChange() { throw new Error("must not search for a replacement"); },
      async ensureChange() { throw new Error("must not create a replacement"); },
    };

    const retained = await recoverClosedChange({
      codeHost, store: w.store, source: "github", address: "owner/repository",
      issue: { id: "issue-1", sourceNumber: 17, title: "Recover a change" },
      workspace: { branch: "conveyor/17-r1-recover" }, base: "main", closes: true,
    });

    expect(retained).toMatchObject({ id: merged.id, state: "merged", mergedAt: merged.mergedAt });
    expect(w.store.getCurrentPullRequest("issue-1")).toMatchObject({ id: merged.id, state: "merged", mergedAt: merged.mergedAt });
  });
});
