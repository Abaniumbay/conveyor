import { createHash } from "node:crypto";
import { z } from "zod";

import type { ItemContext } from "./context";
import { defineGroup, fail, pass, type TaskArgs, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";
import { ToolRequestError } from "./errors";
import { criteriaOf } from "./item";
import { formatDependencies, parseManagedSections, renderAcceptanceCriteriaSection, upsertManagedSection } from "../source/github/managed-sections";
import type { SourceIssue } from "../source/types";

const entryId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const criterion = z.object({ id: entryId, text: z.string().trim().min(1) }).strict();
const entry = z.object({
  id: entryId,
  title: z.string().trim().min(1).max(256),
  scope: z.string().trim().min(1),
  acceptanceCriteria: z.array(criterion).min(1),
  dependsOn: z.array(entryId).default([]),
  covers: z.array(entryId).min(1),
  systemLabels: z.array(z.string().trim().min(1)).default([]),
}).strict();
const planInput = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("no-split") }).strict(),
  z.object({ decision: z.literal("split"), entries: z.array(entry).min(1) }).strict(),
]);
const storedPlan = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("no-split"), review: z.enum(["proposed", "approved", "rejected"]), reason: z.string().optional() }).strict(),
  z.object({ decision: z.literal("split"), entries: z.array(entry).min(1), review: z.enum(["proposed", "approved", "rejected"]), reason: z.string().optional() }).strict(),
]);

type PlanInput = z.infer<typeof planInput>;
export type BreakdownPlan = z.infer<typeof storedPlan>;
type Entry = z.infer<typeof entry>;
type Deps = TaskDeps;
type Args<I = unknown> = TaskArgs<unknown, I, Deps>;

