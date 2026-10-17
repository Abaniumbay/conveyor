import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { ManualGateApprovals } from "../../src/engine/manual-gates";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-manual-gates-"));
  directories.push(directory);
  const store = await ConveyorStore.open(path.join(directory, "conveyor.sqlite"));
  store.recordConfigSnapshot("hash", {});
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: directory, configHash: "hash" });
  store.upsertIssue({
    id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.test/1", title: "Feature", body: "",
    sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
  return { store, approvals: new ManualGateApprovals(store.sqlite()) };
}

test("persists stage board requirements and keeps their approvals distinct from configured gates", async () => {
  const { store, approvals } = await setup();
  approvals.setBoardApprovalRequirement({ issueId: "issue", stageId: "review", required: true, changedAt: "2026-01-01T00:00:00.000Z" });

  expect(approvals.hasBoardApprovalRequirement("issue", "review")).toBe(true);
  approvals.setBoardApprovalRequirement({ issueId: "issue", stageId: "review", required: true, changedAt: "2026-01-01T00:00:30.000Z" });
  expect(approvals.listBoardApprovalRequirements("issue")).toEqual([
    { issueId: "issue", stageId: "review", changedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  expect(approvals.approveBoard({
    issueId: "issue", stageId: "review", stageEpoch: 4, attempt: 1,
    accountId: "account-1", accountName: "operator", approvedAt: "2026-01-01T00:01:00.000Z",
  })).toBe(true);
  expect(approvals.approveBoard({
    issueId: "issue", stageId: "review", stageEpoch: 4, attempt: 1,
    accountId: "account-2", accountName: "another", approvedAt: "2026-01-01T00:02:00.000Z",
  })).toBe(false);
  expect(approvals.getBoardApproval("issue", "review", 4, 1)).toMatchObject({ accountId: "account-1", accountName: "operator" });
  expect(approvals.getBoardApproval("issue", "review", 4, 2)).toBeNull();
  expect(approvals.getBoardApproval("issue", "review", 5, 1)).toBeNull();

  approvals.setBoardApprovalRequirement({ issueId: "issue", stageId: "review", required: false, changedAt: "2026-01-01T00:03:00.000Z" });
  expect(approvals.hasBoardApprovalRequirement("issue", "review")).toBe(false);
  // The receipt remains auditable and a configured manual-gate receipt remains separate.
  expect(approvals.getBoardApproval("issue", "review", 4, 1)).toMatchObject({ approvedAt: "2026-01-01T00:01:00.000Z" });
  store.close();
});
