import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { CriterionApprovals } from "../../src/engine/review-records";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function open() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-approvals-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  store.upsertIssue({
    id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "u", title: "t", body: "", sourceState: "open",
    labels: [], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  return { store, approvals: new CriterionApprovals(store.sqlite()) };
}

describe("CriterionApprovals", () => {
  test("records one approval per criterion; a later head replaces it", async () => {
    const { approvals } = await open();
    approvals.approve({ issueId: "i1", criterionId: "a", reviewer: "r1", headSha: "h1", checkedAt: "t1" });
    approvals.approve({ issueId: "i1", criterionId: "a", reviewer: "r2", headSha: "h2", checkedAt: "t2" });
    expect(approvals.list("i1")).toEqual([{ criterionId: "a", reviewer: "r2", headSha: "h2", checkedAt: "t2" }]);
  });

  test("withdraw removes an approval and ignores a missing one", async () => {
    const { approvals } = await open();
    approvals.approve({ issueId: "i1", criterionId: "a", reviewer: "r1", headSha: "h1", checkedAt: "t1" });
    approvals.withdraw("i1", "a");
    approvals.withdraw("i1", "a");
    expect(approvals.list("i1")).toEqual([]);
  });

  test("approvals are removed with their issue", async () => {
    const { store, approvals } = await open();
    approvals.approve({ issueId: "i1", criterionId: "a", reviewer: "r1", headSha: "h1", checkedAt: "t1" });
    store.sqlite().query("DELETE FROM issues WHERE id = 'i1'").run();
    expect(approvals.list("i1")).toEqual([]);
  });
});
