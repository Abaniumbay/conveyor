// The `change` task group: the code host's change request (a pull request on GitHub).
// `change.load` reads the stored change live. `change.merge` squashes only the head that
// review (and, when CI is required, CI) passed: the code host refuses if the head moved.

import { z } from "zod";

import { pushAndEnsureChange } from "../codehost/actions";
import type { ChangeDelivery, CodeHost } from "../codehost/types";
import { changeTopic } from "../events/topics";
import { parseManagedSections } from "../source/github/managed-sections";
import type { ChangeContext } from "./context";
import { defineGroup, fail, pass, pending, type TaskArgs, type TaskDefinition } from "./contract";
import { checkCriterion, criterionTestsPassed, criterionTestsVerified, criteriaChecked, criteriaInSync, criteriaView, projectedChecklist, recordCriterionTests, syncChecklist, uncheckCriterion } from "./change-criteria";
import { findingsResolved, findingsView, findingTools, importNativeReview } from "./change-findings";
import type { TaskDeps } from "./deps";

type Deps = TaskDeps;
type Args<C = unknown, I = unknown> = TaskArgs<C, I, Deps>;

const NO_CHANGE = "No change request exists yet";
const blocked = (message: string) => fail(message, { route: { stop: "blocked" } });
// A repairable merge failure names no stage: the action's configured onFail decides where it goes.
const recoverMerge = (message: string) => fail(`${message} Update the branch, run CI, and obtain a fresh review for its current head.`);

const ensureConfig = z.object({
  closingReference: z.boolean().optional(),
  /** Render the item's criteria as a managed checklist in the change request body. */
  criteriaChecklist: z.boolean().optional(),
});
const mergeConfig = z.object({ method: z.literal("squash").default("squash") });
const emptyInput = z.object({});
const MAX_DESCRIPTION_LENGTH = 32_000;
const metadataInput = z.object({
  description: z.string().max(MAX_DESCRIPTION_LENGTH, "description must be at most 32,000 characters"),
}).strict();

function codeHostOf(deps: Deps): CodeHost {
  if (!deps.codeHost) throw new Error(`no code host configured for ${deps.issueId}`);
  return deps.codeHost;
}

function toContext(delivery: ChangeDelivery, deps: Deps): ChangeContext {
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
    criteria: criteriaView(deps, change.body ?? "", change.headSha),
    projectedCriterionIds: [...projectedChecklist(change.body ?? "").checked.keys()],
    projectionError: projectedChecklist(change.body ?? "").error,
    findings: findingsView(deps),
  };
}

const load: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.load",
  kind: "load",
  description: "Loads the item's change request live from the code host (state, head, mergeability) and imports its native human review as findings; null until a change request exists.",
  reads: [],
  writes: ["change"],
  invalidates: [],
  async run({ deps }: Args) {
    const stored = deps.store.getCurrentPullRequest(deps.issueId);
    if (!stored) return pass(null);
    const delivery = await codeHostOf(deps).getChangeDelivery({ address: deps.repository.address, id: stored.id });
    await importNativeReview(deps, stored.id, delivery.change.headSha);
    return pass(toContext(delivery, deps));
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
    if (config.criteriaChecklist) {
      const stored = deps.store.getCurrentPullRequest(deps.issueId);
      const synced = stored ? await syncChecklist(codeHostOf(deps), deps, stored.id) : null;
      if (synced && !synced.ok) return fail(synced.message, synced.malformed ? { route: { retry: true } } : {});
    }
    return pass();
  },
};

