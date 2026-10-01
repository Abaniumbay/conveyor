// The `change` task group: the code host's change request (a pull request on GitHub).
// `change.load` reads the stored change live. `change.merge` squashes only the head that
// review (and, when CI is required, CI) passed: the code host refuses if the head moved.

import { z } from "zod";

import { pushAndEnsureChange } from "../codehost/actions";
import type { ChangeDelivery, CodeHost } from "../codehost/types";
import type { ChangeContext } from "./context";
import { defineGroup, fail, pass, pending, type TaskArgs, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";

type Deps = TaskDeps;
type Args<C = unknown, I = unknown> = TaskArgs<C, I, Deps>;

const NO_CHANGE = "No change request exists yet";
const blocked = (message: string) => fail(message, { route: { stop: "blocked" } });

const ensureConfig = z.object({
  closingReference: z.boolean().optional(),
  /** Accepted for configuration compatibility; the criteria checklist is rendered by a later task. */
  criteriaChecklist: z.boolean().optional(),
});
const mergeConfig = z.object({ method: z.literal("squash").default("squash") });
const emptyInput = z.object({});
const metadataInput = z.looseObject({});

function codeHostOf(deps: Deps): CodeHost {
  if (!deps.codeHost) throw new Error(`no code host configured for ${deps.issueId}`);
  return deps.codeHost;
}

function toContext(delivery: ChangeDelivery): ChangeContext {
  const { change, pullRequest } = delivery;
  return {
    ref: { provider: change.id.split(":")[0] ?? "", id: change.id, number: change.number },
    url: change.url,
    state: change.state === "merged" ? "merged" : change.state === "closed" ? "closed" : "open",
    draft: change.draft,
    headSha: change.headSha,
    baseBranch: pullRequest?.baseBranch ?? "",
    mergeable: change.mergeable === null ? "unknown" : change.mergeable ? "yes" : "no",
    mergeCommitSha: pullRequest?.mergeCommitSha ?? null,
    criteria: [],
    findings: [],
  };
}

const load: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.load",
  kind: "load",
  description: "Loads the item's change request live from the code host (state, head, mergeability); null until one exists.",
  reads: [],
  writes: ["change"],
  invalidates: [],
  async run({ deps }: Args) {
    const stored = deps.store.getCurrentPullRequest(deps.issueId);
    if (!stored) return pass(null);
    const delivery = await codeHostOf(deps).getChangeDelivery({ address: deps.repository.address, id: stored.id });
    return pass(toContext(delivery));
  },
};

const ensure: TaskDefinition<z.output<typeof ensureConfig>, unknown, Deps> = {
  name: "change.ensure",
  kind: "act",
  description: "Pushes the workspace branch and opens the change request for it, reusing an existing one. A rejected push fails and retries the stage.",
  reads: ["repository"],
  writes: [],
  invalidates: ["change", "workspace"],
  config: ensureConfig,
  async run({ deps, config }: Args<z.output<typeof ensureConfig>>) {
    const workspace = deps.store.getActiveWorkspace(deps.issueId);
    if (!workspace) return fail("run has no workspace");
    const issue = deps.store.getIssue(deps.issueId);
    if (!issue) throw new Error(`issue ${deps.issueId} is not stored`);
    const ensured = await pushAndEnsureChange({
      codeHost: codeHostOf(deps), store: deps.store, address: deps.repository.address, issue, workspace,
      base: deps.repository.baseBranch, closes: config.closingReference !== false,
    });
    if (!ensured.pushed) return fail(ensured.reason, { route: { retry: true } });
    return pass();
  },
};

