// SHA-bound acceptance-criterion approvals for the `change` group. The approvals table is the
// authority; the checklist in the pull request body is a projection of it, checked only for
// criteria approved at the change's current head.

import { z } from "zod";

import type { CodeHost } from "../codehost/types";
import { CriterionApprovals, criterionTextHash } from "../engine/review-records";
import { formatAcceptanceCriteria, ManagedSectionError, parseManagedSections } from "../source/github/managed-sections";
import type { ChangeContext } from "./context";
import { fail, pass, type TaskArgs, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";
import { criteriaOf } from "./item";

type Deps = TaskDeps;

const criterionInput = z.object({ criterionId: z.string().min(1), headSha: z.string().min(1) }).strict();
type CriterionInput = z.output<typeof criterionInput>;

const NO_CHANGE = "No change request exists yet";

const MALFORMED = (detail: string) => `PR checklist markers are malformed: ${detail}; restore or remove the conveyor managed section`;

/** The item's criteria with their approval at `headSha` (an approval for another head or other text is none). */
export function criteriaView(deps: Deps, body: string, headSha: string): ChangeContext["criteria"] {
  const approvals = new Map(new CriterionApprovals(deps.store.sqlite()).list(deps.issueId).map((a) => [a.criterionId, a]));
  const projected = projectedChecklist(body).checked;
  return criteriaOf(deps.store.getIssue(deps.issueId)?.body ?? "").map(({ id, text }) => {
    const approval = approvals.get(id);
    return {
      id,
      projectedChecked: projected.get(id) ?? false,
      approval: approval && approval.headSha === headSha && approval.textHash === criterionTextHash(text)
        ? { reviewer: approval.reviewer, headSha: approval.headSha, checkedAt: approval.checkedAt }
        : null,
    };
  });
}

/** Checked state per criterion id (in order) of the checklist projected into a change body, or why it cannot be read. */
export function projectedChecklist(body: string): { checked: Map<string, boolean>; error: string | null } {
  const checked = new Map<string, boolean>();
  let markdown: string | undefined;
  try {
    markdown = parseManagedSections(body).sections["acceptance-criteria"];
  } catch (error) {
    if (error instanceof ManagedSectionError) return { checked, error: error.message };
    throw error;
  }
  for (const line of (markdown ?? "").split(/\r?\n/)) {
    const match = /^- \[([ xX])\]\s.*<!-- conveyor:criterion:([^\s>]+) -->$/.exec(line.trim());
    if (match?.[2]) checked.set(match[2], match[1] !== " ");
  }
  return { checked, error: null };
}

export type SyncResult = { ok: true } | { ok: false; malformed: boolean; message: string };

/** The checklist markdown for the item's criteria, or the reason it cannot be rendered (invalid or duplicate ids). */
function render(deps: Deps, headSha: string | null): { markdown: string } | { error: string } {
  const approvals = new Map(new CriterionApprovals(deps.store.sqlite()).list(deps.issueId).map((a) => [a.criterionId, a]));
  const criteria = criteriaOf(deps.store.getIssue(deps.issueId)?.body ?? "");
  try {
    return {
      markdown: formatAcceptanceCriteria(criteria.map(({ id, text }) => {
        const approval = approvals.get(id);
        return { id, text, completed: headSha !== null && approval?.headSha === headSha && approval.textHash === criterionTextHash(text) };
      })),
    };
  } catch (error) {
    if (error instanceof ManagedSectionError) return { error: `The criteria cannot be rendered as a checklist: ${error.message}` };
    throw error;
  }
}

/** Renders the item's criteria into the change body, skipping the write when it already matches. Never throws on a malformed body. */
export async function syncChecklist(host: CodeHost, deps: Deps, changeId: string): Promise<SyncResult> {
  const address = deps.repository.address;
  const live = await host.getChange({ address, id: changeId });
  const body = live.body ?? "";
  const { error } = projectedChecklist(body);
  if (error) return { ok: false, malformed: true, message: MALFORMED(error) };
  const rendered = render(deps, live.headSha);
  if ("error" in rendered) return { ok: false, malformed: false, message: rendered.error };
  const existing = parseManagedSections(body).sections["acceptance-criteria"];
  if ((existing ?? "") === rendered.markdown) return { ok: true };
  try {
    await host.setChangeChecklist({ address, id: changeId, markdown: rendered.markdown });
  } catch (caught) {
    if (caught instanceof ManagedSectionError) return { ok: false, malformed: true, message: MALFORMED(caught.message) };
    throw caught;
  }
  return { ok: true };
}

function criterionTool(
  name: "change.checkCriterion" | "change.uncheckCriterion",
  description: string,
  record: (approvals: CriterionApprovals, input: CriterionInput, reviewer: string, issueId: string, textHash: string) => void,
): TaskDefinition<unknown, CriterionInput, Deps> {
  return {
    name,
    kind: "tool",
    description,
    reads: [], writes: [], invalidates: ["change"],
    mutating: true,
    // An upsert or delete: replaying a journaled response would skip a later check after an uncheck.
    journal: false,
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
      const criterion = criteriaOf(deps.store.getIssue(deps.issueId)?.body ?? "").find((c) => c.id === criterionId)!;
      const problem = render(deps, headSha);
      if ("error" in problem) return fail(problem.error);
      record(new CriterionApprovals(deps.store.sqlite()), input!, reviewer, deps.issueId, criterionTextHash(criterion.text));
      const synced = await syncChecklist(host, deps, stored.id);
      return pass(synced.ok
        ? { criterionId, headSha }
        : { criterionId, headSha, checklist: `Recorded, but the PR checklist could not be updated: ${synced.message}` });
    },
  };
}

export const checkCriterion = criterionTool(
  "change.checkCriterion",
  "Approve one acceptance criterion for the current change head and tick it in the pull request checklist. headSha must be the current head.",
  (approvals, input, reviewer, issueId, textHash) =>
    approvals.approve({ issueId, criterionId: input.criterionId, reviewer, headSha: input.headSha, checkedAt: new Date().toISOString(), textHash }),
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
  repairedByActions: true,
  reads: ["item", "change"],
  writes: [],
  invalidates: [],
  run({ context }) {
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    if (change.projectionError) return fail(MALFORMED(change.projectionError));
    const wanted = context.item!.criteria.map((criterion) => criterion.id);
    const listed = new Set(change.projectedCriterionIds);
    const missing = wanted.filter((id) => !listed.has(id));
    const extra = change.projectedCriterionIds.filter((id) => !wanted.includes(id));
    if (missing.length === 0 && extra.length === 0) return pass();
    const parts = [
      ...(missing.length ? [`missing from the checklist: ${missing.join(", ")}`] : []),
      ...(extra.length ? [`not item criteria: ${extra.join(", ")}`] : []),
    ];
    return fail(`The pull request checklist is out of sync with the item's criteria (${parts.join("; ")}). Conveyor rewrites this checklist when it pushes the change; do not edit the pull request description.`);
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
