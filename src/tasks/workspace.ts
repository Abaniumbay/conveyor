// The `workspace` task group. `workspace.load` reads the stored workspace and LOCAL git
// refs only: the remote head is `origin/<branch>` as last fetched or pushed, never a network
// call. `workspace.push` (and an agent's own `git push`) updates that remote-tracking ref, so
// the next load sees the pushed head.

import { existsSync } from "node:fs";

import { z } from "zod";

import type { WorkspaceContext } from "./context";
import { defineGroup, fail, pass, type TaskArgs, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";
import { ToolRequestError } from "./errors";
import { GitPushRejectedError } from "../workspace/git";
import { ensureWorkspace, removeWorkspace } from "../workspace/lifecycle";

type Deps = TaskDeps;
type Args<I = unknown> = TaskArgs<unknown, I, Deps>;

const emptyInput = z.object({});
export const pushInput = z.object({
  forceWithLease: z.boolean().optional(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i, "headSha must be a full Git commit SHA").optional(),
}).superRefine(({ forceWithLease, headSha }, ctx) => {
  if (forceWithLease === true && headSha === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headSha"], message: "headSha is required with forceWithLease" });
  }
  if (forceWithLease !== true && headSha !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headSha"], message: "headSha is only used with forceWithLease" });
  }
});

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
    await ensureWorkspace({ store: deps.store, manager: deps.workspaces, issueId: deps.issueId, repository: deps.repository });
    return pass();
  },
};

const cleanup: TaskDefinition<unknown, unknown, Deps> = {
  name: "workspace.cleanup",
  kind: "act",
  description: "Removes the worktree and deletes the local branch and its remote-tracking ref, then marks the workspace removed; also deletes the remote branch when it is still there and no open change uses it (best effort). A missing workspace is already done.",
  reads: ["repository"],
  writes: [],
  invalidates: ["workspace"],
  async run({ deps }: Args) {
    const branch = deps.store.getActiveWorkspace(deps.issueId)?.branch ?? null;
    await removeWorkspace({
      store: deps.store, manager: deps.workspaces, issueId: deps.issueId, repositoryFolder: deps.repository.folder,
    });
    if (!branch || !deps.codeHost) return pass();
    try {
      const remote = await deps.codeHost.deleteBranch({ address: deps.repository.address, branch });
      return pass({ branch, remote });
    } catch (error) {
      // The local cleanup is done; a host that cannot delete the branch now leaves it for the owner.
      return pass({ branch, remote: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
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

// Git push and fetch are already safe to repeat, and an agent pushes again after every fix in the
// same run. Journaling them by run and input would replay the first call's `accepted` and silently
// skip each later push, so they opt out and every call reaches git.
const unjournaled = <I>(definition: TaskDefinition<unknown, I, Deps>): TaskDefinition<unknown, I, Deps> =>
  ({ ...definition, journal: false });

const get = tool("workspace.get", "Read scoped workspace metadata (path and branch).", emptyInput, false,
  async (_args, workspace) => ({ path: workspace.path, branch: workspace.branch }));

const fetch = unjournaled(tool("workspace.fetch", "Fetch the repository base branch and scoped workspace branch from origin into the workspace. `branchOnRemote` is false while the workspace branch has not been pushed yet; that is not an error.", emptyInput, true,
  async ({ deps }, workspace) => {
    try {
      if (!(await deps.git.fetch(workspace.path, "origin", deps.repository.baseBranch))) {
        throw new ToolRequestError(`The base branch ${deps.repository.baseBranch} does not exist on origin.`);
      }
      const branchOnRemote = await deps.git.fetch(workspace.path, "origin", workspace.branch);
      return { accepted: true, branchOnRemote };
    } catch (error) {
      // The agent needs git's reason to recover; an unexplained failure reads as a broken workspace.
      if (error instanceof ToolRequestError) throw error;
      throw new ToolRequestError(error instanceof Error ? error.message : String(error));
    }
  }));

const push = unjournaled(tool("workspace.push", "Push the workspace branch to origin. For a lease push with a change request, read change.get and use its headSha. Before a change request exists, use workspace.fetch, then run git -C <workspace-path> rev-parse refs/remotes/origin/<branch> for the feature branch head; rebase that full SHA into HEAD and use it as headSha. If the branch moved, fetch, rebase, and retry; if it does not exist, push without forceWithLease to create it.", pushInput, true,
  async ({ deps, input }, workspace) => {
    if (input!.forceWithLease !== true) {
      await deps.git.push(workspace.path, workspace.branch, { forceWithLease: false });
      return { accepted: true };
    }
    const expectedRemoteHead = input!.headSha!;
    const remoteHead = await deps.git.remoteBranchHead(workspace.path, workspace.branch);
    if (remoteHead === null) {
      throw new ToolRequestError(`The remote branch ${workspace.branch} does not exist; push without forceWithLease to create it.`);
    }
    if (remoteHead !== expectedRemoteHead) {
      throw new ToolRequestError(`The remote branch moved to ${remoteHead}; use workspace.fetch, rebase, and retry.`);
    }
    if (!await deps.git.isAncestor(workspace.path, expectedRemoteHead, "HEAD")) {
      throw new ToolRequestError(`The workspace has not reconciled observed remote head ${expectedRemoteHead}; use workspace.fetch and rebase before pushing.`);
    }
    try {
      await deps.git.push(workspace.path, workspace.branch, { forceWithLease: true, expectedRemoteHead });
    } catch (error) {
      if (error instanceof GitPushRejectedError) throw new ToolRequestError(error.message);
      throw error;
    }
    return { accepted: true };
  }, ["workspace"]));

export const workspaceGroup = defineGroup("workspace", [load, ensure, pushed, cleanup, removed, get, fetch, push]);
