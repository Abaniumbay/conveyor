// Creating and removing an issue's workspace. One implementation shared by the legacy
// executor pre-creation, the `workspace.*` tasks and the `workspace.cleanup` source action.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import type { ConveyorStore, StoredIssue, StoredWorkspace } from "../db/store";
import type { WorkspaceManager } from "./manager";

export type WorkspaceLifecycleManager = Pick<WorkspaceManager, "create" | "remove" | "restore">;

export interface WorkspaceRepository {
  id: string;
  folder: string;
  baseBranch: string;
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "issue";
}

/** Creates the workspace for the issue's active enrollment and records it. */
export async function createWorkspace(input: {
  store: ConveyorStore;
  manager: Pick<WorkspaceManager, "create">;
  issue: Pick<StoredIssue, "id" | "sourceNumber" | "title">;
  repository: WorkspaceRepository;
}): Promise<StoredWorkspace> {
  const { store, manager, issue, repository } = input;
  const enrollment = store.activateEnrollment(issue.id);
  const created = await manager.create({
    repositoryPath: repository.folder,
    repositoryId: repository.id,
    issueNumber: issue.sourceNumber,
    enrollment: enrollment.generation,
    slug: slug(issue.title),
    baseBranch: repository.baseBranch,
  });
  store.recordWorkspace({
    id: randomUUID(),
    enrollmentId: enrollment.id,
    path: created.path,
    branch: created.branch,
    status: "active",
  });
  const workspace = store.getActiveWorkspace(issue.id);
  if (!workspace) throw new Error(`workspace for issue ${issue.id} was not recorded`);
  return workspace;
}

/** The item's active workspace: created when none is recorded, re-attached to its branch when the directory went missing. */
export async function ensureWorkspace(input: {
  store: ConveyorStore;
  manager: Pick<WorkspaceManager, "create" | "restore">;
  issueId: string;
  repository: WorkspaceRepository;
}): Promise<StoredWorkspace> {
  const { store, manager, issueId, repository } = input;
  const existing = store.getActiveWorkspace(issueId);
  if (existing) {
    if (!existsSync(existing.path)) {
      // The directory is gone: re-attach it to the recorded branch (which keeps any unpushed commits).
      await manager.restore({
        repositoryPath: repository.folder,
        workspacePath: existing.path,
        branch: existing.branch,
        baseBranch: repository.baseBranch,
      });
    }
    return existing;
  }
  const issue = store.getIssue(issueId);
  if (!issue) throw new Error(`issue ${issueId} is not stored`);
  return createWorkspace({ store, manager, issue, repository });
}

/** Removes the worktree and its local branch and marks the record removed. Missing workspace is done. */
export async function removeWorkspace(input: {
  store: ConveyorStore;
  manager: Pick<WorkspaceManager, "remove">;
  issueId: string;
  repositoryFolder: string;
}): Promise<boolean> {
  const { store, manager, issueId, repositoryFolder } = input;
  const stored = store.getActiveWorkspace(issueId);
  if (!stored) return false;
  await manager.remove({
    repositoryPath: repositoryFolder,
    workspacePath: stored.path,
    branch: stored.branch,
    deleteBranch: true,
  });
  store.markWorkspaceRemoved(stored.id);
  return true;
}