const merge: TaskDefinition<z.output<typeof mergeConfig>, unknown, Deps> = {
  name: "change.merge",
  kind: "act",
  description: "Squash-merges only the reviewed (and, when required, CI-passed) head. A changed, conflicting, or outdated branch fails without a route, so the action's configured onFail sends it to the stage that repairs it; closed or policy-refused changes stop. An already merged change passes.",
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
      return reviewPassed
        ? recoverMerge(`Review passed at ${reviewPassed.sha}, but the change head is ${change.headSha}.`)
        : blocked("Review has not passed for this change, so it will not be merged");
    }
    if (context.repository?.ciMode === "required" && ciPassed?.sha !== change.headSha) {
      return ciPassed
        ? recoverMerge(`CI passed at ${ciPassed.sha}, but the change head is ${change.headSha}.`)
        : blocked("CI has not passed for this change, so it will not be merged");
    }
    const host = codeHostOf(deps);
    const address = deps.repository.address;
    const live = await host.getChange({ address, id: change.ref.id });
    if (live.state === "merged") return pass();
    if (live.headSha !== change.headSha) {
      return recoverMerge(`The change head moved to ${live.headSha} after review at ${change.headSha}.`);
    }
    if (live.mergeable === false) return recoverMerge(`Change request #${live.number} conflicts with its base branch.`);
    const merged = await host.mergeChange({ address, id: change.ref.id, method: config.method, expectedHeadSha: change.headSha });
    if (!merged.merged) {
      const reason = merged.reason ? ` ${merged.reason}` : "";
      if (merged.refusal === "head-moved") return recoverMerge(`The change head moved after review at ${change.headSha}.${reason}`);
      if (merged.refusal === "conflict") return recoverMerge(`Change request #${live.number} became conflicting during merge.${reason}`);
      if (merged.refusal === "outdated") return recoverMerge(`Change request #${live.number} is outdated against its base branch.${reason}`);
      return blocked(`The code host refused to merge change request #${live.number}.${reason} This is not a repairable conflict or changed head.`);
    }
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
  description: "Passes unless the code host reports that the change conflicts with its base branch; then it asks for the branch to be updated, conflicts resolved, tested, and a new head published. A mergeability the host has not computed yet passes: the merge itself decides, and a refused merge follows the merge action's onFail.",
  reads: ["change"],
  writes: [],
  invalidates: [],
  defaultWait: { timeoutMs: 30 * 60_000, pollMs: 60_000 },
  run({ context }) {
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    if (change.state === "merged") return pass();
    if (change.state === "closed") return fail(`Change request #${change.ref.number} is closed`);
    // Waiting for the host to compute mergeability cost a read per poll; the merge attempt reports it.
    if (change.mergeable === "unknown") return pass();
    return change.mergeable === "yes" ? pass() : fail(`Change request #${change.ref.number} conflicts with its base branch. Update the branch, resolve conflicts, test, and publish a new head.`);
  },
};

const merged: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.merged",
  kind: "check",
  description: "Passes when the change request is merged. An open request remains pending and wakes when its change delivery arrives.",
  reads: ["repository", "change"],
  writes: [],
  invalidates: [],
  run({ context }) {
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    if (change.state === "merged") return pass();
    if (change.state === "open") {
      return pending(`Waiting for change request #${change.ref.number} to be merged`, {
        waitFor: { topics: [changeTopic(context.repository!.address, change.ref.number!)], kind: "change" },
      });
    }
    return fail(`Change request #${change.ref.number} is ${change.state}, not merged`);
  },
};

const get: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.get",
  kind: "tool",
  description: "Read the live change request, its pull request projection, CI checks, and authoritative criterion evidence with approval state.",
  reads: [], writes: [], invalidates: [],
  input: emptyInput,
  async run({ deps }: Args) {
    if (!deps.delivery) throw new Error("change.get needs the delivery state");
    const delivery = await deps.delivery();
    const stored = deps.store.getCurrentPullRequest(deps.issueId);
    const live = stored ? await codeHostOf(deps).getChangeDelivery({ address: deps.repository.address, id: stored.id }) : null;
    return pass({ ...delivery, criteria: live ? toContext(live, deps).criteria : [] });
  },
};

const setMetadata: TaskDefinition<unknown, z.output<typeof metadataInput>, Deps> = {
  name: "change.setMetadata",
  kind: "tool",
  description: "Set only `{ description }` (Markdown up to 32,000 characters; empty clears) in the pull request's managed description section and return its pull request and stored length.",
  reads: [], writes: [], invalidates: ["change"],
  mutating: true,
  input: metadataInput,
  async run({ deps, input }) {
    const stored = deps.store.getCurrentPullRequest(deps.issueId);
    if (!stored) return fail(NO_CHANGE);
    const description = input!.description;
    const change = await codeHostOf(deps).setChangeDescription({
      address: deps.repository.address,
      id: stored.id,
      markdown: description,
    });
    if (change.body === undefined) throw new Error("provider did not return the updated pull request body");
    return pass({
      pullRequest: { number: change.number, url: change.url },
      descriptionLength: parseManagedSections(change.body).sections.description?.length ?? 0,
    });
  },
};

export const changeGroup = defineGroup("change", [load, ensure, merge, headUnchanged, mergeable, merged, criteriaInSync, criteriaChecked, criterionTestsVerified, criterionTestsPassed, get, setMetadata, checkCriterion, uncheckCriterion, recordCriterionTests, findingsResolved, ...findingTools]);
