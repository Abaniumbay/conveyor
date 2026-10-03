// Review findings for the `change` group, independent of the code host: an agent records one
// with `change.comment` (the record comes first, the code host comment is its projection), native
// human review is imported by `change.load`, and a finding ends resolved, dismissed by a person,
// or withdrawn when its native artifact disappears. `change.findingsResolved` gates on them.

import { z } from "zod";

import type { CodeHost } from "../codehost/types";
import { ReviewFindings, type Finding } from "../engine/review-findings";
import type { ChangeContext } from "./context";
import { fail, pass, type TaskArgs, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";

type Deps = TaskDeps;

const NO_CHANGE = "No change request exists yet";

const commentInput = z.object({
  body: z.string().trim().min(1),
  headSha: z.string().min(1),
  path: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
}).strict().refine((input) => input.line === undefined || input.path !== undefined, { message: "line needs a path" });
type CommentInput = z.output<typeof commentInput>;

const resolveInput = z.object({
  findingId: z.string().min(1),
  /** fixed: the problem is fixed at the current head. invalid: the finding is wrong, not applicable or already satisfied. */
  verdict: z.enum(["fixed", "invalid"]),
  /** What changed (fixed) or why nothing changed (invalid); posted as the reply on the finding. */
  comment: z.string().trim().min(1).max(2000),
}).strict();
const listInput = z.object({ state: z.enum(["open", "resolved", "dismissed", "withdrawn"]).optional() }).strict();
const dismissInput = z.object({ findingId: z.string().min(1), reason: z.string().trim().min(1).max(2000) }).strict();

const findingsOf = (deps: Deps) => new ReviewFindings(deps.store.sqlite());

function actorOf(name: string, args: { actor?: string; deps: Deps }): string {
  const actor = args.actor ?? args.deps.run?.actor?.id;
  if (!actor) throw new Error(`${name} needs an actor`);
  return actor;
}

function codeHostOf(deps: Deps): CodeHost {
  if (!deps.codeHost) throw new Error(`no code host configured for ${deps.issueId}`);
  return deps.codeHost;
}

/** The findings of the item as `ChangeContext.findings` carries them. */
export function findingsView(deps: Deps): ChangeContext["findings"] {
  return findingsOf(deps).list(deps.issueId).map((finding) => ({
    id: finding.id, providerKey: finding.providerKey, author: finding.author, source: finding.source, headSha: finding.headSha,
    state: finding.state, path: finding.path, line: finding.line, url: finding.url,
    ...(finding.dismissal ? { dismissal: finding.dismissal } : {}),
    ...(finding.withdrawal ? { withdrawal: finding.withdrawal } : {}),
  }));
}

/** Reads the code host's native review and brings the imported findings in line with it (a Conveyor-owned write, safe to repeat). */
export async function importNativeReview(deps: Deps, changeId: string, headSha: string): Promise<void> {
  const artifacts = await codeHostOf(deps).listReviewArtifacts({ address: deps.repository.address, id: changeId });
  findingsOf(deps).importNative(deps.issueId, artifacts, headSha, (deps.clock?.() ?? new Date()).toISOString());
}

const comment: TaskDefinition<unknown, CommentInput, Deps> = {
  name: "change.comment",
  kind: "tool",
  description: "Record a review finding on the change: it blocks the review gate until it is resolved or dismissed. Give path and line to anchor it to the diff (otherwise, or when the host rejects the position, it becomes a change comment). headSha must be the current head.",
  reads: [], writes: [], invalidates: ["change"],
  mutating: true,
  input: commentInput,
  async run(args: TaskArgs<unknown, CommentInput, Deps>) {
    const { deps, input } = args;
    const stored = deps.store.getCurrentPullRequest(deps.issueId);
    if (!stored) return fail(NO_CHANGE);
    const author = actorOf("change.comment", args);
    const findings = findingsOf(deps);
    const finding = findings.create({
      issueId: deps.issueId, runId: deps.run?.id ?? null, author, headSha: input!.headSha,
      path: input!.path ?? null, line: input!.line ?? null, body: input!.body,
    });
    try {
      const projected = await codeHostOf(deps).createFinding({
        address: deps.repository.address, id: stored.id, findingId: finding.id, body: input!.body, headSha: input!.headSha,
        ...(input!.path ? { path: input!.path } : {}), ...(input!.line ? { line: input!.line } : {}),
      });
      findings.project(finding.id, projected.url, projected.projection);
      return pass({ findingId: finding.id, url: projected.url });
    } catch (error) {
      // The record stands (and blocks the gate); only the code host copy is missing.
      const message = error instanceof Error ? error.message : String(error);
      return pass({ findingId: finding.id, url: "", projection: `Recorded, but the code host comment could not be created: ${message}` });
    }
  },
};

const resolveFinding: TaskDefinition<unknown, z.output<typeof resolveInput>, Deps> = {
  name: "change.resolveFinding",
  kind: "tool",
  description: "Close an open review finding, whoever wrote it (a reviewer agent, a person or a review bot): verdict fixed when the problem is fixed and pushed, invalid when the finding is wrong, not applicable or already satisfied. The comment says what changed or why nothing did; it is posted as a reply naming the current head commit and you, with a thumbs up (fixed) or down (invalid), and the thread is resolved. A resolved finding stays so; dismissed and withdrawn findings cannot be resolved.",
  reads: [], writes: [], invalidates: ["change"],
  mutating: true,
  // A state change that is idempotent by itself: replaying a journaled response is never needed.
  journal: false,
  input: resolveInput,
  async run(args: TaskArgs<unknown, z.output<typeof resolveInput>, Deps>) {
    const { deps, input } = args;
    const findings = findingsOf(deps);
    const finding = findings.get(deps.issueId, input!.findingId);
    if (!finding) return fail(`Unknown finding "${input!.findingId}"; read change.listFindings`);
    if (finding.state === "resolved") return pass({ findingId: finding.id, state: "resolved" });
    if (finding.state !== "open") return fail(`Finding ${finding.id} is ${finding.state}, not open`);
    const actor = actorOf("change.resolveFinding", args);
    const stored = deps.store.getCurrentPullRequest(deps.issueId);
    const host = stored ? codeHostOf(deps) : null;
    const head = stored ? await host!.getChange({ address: deps.repository.address, id: stored.id }).then((change) => change.headSha, () => null) : null;
    const message = resolutionMessage(input!.verdict, displayNameOf(actor, deps), head, input!.comment);
    if (finding.source === "human") {
      // An imported finding follows its native thread, so the thread must be answered and resolved first.
      if (!stored || !finding.providerKey) return fail(`Finding ${finding.id} cannot be resolved: it has no change or native review reference`);
      try {
        await host!.resolveNativeFinding({
          address: deps.repository.address, id: stored.id, providerKey: finding.providerKey, verdict: input!.verdict, message,
        });
      } catch (error) {
        return fail(`Could not resolve the review thread of finding ${finding.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      findings.resolve(deps.issueId, finding.id, actor);
      return pass({ findingId: finding.id, state: "resolved", verdict: input!.verdict });
    }
    findings.resolve(deps.issueId, finding.id, actor);
    if (finding.projection && stored) {
      try {
        await host!.resolveFindingProjection({
          address: deps.repository.address, id: stored.id, findingId: finding.id, projection: String(finding.projection), body: finding.body, actor,
          verdict: input!.verdict, message,
        });
      } catch {
        // Best effort: the record is the authority and stays resolved.
      }
    }
    return pass({ findingId: finding.id, state: "resolved", verdict: input!.verdict });
  },
};

/** The agent's display name ("Kaveh"), falling back to its id. */
function displayNameOf(actor: string, deps: Deps): string {
  return deps.run?.actor?.id === actor && deps.run.actor.name ? deps.run.actor.name : deps.config.agents?.[actor]?.name ?? actor;
}

/** The reply posted on a closed finding: verdict, commit, agent and explanation. */
export function resolutionMessage(verdict: "fixed" | "invalid", agent: string, headSha: string | null, comment: string): string {
  const commit = headSha ? ` in ${headSha.slice(0, 7)}` : "";
  return verdict === "fixed"
    ? `👍 Fixed${commit} by ${agent}: ${comment}`
    : `👎 Not changed by ${agent}${headSha ? ` (checked at ${headSha.slice(0, 7)})` : ""}: ${comment}`;
}

const listFindings: TaskDefinition<unknown, z.output<typeof listInput>, Deps> = {
  name: "change.listFindings",
  kind: "tool",
  description: "List the review findings of the change (id, author, state, location, URL, text), optionally only those in one state.",
  reads: [], writes: [], invalidates: [],
  input: listInput,
  async run({ deps, input }) {
    // Agents act on this list, so it must include review threads resolved or added on the code host
    // since the last change.load; otherwise a resolved thread still reads as open.
    const stored = deps.store.getCurrentPullRequest(deps.issueId);
    if (stored) {
      const delivery = await codeHostOf(deps).getChangeDelivery({ address: deps.repository.address, id: stored.id });
      await importNativeReview(deps, stored.id, delivery.change.headSha);
    }
    const state = input?.state;
    const rows = findingsOf(deps).list(deps.issueId).filter((finding) => !state || finding.state === state);
    return pass({ findings: rows.map(({ projection: _projection, ...rest }: Finding) => rest) });
  },
};

const dismissFinding: TaskDefinition<unknown, z.output<typeof dismissInput>, Deps> = {
  name: "change.dismissFinding",
  kind: "tool",
  description: "Dismiss an open finding with a reason. Operator only: never grantable to an agent; called by the authenticated web route.",
  reads: [], writes: [], invalidates: ["change"],
  mutating: true,
  journal: false,
  input: dismissInput,
  run(args: TaskArgs<unknown, z.output<typeof dismissInput>, Deps>) {
    const { deps, input } = args;
    const findings = findingsOf(deps);
    const finding = findings.get(deps.issueId, input!.findingId);
    if (!finding) return fail(`Unknown finding "${input!.findingId}"`);
    const actor = actorOf("change.dismissFinding", args);
    const at = (deps.clock?.() ?? new Date()).toISOString();
    if (!findings.dismiss(deps.issueId, finding.id, { actor, reason: input!.reason, at })) {
      return fail(`Finding ${finding.id} is ${finding.state}, not open`);
    }
    return pass({ findingId: finding.id, state: "dismissed" });
  },
};

export const findingsResolved: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.findingsResolved",
  kind: "check",
  description: "Passes when no review finding is open (resolved, dismissed and withdrawn findings do not block); the message lists the open ones with their URLs. The review gate passing at this head records the `reviewPassed` checkpoint.",
  reads: ["change"],
  writes: [],
  invalidates: [],
  checkpoint: { name: "reviewPassed", scope: "gate" },
  run({ context }) {
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    const open = change.findings.filter((finding) => finding.state === "open");
    if (open.length === 0) return pass();
    const lines = open.map((finding) => `- ${finding.id}${finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : ""} by ${finding.author}${finding.url ? `: ${finding.url}` : ""}`);
    return fail(`${open.length} review finding${open.length === 1 ? " is" : "s are"} still open:\n${lines.join("\n")}`);
  },
};

export const findingTools = [comment, resolveFinding, listFindings, dismissFinding];
