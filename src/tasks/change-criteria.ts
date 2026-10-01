// SHA-bound acceptance-criterion approvals for the `change` group. The approvals table is the
// authority; the checklist in the pull request body is a projection of it, checked only for
// criteria approved at the change's current head.

import { z } from "zod";

import type { CodeHost } from "../codehost/types";
import { CriterionApprovals } from "../engine/review-records";
import { formatAcceptanceCriteria, parseManagedSections } from "../source/github/managed-sections";
import type { ChangeContext } from "./context";
import { fail, pass, type TaskArgs, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";
import { criteriaOf } from "./item";

type Deps = TaskDeps;

const criterionInput = z.object({ criterionId: z.string().min(1), headSha: z.string().min(1) }).strict();
type CriterionInput = z.output<typeof criterionInput>;

const NO_CHANGE = "No change request exists yet";

/** The item's criteria with their approval at `headSha` (an approval for another head is none). */
export function criteriaView(deps: Deps, body: string, headSha: string): ChangeContext["criteria"] {
  const approvals = new Map(new CriterionApprovals(deps.store.sqlite()).list(deps.issueId).map((a) => [a.criterionId, a]));
  const projected = projectedChecklist(body);
  const issue = deps.store.getIssue(deps.issueId);
  return criteriaOf(issue?.body ?? "").map(({ id }) => {
    const approval = approvals.get(id);
    return {
      id,
      projectedChecked: projected.get(id) ?? false,
      approval: approval && approval.headSha === headSha
        ? { reviewer: approval.reviewer, headSha: approval.headSha, checkedAt: approval.checkedAt }
        : null,
    };
  });
}

/** Ids (in order) of the checklist projected into a change body, with their checked state. */
export function projectedChecklist(body: string): Map<string, boolean> {
  const projected = new Map<string, boolean>();
  let markdown: string | undefined;
  try {
    markdown = parseManagedSections(body).sections["acceptance-criteria"];
  } catch {
    return projected;
  }
  for (const line of (markdown ?? "").split(/\r?\n/)) {
    const match = /^- \[([ xX])\]\s.*<!-- conveyor:criterion:([^\s>]+) -->$/.exec(line.trim());
    if (match?.[2]) projected.set(match[2], match[1] !== " ");
  }
  return projected;
}

/** Renders the item's criteria into the change body, skipping the write when it already matches. */
export async function syncChecklist(host: CodeHost, deps: Deps, changeId: string): Promise<void> {
  const address = deps.repository.address;
  const live = await host.getChange({ address, id: changeId });
  const body = live.body ?? "";
  const approvals = new Map(new CriterionApprovals(deps.store.sqlite()).list(deps.issueId).map((a) => [a.criterionId, a.headSha]));
  const criteria = criteriaOf(deps.store.getIssue(deps.issueId)?.body ?? "");
  const markdown = formatAcceptanceCriteria(criteria.map(({ id, text }) => ({ id, text, completed: approvals.get(id) === live.headSha })));
  let existing: string | undefined;
  try {
    existing = parseManagedSections(body).sections["acceptance-criteria"];
  } catch {
    existing = undefined;
  }
  if ((existing ?? "") === markdown) return;
  await host.setChangeChecklist({ address, id: changeId, markdown });
}

function criterionTool(
  name: "change.checkCriterion" | "change.uncheckCriterion",
  description: string,
  record: (approvals: CriterionApprovals, input: CriterionInput, reviewer: string, issueId: string) => void,
): TaskDefinition<unknown, CriterionInput, Deps> {
  return {
    name,
    kind: "tool",
    description,
    reads: [], writes: [], invalidates: ["change"],
    mutating: true,
    input: criterionInput,
    async run({ deps, input, actor }: TaskArgs<unknown, CriterionInput, Deps>) {
      const { criterionId, headSha } = input!;
      const stored = deps.store.getCurrentPullRequest(deps.issueId);
      if (!stored) return fail(NO_CHANGE);
      const known = criteriaOf(deps.store.getIssue(deps.issueId)?.body ?? "").map((criterion) => criterion.id);
      if (!known.includes(criterionId)) {
        return fail(`Unknown criterion "${criterionId}"; the criteria of this item are: ${known.join(", ") || "(none)"}`);
      }
      const host = deps.codeHost;
      if (!host) throw new Error(`no code host configured for ${deps.issueId}`);
      const live = await host.getChange({ address: deps.repository.address, id: stored.id });
      if (live.headSha !== headSha) return fail(`The change head is ${live.headSha}, not ${headSha}; read change.get and retry`);
      const reviewer = actor ?? deps.run?.actor?.id;
      if (!reviewer) throw new Error(`${name} needs an actor`);
      record(new CriterionApprovals(deps.store.sqlite()), input!, reviewer, deps.issueId);
      await syncChecklist(host, deps, stored.id);
      return pass({ criterionId, headSha });
    },
  };
}

export const checkCriterion = criterionTool(
  "change.checkCriterion",
  "Approve one acceptance criterion for the current change head and tick it in the pull request checklist. headSha must be the current head.",
  (approvals, input, reviewer, issueId) =>
    approvals.approve({ issueId, criterionId: input.criterionId, reviewer, headSha: input.headSha, checkedAt: new Date().toISOString() }),
);

export const uncheckCriterion = criterionTool(
  "change.uncheckCriterion",
  "Withdraw the approval of one acceptance criterion and untick it in the pull request checklist. headSha must be the current head.",
  (approvals, input, _reviewer, issueId) => approvals.withdraw(issueId, input.criterionId),
);

export const criteriaInSync: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.criteriaInSync",
  kind: "check",
  description: "Passes when the pull request checklist lists exactly the item's criteria ids.",
  reads: ["item", "change"],
  writes: [],
  invalidates: [],
  run({ context }) {
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    const wanted = context.item!.criteria.map((criterion) => criterion.id);
    const listed = new Set(change.projectedCriterionIds);
    const missing = wanted.filter((id) => !listed.has(id));
    const extra = change.projectedCriterionIds.filter((id) => !wanted.includes(id));
    if (missing.length === 0 && extra.length === 0) return pass();
    const parts = [
      ...(missing.length ? [`missing from the checklist: ${missing.join(", ")}`] : []),
      ...(extra.length ? [`not item criteria: ${extra.join(", ")}`] : []),
    ];
    return fail(`The pull request checklist is out of sync with the item's criteria (${parts.join("; ")})`);
  },
};

export const criteriaChecked: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.criteriaChecked",
  kind: "check",
  description: "Passes when every non-manual criterion is approved for the current change head; manual criteria are excluded.",
  reads: ["item", "change"],
  writes: [],
  invalidates: [],
  run({ context }) {
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    const approved = new Set(change.criteria.filter((c) => c.approval?.headSha === change.headSha).map((c) => c.id));
    const missing = context.item!.criteria.filter((c) => !c.manual && !approved.has(c.id)).map((c) => c.id);
    return missing.length === 0 ? pass() : fail(`Criteria not approved for head ${change.headSha}: ${missing.join(", ")}`);
  },
};