const merge: TaskDefinition<z.output<typeof mergeConfig>, unknown, Deps> = {
  name: "change.merge",
  kind: "act",
  description: "Squash-merges the change only at the head that review passed (and CI, when CI is required); stops as blocked otherwise. An already merged change passes.",
  reads: ["repository", "change", "checkpoints"],
  writes: [],
  invalidates: ["change"],
  config: mergeConfig,
  async run({ context, deps, config }: Args<z.output<typeof mergeConfig>>) {
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    if (change.state === "merged") return pass();
    if (change.state === "closed") return blocked(`Change request #${change.ref.number} is closed without being merged`);
    const { reviewPassed, ciPassed } = context.checkpoints!;
    if (reviewPassed?.sha !== change.headSha) {
      return blocked(reviewPassed
        ? `Review passed at ${reviewPassed.sha}, but the change head is ${change.headSha}; it must be reviewed again before merging`
        : "Review has not passed for this change, so it will not be merged");
    }
    if (context.repository?.ciMode === "required" && ciPassed?.sha !== change.headSha) {
      return blocked(ciPassed
        ? `CI passed at ${ciPassed.sha}, but the change head is ${change.headSha}; CI must pass for the head before merging`
        : "CI has not passed for this change, so it will not be merged");
    }
    const host = codeHostOf(deps);
    const address = deps.repository.address;
    const live = await host.getChange({ address, id: change.ref.id });
    if (live.state === "merged") return pass();
    if (live.headSha !== change.headSha) {
      return blocked(`The change head moved to ${live.headSha} after review at ${change.headSha}; it will not be merged`);
    }
    const merged = await host.mergeChange({ address, id: change.ref.id, method: config.method, expectedHeadSha: change.headSha });
    if (merged.headMoved) return blocked(`The change head moved after review at ${change.headSha}; it will not be merged`);
    if (!merged.merged) return fail(`The code host did not merge change request #${live.number}`);
    deps.store.upsertPullRequest({
      issueId: deps.issueId, id: live.id, number: live.number, url: live.url, state: "merged", mergedAt: new Date().toISOString(),
    });
    return pass(merged.sha ? { sha: merged.sha } : undefined);
  },
};

const headUnchanged: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.headUnchanged",
  kind: "check",
  description: "Passes when the change head equals the SHA CI passed for.",
  reads: ["change", "checkpoints"],
  writes: [],
  invalidates: [],
  run({ context }) {
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    const passed = context.checkpoints!.ciPassed;
    if (!passed) return fail("CI has not passed for this change");
    return passed.sha === change.headSha ? pass() : fail(`The change head ${change.headSha} differs from the CI-passed ${passed.sha}`);
  },
};

const mergeable: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.mergeable",
  kind: "check",
  description: "Passes when the code host reports the change mergeable; pending while it is still computing, a failure when it conflicts.",
  reads: ["change"],
  writes: [],
  invalidates: [],
  defaultWait: { timeoutMs: 30 * 60_000, pollMs: 60_000 },
  run({ context }) {
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    if (change.state === "merged") return pass();
    if (change.state === "closed") return fail(`Change request #${change.ref.number} is closed`);
    if (change.mergeable === "unknown") return pending("Waiting for the code host to report whether the change is mergeable");
    return change.mergeable === "yes" ? pass() : fail(`Change request #${change.ref.number} is not mergeable (conflicts or blocking requirements)`);
  },
};

const merged: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.merged",
  kind: "check",
  description: "Passes when the change request is merged.",
  reads: ["change"],
  writes: [],
  invalidates: [],
  run({ context }) {
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    return change.state === "merged" ? pass() : fail(`Change request #${change.ref.number} is ${change.state}, not merged`);
  },
};

const get: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.get",
  kind: "tool",
  description: "Read the live change request, its pull request projection and its CI checks.",
  reads: [], writes: [], invalidates: [],
  input: emptyInput,
  async run({ deps }: Args) {
    if (!deps.delivery) throw new Error("change.get needs the delivery state");
    return pass(await deps.delivery());
  },
};

const setMetadata: TaskDefinition<unknown, z.output<typeof metadataInput>, Deps> = {
  name: "change.setMetadata",
  kind: "tool",
  description: "Record change request metadata (title, labels) for the run.",
  reads: [], writes: [], invalidates: [],
  mutating: true,
  input: metadataInput,
  run({ deps, input }) {
    if (!deps.run) throw new Error("change.setMetadata needs a run: call it through an agent MCP grant");
    deps.store.appendRunEvent(deps.run.id, "source.set_pull_request_metadata", input);
    return pass({ accepted: true });
  },
};

export const changeGroup = defineGroup("change", [load, ensure, merge, headUnchanged, mergeable, merged, get, setMetadata]);