export function renderBreakdownPlan(plan: BreakdownPlan): string {
  return `## Work breakdown plan\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
}

/** Reads the source-owned plan without accepting malformed, hand-edited JSON as a plan. */
export function parseBreakdownPlan(body: string): BreakdownPlan | null {
  let markdown: string | undefined;
  try { markdown = parseManagedSections(body).sections.breakdown; } catch { return null; }
  return parseBreakdownMarkdown(markdown);
}

/** Validates the stored managed-section payload without retaining an entire issue body in context. */
export function parseBreakdownMarkdown(markdown: string | undefined): BreakdownPlan | null {
  if (!markdown) return null;
  const json = /^## Work breakdown plan\s*\n\s*```json\s*\n([\s\S]*?)\n```\s*$/.exec(markdown)?.[1];
  if (!json) return null;
  try {
    const parsed = storedPlan.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

function issueOf(deps: Deps) {
  const issue = deps.store.getIssue(deps.issueId);
  if (!issue) throw new Error(`issue ${deps.issueId} is not stored`);
  return issue;
}

function persist(deps: Deps, source: SourceIssue, storedId?: string, accepted: Partial<Pick<SourceIssue, "title" | "body">> = {}) {
  const existing = storedId ? deps.store.getIssue(storedId) : deps.store.listIssues(deps.repository.id).find((candidate) => candidate.sourceNumber === source.number);
  const id = existing?.id ?? source.id;
  deps.store.upsertIssue({
    id, repositoryId: deps.repository.id, sourceNumber: source.number, sourceUrl: source.url,
    // Keep the reconciler's accepted text when a read-after-write races an untrusted source edit.
    title: accepted.title ?? existing?.title ?? "", body: accepted.body ?? existing?.body ?? "", sourceState: source.state, sourceStateReason: source.stateReason ?? null,
    labels: source.labels, sourceUpdatedAt: source.updatedAt, acceptedTextAt: existing?.acceptedTextAt ?? (accepted.title !== undefined || accepted.body !== undefined ? source.updatedAt : null), ...(source.type !== undefined ? { issueType: source.type } : {}),
  });
  return deps.store.getIssue(id)!;
}

function validationErrors(plan: BreakdownPlan | PlanInput, parentCriteria: readonly { id: string }[], allowedSystemLabels?: readonly string[]): string[] {
  if (plan.decision === "no-split") return [];
  const entries = plan.entries;
  const ids = new Set(entries.map((candidate) => candidate.id));
  const parentIds = new Set(parentCriteria.map((candidate) => candidate.id));
  const errors: string[] = [];
  if (ids.size !== entries.length) errors.push("entry IDs must be unique");
  for (const candidate of entries) {
    const criterionIds = new Set(candidate.acceptanceCriteria.map((acceptanceCriterion) => acceptanceCriterion.id));
    if (criterionIds.size !== candidate.acceptanceCriteria.length) errors.push(`entry ${candidate.id} has duplicate acceptance-criterion IDs`);
    if (new Set(candidate.dependsOn).size !== candidate.dependsOn.length) errors.push(`entry ${candidate.id} has duplicate dependency IDs`);
    if (new Set(candidate.systemLabels).size !== candidate.systemLabels.length) errors.push(`entry ${candidate.id} has duplicate system labels`);
    for (const label of candidate.systemLabels) if (allowedSystemLabels && !allowedSystemLabels.includes(label)) errors.push(`entry ${candidate.id} uses unknown system label ${label}`);
    for (const dependency of candidate.dependsOn) {
      if (!ids.has(dependency)) errors.push(`entry ${candidate.id} depends on unknown entry ${dependency}`);
      if (dependency === candidate.id) errors.push(`entry ${candidate.id} cannot depend on itself`);
    }
    for (const covered of candidate.covers) if (!parentIds.has(covered)) errors.push(`entry ${candidate.id} covers unknown parent criterion ${covered}`);
  }
  for (const parentId of parentIds) if (!entries.some((candidate) => candidate.covers.includes(parentId))) errors.push(`parent criterion ${parentId} is not covered`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(entries.map((candidate) => [candidate.id, candidate]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = byId.get(id)?.dependsOn.some(visit) ?? false;
    visiting.delete(id);
    visited.add(id);
    return cyclic;
  };
  if (entries.some((candidate) => visit(candidate.id))) errors.push("entry dependencies must not contain a cycle");
  return [...new Set(errors)];
}

function reviewedPlan(plan: BreakdownPlan, review: "approved" | "rejected", reason?: string): BreakdownPlan {
  const fields = { review, ...(reason ? { reason } : {}) } as const;
  return plan.decision === "split" ? { decision: "split", entries: plan.entries, ...fields } : { decision: "no-split", ...fields };
}

async function savePlan(deps: Deps, issue: ReturnType<typeof issueOf>, current: SourceIssue, plan: BreakdownPlan): Promise<SourceIssue> {
  const updated = await deps.items.updateManagedSection({
    address: deps.repository.address, issueNumber: issue.sourceNumber, section: "breakdown",
    markdown: renderBreakdownPlan(plan), expectedRevision: deps.items.managedRevision(current.body),
  });
  const body = upsertManagedSection(issue.body, "breakdown", renderBreakdownPlan(plan), parseManagedSections(issue.body).revision);
  // This section is the trusted tool input just written by Conveyor.  Keep it
  // separate from the read-after-write source body, which may have changed.
  persist(deps, updated, issue.id, { body });
  return updated;
}

function scopeSection(scope: string): string { return `## Scope\n\n${scope}`; }
function entryMarker(id: string): string { return `<!-- conveyor:breakdown-entry:${id} -->`; }
function creationMarker(parentId: string, id: string): string { return createHash("sha256").update(`breakdown:${parentId}:${id}`).digest("hex"); }
function childBody(parentId: string, candidate: Entry): string {
  let body = upsertManagedSection("", "description", scopeSection(candidate.scope), parseManagedSections("").revision);
  body = upsertManagedSection(body, "acceptance-criteria", renderAcceptanceCriteriaSection(candidate.acceptanceCriteria), parseManagedSections(body).revision);
  return `${body.trimEnd()}\n\n${entryMarker(candidate.id)}\n<!-- conveyor:child-create:${creationMarker(parentId, candidate.id)} -->\n`;
}

async function updateSection(deps: Deps, number: number, section: "description" | "acceptance-criteria" | "dependencies", markdown: string): Promise<SourceIssue> {
  const current = await deps.items.getIssue(deps.repository.address, number);
  const updated = await deps.items.updateManagedSection({ address: deps.repository.address, issueNumber: number, section, markdown, expectedRevision: deps.items.managedRevision(current.body) });
  const stored = deps.store.listIssues(deps.repository.id).find((issue) => issue.sourceNumber === number);
  const body = stored
    ? upsertManagedSection(stored.body, section, markdown, parseManagedSections(stored.body).revision)
    : "";
  persist(deps, updated, undefined, { body });
  return updated;
}

function nextStage(deps: Deps, stage: string): string {
  const repository = deps.config.repositories[deps.repository.id]!;
  const stages = deps.config.pipelines[repository.pipeline]!.stages;
  const currentIndex = stages.findIndex((candidate) => candidate.id === stage);
  const childrenStartAt = stages[currentIndex]?.childrenStartAt ?? "next";
  const result = childrenStartAt === "next"
    ? stages[currentIndex + 1]?.id
    : stages.find((candidate) => candidate.id === childrenStartAt)?.id;
  if (!result) throw new ToolRequestError(`The ${stage} stage has no valid child start stage.`);
  return result;
}

const check = (name: string, description: string, run: TaskDefinition<unknown, unknown, Deps>["run"], reads: ("item" | "repository")[] = ["item"]): TaskDefinition<unknown, unknown, Deps> => ({
  name, kind: "check", description, reads, writes: [], invalidates: [], run,
});

const planComplete = check("breakdown.planComplete", "Passes when refinement recorded a complete split plan or an explicit no-split decision, with valid references and parent-criterion coverage.", ({ context }) => {
  const plan = parseBreakdownMarkdown(context.item!.breakdown);
  if (!plan) return fail("Work breakdown plan is missing or invalid: write it with breakdown.setPlan");
  const errors = validationErrors(plan, context.item!.criteria, context.repository!.systemLabels);
  return errors.length === 0 ? pass() : fail(`Work breakdown plan is incomplete: ${errors.join("; ")}`);
}, ["item", "repository"]);

const reviewed = check("breakdown.reviewed", "Passes only after a reviewer approved the valid breakdown plan; a rejection returns its actionable reason.", ({ context }) => {
  const plan = parseBreakdownMarkdown(context.item!.breakdown);
  if (!plan) return fail("Work breakdown plan is missing or invalid: return to refinement and record it with breakdown.setPlan");
  if (plan.review === "rejected") return fail(`Work breakdown plan was rejected: ${plan.reason ?? "the reviewer did not record a reason"}`);
  const errors = validationErrors(plan, context.item!.criteria, context.repository!.systemLabels);
  if (errors.length > 0) return fail(`Work breakdown plan is incomplete: ${errors.join("; ")}`);
  return plan.review === "approved" ? pass() : fail("Work breakdown plan has not been reviewed: approve it with breakdown.reviewPlan or return it to refinement with an actionable reason");
}, ["item", "repository"]);

const complete = check("breakdown.complete", "Passes only when every approved plan entry has one matching marked child and all parent criteria are covered.", ({ context }) => {
  const item = context.item!;
  const plan = parseBreakdownMarkdown(item.breakdown);
  if (!plan) return fail("Work breakdown plan is missing or invalid");
  if (plan.review === "rejected") return fail(`Work breakdown plan was rejected: ${plan.reason ?? "return it to refinement with an actionable reason"}`);
  const errors = validationErrors(plan, item.criteria, context.repository!.systemLabels);
  if (errors.length > 0) return fail(`Work breakdown plan is incomplete: ${errors.join("; ")}`);
  if (plan.review !== "approved") return fail("Work breakdown plan is not approved");
  if (plan.decision === "no-split") return item.children.length === 0 ? pass() : fail("No-split plan has children; remove the plan or return it to refinement");
  const byEntry = new Map<string, ItemContext["children"]>();
  const problems: string[] = [];
  for (const child of item.children) {
    const marker = child.body ? /<!-- conveyor:breakdown-entry:([A-Za-z0-9][A-Za-z0-9._-]{0,63}) -->/.exec(child.body)?.[1] : undefined;
    if (!marker) problems.push(`child #${child.number} has no breakdown entry marker`);
    else byEntry.set(marker, [...(byEntry.get(marker) ?? []), child]);
  }
  for (const candidate of plan.entries) {
    const matches = byEntry.get(candidate.id) ?? [];
    if (matches.length === 0) { problems.push(`entry ${candidate.id} has no created child`); continue; }
    if (matches.length > 1) { problems.push(`entry ${candidate.id} has multiple marked children`); continue; }
    const child = matches[0]!;
    if (child.title !== candidate.title) problems.push(`entry ${candidate.id} child title does not match`);
    if (!child.body) { problems.push(`entry ${candidate.id} child body is unavailable`); continue; }
    if (!child.body.includes(`<!-- conveyor:child-create:${creationMarker(item.id, candidate.id)} -->`)) problems.push(`entry ${candidate.id} child creation marker does not match`);
    let sections: ReturnType<typeof parseManagedSections>["sections"] | undefined;
    try { sections = parseManagedSections(child.body).sections; } catch { problems.push(`entry ${candidate.id} child has invalid managed sections`); }
    if (sections?.description !== scopeSection(candidate.scope)) problems.push(`entry ${candidate.id} child scope does not match`);
    if (sections?.["acceptance-criteria"] !== renderAcceptanceCriteriaSection(candidate.acceptanceCriteria)) problems.push(`entry ${candidate.id} child acceptance criteria do not match`);
    const systemLabels = (child.labels ?? []).filter((label) => context.repository!.systemLabels.includes(label)).sort();
    if (JSON.stringify(systemLabels) !== JSON.stringify([...candidate.systemLabels].sort())) problems.push(`entry ${candidate.id} child system labels do not match`);
    const expectedDependencies = candidate.dependsOn.flatMap((dependency) => (byEntry.get(dependency) ?? [])[0]?.number ?? []).sort((left, right) => left - right);
    const actualDependencies = [...(child.dependsOn ?? [])].sort((left, right) => left - right);
    if (JSON.stringify(actualDependencies) !== JSON.stringify(expectedDependencies)) problems.push(`entry ${candidate.id} child dependencies do not match`);
  }
  for (const markedEntry of byEntry.keys()) if (!plan.entries.some((candidate) => candidate.id === markedEntry)) problems.push(`child references unknown plan entry ${markedEntry}`);
  return problems.length === 0 ? pass() : fail(`Work breakdown is incomplete: ${problems.join("; ")}`);
}, ["item", "repository"]);

const tool = <I>(name: string, description: string, input: z.ZodType<I>, run: (args: Args<I>, issue: ReturnType<typeof issueOf>) => Promise<unknown>): TaskDefinition<unknown, I, Deps> => ({
  name, kind: "tool", description, reads: [], writes: [], invalidates: ["item"], input, mutating: true,
  async run(args) { return pass(await run(args, issueOf(args.deps))); },
});

const setPlan = tool("breakdown.setPlan", "Record a complete split plan with stable entry IDs or an explicit no-split decision. Replacing a plan always requires fresh review.", planInput, async ({ deps, input }, issue) => {
  if (!input) throw new ToolRequestError("Work breakdown plan input is required.");
  const current = await deps.items.getIssue(deps.repository.address, issue.sourceNumber);
  const errors = validationErrors(input, criteriaOf(issue.body), deps.config.repositories[deps.repository.id]!.systemLabels);
  if (errors.length > 0) throw new ToolRequestError(`Cannot record an incomplete work breakdown plan: ${errors.join("; ")}`);
  const plan: BreakdownPlan = input.decision === "split" ? { decision: "split", entries: input.entries, review: "proposed" } : { decision: "no-split", review: "proposed" };
  await savePlan(deps, issue, current, plan);
  return { decision: plan.decision, review: plan.review };
});

const reviewPlan = tool("breakdown.reviewPlan", "Approve a valid work breakdown plan, or reject it with an actionable reason for refinement. This tool cannot create children.", z.object({ approved: z.boolean(), reason: z.string().trim().min(1).optional() }).strict().superRefine((value, ctx) => {
  if (!value.approved && !value.reason) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A rejection needs an actionable reason", path: ["reason"] });
}), async ({ deps, input }, issue) => {
  const current = await deps.items.getIssue(deps.repository.address, issue.sourceNumber);
  const plan = parseBreakdownPlan(issue.body);
  if (!plan) throw new ToolRequestError("There is no valid work breakdown plan to review.");
  const errors = validationErrors(plan, criteriaOf(issue.body), deps.config.repositories[deps.repository.id]!.systemLabels);
  if (input!.approved && errors.length > 0) throw new ToolRequestError(`The work breakdown plan is incomplete: ${errors.join("; ")}`);
  const afterReview = reviewedPlan(plan, input!.approved ? "approved" : "rejected", input!.reason);
  await savePlan(deps, issue, current, afterReview);
  return { review: afterReview.review };
});

const createChildren = tool("breakdown.createChildren", "Create exactly the approved plan's marked children, copying their title, scope, managed criteria, labels and dependency links without inventing details. Re-running reuses each entry marker.", z.object({}).strict(), async ({ deps, instance }, issue) => {
  const current = await deps.items.getIssue(deps.repository.address, issue.sourceNumber);
  const plan = parseBreakdownPlan(issue.body);
  if (!plan) throw new ToolRequestError("Work breakdown plan is missing or invalid; return to refinement.");
  const errors = validationErrors(plan, criteriaOf(issue.body), deps.config.repositories[deps.repository.id]!.systemLabels);
  if (errors.length > 0) {
    const reason = `Work breakdown plan is incomplete: ${errors.join("; ")}`;
    await savePlan(deps, issue, current, reviewedPlan(plan, "rejected", reason));
    return { decision: plan.decision, returnedToRefinement: true, reason };
  }
  if (plan.review !== "approved") {
    const reason = plan.review === "rejected" ? plan.reason ?? "Work breakdown plan was rejected." : "Work breakdown plan is not approved; complete refinement review.";
    if (plan.review !== "rejected") await savePlan(deps, issue, current, reviewedPlan(plan, "rejected", reason));
    return { decision: plan.decision, returnedToRefinement: true, reason };
  }
  if (plan.decision === "no-split") return { decision: "no-split", children: [] };
  const repository = deps.config.repositories[deps.repository.id]!;
  if (current.labels.includes(deps.config.labels.metadata.noSplit)) {
    const reason = `This item carries the ${deps.config.labels.metadata.noSplit} label and must remain one item.`;
    await savePlan(deps, issue, current, reviewedPlan(plan, "rejected", reason));
    return { decision: "split", returnedToRefinement: true, reason };
  }
  const stage = nextStage(deps, instance.stage);
  const enrollmentLabels = [deps.config.labels.enrollment, deps.config.labels.stageTemplate.replace("{stage}", stage)];
  const stageLabels = new Set(
    deps.config.pipelines[repository.pipeline]!.stages.map((candidate) => deps.config.labels.stageTemplate.replace("{stage}", candidate.id)),
  );
  const created = new Map<string, SourceIssue>();
  for (const candidate of plan.entries) {
    const body = childBody(issue.id, candidate);
    const source = await deps.items.createChildIssue({ address: deps.repository.address, parentNumber: issue.sourceNumber, title: candidate.title, body, labels: candidate.systemLabels });
    persist(deps, source, undefined, { title: candidate.title, body });
    await deps.items.setTitle(deps.repository.address, source.number, candidate.title);
    await updateSection(deps, source.number, "description", scopeSection(candidate.scope));
    await updateSection(deps, source.number, "acceptance-criteria", renderAcceptanceCriteriaSection(candidate.acceptanceCriteria));
    await deps.items.replaceManagedProjectLabels(deps.repository.address, source.number, repository.systemLabels, candidate.systemLabels);
    const refreshed = await deps.items.getIssue(deps.repository.address, source.number);
    const stored = persist(deps, refreshed);
    deps.store.replaceRelationships(stored.id, { parentId: issue.id, siblingOrder: null }, deps.store.listDependencies(stored.id));
    created.set(candidate.id, refreshed);
  }
  for (const candidate of plan.entries) {
    const child = created.get(candidate.id)!;
    const dependencies = candidate.dependsOn.map((id) => created.get(id)!.number);
    await deps.items.setDependencies({ address: deps.repository.address, issueNumber: child.number, blockerNumbers: dependencies });
    await updateSection(deps, child.number, "dependencies", formatDependencies(dependencies.map((number) => ({ number }))));
    const stored = persist(deps, await deps.items.getIssue(deps.repository.address, child.number));
    const blockers = candidate.dependsOn.map((entryId) => {
      const blocker = created.get(entryId);
      if (!blocker) throw new ToolRequestError(`Work breakdown plan entry ${candidate.id} depends on missing entry ${entryId}`);
      return persist(deps, blocker).id;
    });
    deps.store.replaceRelationships(stored.id, { parentId: issue.id, siblingOrder: null }, blockers);
  }
  for (const candidate of plan.entries) {
    const child = created.get(candidate.id)!;
    if (!child.labels.includes(deps.config.labels.enrollment) && !child.labels.some((label) => stageLabels.has(label))) {
      await deps.items.replaceConveyorLabels(deps.repository.address, child.number, enrollmentLabels);
    }
    const refreshed = await deps.items.getIssue(deps.repository.address, child.number);
    persist(deps, refreshed);
    created.set(candidate.id, refreshed);
  }
  return { decision: "split", children: plan.entries.map((candidate) => ({ entryId: candidate.id, number: created.get(candidate.id)!.number })) };
});

export const breakdownGroup = defineGroup("breakdown", [planComplete, reviewed, complete, setPlan, reviewPlan, createChildren]);
