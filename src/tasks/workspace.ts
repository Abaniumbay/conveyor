// The `workspace` task group. `workspace.load` reads the stored workspace and LOCAL git
// refs only: the remote head is `origin/<branch>` as last fetched or pushed, never a network
// call. `workspace.push` (and an agent's own `git push`) updates that remote-tracking ref, so
// the next load sees the pushed head.

import { existsSync } from "node:fs";

import { z } from "zod";

import type { WorkspaceContext } from "./context";
import { defineGroup, fail, pass, type TaskArgs, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";
import { createWorkspace, removeWorkspace } from "../workspace/lifecycle";

type Deps = TaskDeps;
type Args<I = unknown> = TaskArgs<unknown, I, Deps>;

const emptyInput = z.object({});
export const pushInput = z.object({ forceWithLease: z.boolean().optional() });

const load: TaskDefinition<unknown, unknown, Deps> = {
  name: "workspace.load",
  kind: "load",
  description: "Loads the stored workspace with local git facts: clean, ahead/behind and head SHAs against origin/<branch> as last fetched or pushed (no network).",
  reads: [],
  writes: ["workspace"],
  invalidates: [],
  async run({ deps }: Args) {
    const stored = deps.store.getActiveWorkspace(deps.issueId);
    const absent: WorkspaceContext = {
      path: stored?.path ?? null, branch: stored?.branch ?? null, exists: false,
      clean: true, ahead: 0, behind: 0, remoteHeadSha: null, localHeadSha: null,
    };
    if (!stored || !existsSync(stored.path)) return pass(absent);
    const { git } = deps;
    const [status, localHeadSha, remoteHeadSha, counts] = await Promise.all([
      git.status(stored.path),
      git.revParse(stored.path, "HEAD"),
      git.revParse(stored.path, `refs/remotes/origin/${stored.branch}`),
      git.aheadBehind(stored.path, stored.branch),
    ]);
    const workspace: WorkspaceContext = {
      ...absent, exists: true, clean: status.clean, ahead: counts?.ahead ?? 0, behind: counts?.behind ?? 0,
      localHeadSha, remoteHeadSha,
    };
    return pass(workspace);
  },
};

const pushed: TaskDefinition<unknown, unknown, Deps> = {
  name: "workspace.pushed",
  kind: "check",
  description: "Passes when the workspace is clean, not ahead of origin/<branch>, and its head equals the remote head; the failure names the condition that failed.",
  reads: ["workspace"],
  writes: [],
  invalidates: [],
  run({ context }) {
    const w = context.workspace!;
    if (!w.exists) return fail("No workspace exists");
    if (!w.clean) return fail("Workspace has uncommitted changes");
    if (w.remoteHeadSha === null) return fail(`Branch ${w.branch} has not been pushed to origin`);
    if (w.ahead > 0) return fail(`Branch ${w.branch} is ${w.ahead} commit(s) ahead of origin`);
    if (w.localHeadSha !== w.remoteHeadSha) {
      return fail(`Local head ${w.localHeadSha} differs from origin/${w.branch} at ${w.remoteHeadSha}`);
    }
    return pass();
  },
};

const removed: TaskDefinition<unknown, unknown, Deps> = {
  name: "workspace.removed",
  kind: "check",
  description: "Passes when no workspace exists.",
  reads: ["workspace"],
  writes: [],
  invalidates: [],
  run({ context }) {
    const w = context.workspace!;
    return w.exists ? fail(`Workspace ${w.path} still exists`) : pass();
  },
};

const ensure: TaskDefinition<unknown, unknown, Deps> = {
  name: "workspace.ensure",
  kind: "act",
  description: "Creates the issue's workspace (worktree and branch) when none is recorded; re-attaches the recorded path to its existing branch when the directory went missing; otherwise does nothing.",
  reads: ["repository"],
  writes: [],
  invalidates: ["workspace"],
  async run({ deps }: Args) {
    const existing = deps.store.getActiveWorkspace(deps.issueId);
    if (existing) {
      if (!existsSync(existing.path)) {
        // The directory is gone: re-attach it to the recorded branch (which keeps any unpushed commits).
        await deps.workspaces.restore({
          repositoryPath: deps.repository.folder,
          workspacePath: existing.path,
          branch: existing.branch,
          baseBranch: deps.repository.baseBranch,
        });
      }
      return pass();
    }
    const issue = deps.store.getIssue(deps.issueId);
    if (!issue) throw new Error(`issue ${deps.issueId} is not stored`);
    await createWorkspace({ store: deps.store, manager: deps.workspaces, issue, repository: deps.repository });
    return pass();
  },
};

const cleanup: TaskDefinition<unknown, unknown, Deps> = {
  name: "workspace.cleanup",
  kind: "act",
  description: "Removes the worktree and deletes the local branch, then marks the workspace removed. A missing workspace is already done.",
  reads: ["repository"],
  writes: [],
  invalidates: ["workspace"],
  async run({ deps }: Args) {
    await removeWorkspace({
      store: deps.store, manager: deps.workspaces, issueId: deps.issueId, repositoryFolder: deps.repository.folder,
    });
    return pass();
  },
};

const tool = <I>(
  name: string,
  description: string,
  input: z.ZodType<I>,
  mutating: boolean,
  run: (args: Args<I>, workspace: { path: string; branch: string }) => Promise<unknown>,
  invalidates: TaskDefinition["invalidates"] = [],
): TaskDefinition<unknown, I, Deps> => ({
  name, kind: "tool", description, reads: [], writes: [], invalidates, input,
  ...(mutating ? { mutating: true } : {}),
  async run(args) {
    const stored = args.deps.store.getActiveWorkspace(args.deps.issueId);
    if (!stored) return fail("run has no workspace");
    return pass(await run(args, stored));
  },
});

const get = tool("workspace.get", "Read scoped workspace metadata (path and branch).", emptyInput, false,
  async (_args, workspace) => ({ path: workspace.path, branch: workspace.branch }));

const fetch = tool("workspace.fetch", "Fetch the repository base branch from origin into the workspace.", emptyInput, true,
  async ({ deps }, workspace) => {
    await deps.git.fetch(workspace.path, "origin", deps.repository.baseBranch);
    return { accepted: true };
  });

const push = tool("workspace.push", "Push the workspace branch to origin, optionally with --force-with-lease.", pushInput, true,
  async ({ deps, input }, workspace) => {
    await deps.git.push(workspace.path, workspace.branch, { forceWithLease: input!.forceWithLease === true });
    return { accepted: true };
  }, ["workspace"]);

export const workspaceGroup = defineGroup("workspace", [load, ensure, pushed, cleanup, removed, get, fetch, push]);
