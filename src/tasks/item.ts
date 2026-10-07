// The `item` task group: load the work item from the store, four exit-gate checks, and the
// tools an agent uses to change the item. Tool behaviour is what `handleMcp` did for the
// legacy `source.*` tools.

import { z } from "zod";

import type { ItemContext } from "./context";
import { defineGroup, fail, pass, pending, type TaskArgs, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";
import {
  resolveFieldValues,
  resolveIssueType,
  type IssueFieldDefinition,
  type ResolvedFieldValue,
} from "../source/github/issue-metadata";
import {
  formatDependencies,
  parseManagedSections,
  renderAcceptanceCriteriaSection,
  renderRefinementSection,
  upsertManagedSection,
} from "../source/github/managed-sections";

export const acceptanceCriterionInput = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  completed: z.boolean().optional(),
}).strict();

export const setCriteriaInput = z.object({ criteria: z.array(acceptanceCriterionInput) }).strict();
const shortList = z.array(z.string().min(1)).default([]);
export const refinementInput = z.object({
  summary: z.string().trim().min(1),
  inScope: shortList,
  outOfScope: shortList,
  areas: shortList,
  coupling: shortList,
  parallelChildren: shortList,
  risks: shortList,
  verification: shortList,
}).strict();
export const issueTypeInput = z.object({ type: z.string().trim().min(1) }).strict();
const fieldValueInput = z.object({ name: z.string().trim().min(1), value: z.string().trim().min(1) }).strict();
export const issueFieldsInput = z.object({ fields: z.array(fieldValueInput).min(1) }).strict();
export const createChildInput = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  acceptanceCriteria: z.array(acceptanceCriterionInput).min(1),
  systemLabels: z.array(z.string().min(1)).optional(),
  type: issueTypeInput.shape.type.optional(),
  fields: z.array(fieldValueInput).optional(),
  refinement: refinementInput.optional(),
}).strict();
// GitHub rejects issue titles longer than 256 characters.
export const titleInput = z.object({ title: z.string().trim().min(1).max(256) }).strict();
export const commentInput = z.object({ markdown: z.string().min(1) }).strict();
export const systemLabelsInput = z.object({ labels: z.array(z.string().min(1)) }).strict();
export const parentInput = z.object({ parentNumber: z.number().int().positive() }).strict();
export const dependenciesInput = z.object({ issueNumbers: z.array(z.number().int().positive()) }).strict();
const emptyInput = z.object({}).strict();

interface ParsedCriterion { id: string; text: string }

function parseTaskList(markdown: string): ParsedCriterion[] {
  const criteria: ParsedCriterion[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^- \[[ xX]\]\s+(.+?)(?:\s+<!-- conveyor:criterion:([^\s>]+) -->)?$/.exec(line.trim());
    if (match?.[1]) criteria.push({ id: match[2] ?? `criterion-${criteria.length + 1}`, text: match[1] });
  }
  return criteria;
}

function parseHeadingCriteria(body: string): ParsedCriterion[] {
  const lines = body.split(/\r?\n/);
  let headingLevel = 0;
  const section: string[] = [];
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (headingLevel === 0) {
      if (heading && /^acceptance criteria:?$/i.test(heading[2]!)) headingLevel = heading[1]!.length;
      continue;
    }
    if (heading && heading[1]!.length <= headingLevel) break;
    section.push(line);
  }
  return parseTaskList(section.join("\n"));
}

function parseCriteria(body: string): ParsedCriterion[] {
  try {
    const markdown = parseManagedSections(body).sections["acceptance-criteria"];
    const managed = markdown ? parseTaskList(markdown) : [];
    return managed.length > 0 ? managed : parseHeadingCriteria(body);
  } catch {
    return parseHeadingCriteria(body);
  }
}

/** The criteria (id, text, manual flag) in the managed section of an issue body. */
export function criteriaOf(body: string): Array<{ id: string; text: string; manual: boolean }> {
  return parseCriteria(body).map(({ id, text }) => ({ id, text, manual: text.startsWith("[Manual]") }));
}

/** The acceptance-criteria texts in the managed section of an issue body. */
export function criteriaFromBody(body: string): string[] {
  return parseCriteria(body).map((criterion) => criterion.text);
}

type Deps = TaskDeps;
type Args<I = unknown> = TaskArgs<unknown, I, Deps>;

function issueOf(deps: Deps) {
  const issue = deps.store.getIssue(deps.issueId);
  if (!issue) throw new Error(`issue ${deps.issueId} is not stored`);
  return issue;
}

const ownerOf = (address: string) => address.split("/")[0]!;
const sameName = (left: string, right: string) => left.toLocaleLowerCase() === right.toLocaleLowerCase();

/** An organization that does not offer a feature, or a credential that cannot read it, requires nothing. */
async function loadRefinement(deps: Deps, issue: ReturnType<typeof issueOf>): Promise<NonNullable<ItemContext["refinement"]>> {
  const outputs = deps.config.repositories[deps.repository.id]?.refinement;
  const owner = ownerOf(deps.repository.address);
  let typesAvailable = false;
  let definedFields: string[] = [];
  if (outputs?.require.type) {
    typesAvailable = ((await deps.items.listIssueTypes(owner)) ?? []).length > 0;
  }
  if (outputs && outputs.require.fields.length > 0) {
    const defined = (await deps.items.listIssueFields(owner)) ?? [];
    definedFields = outputs.require.fields.flatMap((name) => defined.find((field) => sameName(field.name, name))?.name ?? []);
    if (definedFields.length > 0) {
      try {
        deps.store.setIssueMetadata(issue.id, { fields: await deps.items.getIssueFieldValues(deps.repository.address, issue.sourceNumber) });
      } catch {
        // The stored values (written by item.setFields) stand in when the live read fails.
      }
    }
  }
  const stored = deps.store.getIssue(issue.id)!.metadata;
  let section = false;
  try {
    section = (parseManagedSections(issue.body).sections.refinement ?? "").trim().length > 0;
  } catch {
    section = false;
  }
  return { type: stored.type, typesAvailable, fields: stored.fields, definedFields, section };
}

const load: TaskDefinition<unknown, unknown, Deps> = {
  name: "item.load",
  kind: "load",
  description: "Loads the stored issue with its acceptance criteria, children, dependencies, system labels and refinement outputs (type, fields, section).",
  reads: [],
  writes: ["item"],
  invalidates: [],
  async run({ deps }: Args) {
    const { store, config, repository } = deps;
    const issue = issueOf(deps);
    const systemLabels = config.repositories[repository.id]?.systemLabels ?? [];
    const children = store.listChildren(issue.id).flatMap(({ issueId }) => {
      const child = store.getIssue(issueId);
      if (!child) return [];
      return [{
        id: child.id,
        number: child.sourceNumber,
        state: child.projectedState === "done" ? "done" : child.sourceState,
        enrolled: child.labels.includes(config.labels.enrollment),
        hasCriteria: parseCriteria(child.body).length > 0,
        hasChildren: store.listChildren(child.id).length > 0,
      }];
    });
    const dependencies = store.listDependencies(issue.id).flatMap((blockerId) => {
      const blocker = store.getIssue(blockerId);
      if (!blocker) return [];
      // The scheduler's rule: a dependency is satisfied when closed or done.
      return [{ id: blocker.id, number: blocker.sourceNumber, satisfied: blocker.sourceState === "closed" || blocker.projectedState === "done" }];
    });
    const item: ItemContext = {
      id: issue.id,
      number: issue.sourceNumber,
      title: issue.title,
      url: issue.sourceUrl,
      labels: issue.labels,
      state: issue.sourceState,
      criteria: criteriaOf(issue.body),
      children,
      dependencies: [...dependencies].sort((a, b) => a.id.localeCompare(b.id)),
      systemLabels: issue.labels.filter((label) => systemLabels.includes(label)),
      refinement: await loadRefinement(deps, issue),
    };
    return pass(item);
  },
};

const check = (
  name: string,
  description: string,
  run: TaskDefinition<unknown, unknown, Deps>["run"],
  extra: Partial<TaskDefinition<unknown, unknown, Deps>> = {},
): TaskDefinition<unknown, unknown, Deps> => ({
  name, kind: "check", description, reads: ["item", "repository"], writes: [], invalidates: [], run, ...extra,
});

const criteriaDefined = check(
  "item.criteriaDefined",
  "Passes when the item has at least one acceptance criterion, or has children that carry the work.",
  ({ context }) => {
    const item = context.item!;
    if (item.criteria.length > 0 || item.children.length > 0) return pass();
    return fail("Acceptance criteria are missing: add at least one criterion to the managed section");
  },
);

const labelsValid = check(
  "item.labelsValid",
  "Passes when the repository configures no system labels or the item has at least one of them (the loaded labels are already limited to configured ones).",
  ({ context }) => {
    const item = context.item!;
    const configured = context.repository!.systemLabels;
    if (configured.length === 0) return pass();
    if (item.systemLabels.length === 0) return fail(`System label is missing: add at least one of ${configured.join(", ")}`);
    return pass();
  },
);

const childrenValid = check(
  "item.childrenValid",
  "Passes when every child is enrolled, open or done, and has acceptance criteria or children of its own (and when there are no children).",
  ({ context }) => {
    const problems = context.item!.children.flatMap((child) => {
      if (!child.enrolled) return [`#${child.number} is not enrolled`];
      if (child.state !== "open" && child.state !== "done") return [`#${child.number} is ${child.state} (it must be open or done)`];
      if (!child.hasCriteria && !child.hasChildren) return [`#${child.number} has no acceptance criteria`];
      return [];
    });
    return problems.length === 0 ? pass() : fail(`Children are not ready: ${problems.join("; ")}`);
  },
);

const refinementComplete = check(
  "item.refinementComplete",
  "Passes when every output the repository requires of refinement (issue type, named issue fields, the Refinement section) is filled, ignoring what the owner's organization does not offer; the message names what is missing.",
  ({ context }) => {
    const required = context.repository!.refinement?.require;
    const refinement = context.item!.refinement;
    if (!required || !refinement) return pass();
    const has = (name: string) => Object.entries(refinement.fields).some(([field, value]) => sameName(field, name) && value.trim().length > 0);
    const missing = [
      ...(required.type && refinement.typesAvailable && !refinement.type ? ["issue type (set it with item.setType)"] : []),
      ...required.fields
        .filter((name) => refinement.definedFields.some((defined) => sameName(defined, name)) && !has(name))
        .map((name) => `issue field ${name} (set it with item.setFields)`),
      ...(required.section && !refinement.section ? ["Refinement section (write it with item.setRefinement)"] : []),
    ];
    return missing.length === 0 ? pass() : fail(`Refinement outputs are missing: ${missing.join("; ")}`);
  },
);

const dependenciesMet = check(
  "item.dependenciesMet",
  "Pending while any dependency is neither closed nor done; the message lists them.",
  ({ context }) => {
    const waiting = context.item!.dependencies.filter((dependency) => !dependency.satisfied);
    if (waiting.length === 0) return pass();
    return pending(`Waiting for dependencies: ${waiting.map((dependency) => `#${dependency.number}`).join(", ")}`);
  },
  { defaultWait: { timeoutMs: null, pollMs: 5 * 60_000 } },
);

const tool = <I>(
  name: string,
  description: string,
  input: z.ZodType<I>,
  mutating: boolean,
  run: (args: Args<I>, issue: ReturnType<typeof issueOf>) => Promise<unknown>,
): TaskDefinition<unknown, I, Deps> => ({
  name,
  kind: "tool",
  description,
  reads: [],
  writes: [],
  invalidates: mutating ? ["item"] : [],
  input,
  ...(mutating ? { mutating: true } : {}),
  async run(args) {
    return pass(await run(args, issueOf(args.deps)));
  },
});

const ACCEPTED = { accepted: true };
const normalise = (criterion: z.infer<typeof acceptanceCriterionInput>) => ({
  id: criterion.id, text: criterion.text, completed: criterion.completed === true,
});

const get = tool("item.get", "Read the latest source state of the current issue.", emptyInput, false,
  ({ deps }, issue) => deps.items.getIssue(deps.repository.address, issue.sourceNumber));

const guidance = tool("item.guidance", "Read source-specific agent guidance.", emptyInput, false,
  async ({ deps }) => deps.sourceGuidance);

const LIST_BODY_CHARS = 2000;

const listOpen = tool(
  "item.listOpen",
  "List the repository's other open Conveyor items (number, title, stage, state, parent, dependencies, work branch when one exists, and the start of the body), to find work that will change the same files as the current issue. A branch can be compared with the base in the workspace.",
  emptyInput, false,
  async ({ deps }, current) => {
    const { store, config } = deps;
    const numberOf = (id: string | null | undefined) => (id ? store.getIssue(id)?.sourceNumber ?? null : null);
    const items = store.listIssues(current.repositoryId)
      .filter((issue) => issue.id !== current.id && issue.sourceState === "open" && issue.projectedState !== "done"
        && issue.labels.includes(config.labels.enrollment))
      .sort((left, right) => left.sourceNumber - right.sourceNumber)
      .map((issue) => ({
        number: issue.sourceNumber,
        title: issue.title,
        stage: issue.projectedStage,
        state: issue.projectedState,
        parentNumber: numberOf(issue.parentId),
        dependsOn: store.listDependencies(issue.id).flatMap((id) => numberOf(id) ?? []),
        branch: store.getActiveWorkspace(issue.id)?.branch ?? null,
        body: issue.body.length > LIST_BODY_CHARS ? `${issue.body.slice(0, LIST_BODY_CHARS)}…` : issue.body,
      }));
    return { items };
  });

const comment = tool("item.comment", "Add a Markdown comment to the current issue.", commentInput, true,
  async ({ deps, input }, issue) => ({
    commentId: await deps.items.addComment(deps.repository.address, issue.sourceNumber, input!.markdown),
  }));

const setCriteria = tool("item.setCriteria", "Replace acceptance criteria on the current issue.", setCriteriaInput, true,
  async ({ deps, input }, issue) => {
    const address = deps.repository.address;
    const current = await deps.items.getIssue(address, issue.sourceNumber);
    const updated = await deps.items.updateManagedSection({
      address,
      issueNumber: issue.sourceNumber,
      section: "acceptance-criteria",
      markdown: renderAcceptanceCriteriaSection(input!.criteria.map(normalise)),
      expectedRevision: deps.items.managedRevision(current.body),
    });
    return { revision: deps.items.managedRevision(updated.body) };
  });

const setTitle = tool("item.setTitle",
  "Replace the current issue's title so it states the refined scope.",
  titleInput, true,
  async ({ deps, input }, issue) => {
    await deps.items.setTitle(deps.repository.address, issue.sourceNumber, input!.title);
    return { title: input!.title };
  });

const setSystemLabels = tool("item.setSystemLabels",
  "Replace the issue's configured system-area labels while preserving workflow and unmanaged labels.",
  systemLabelsInput, true,
  async ({ deps, input }, issue) => {
    const configured = deps.config.repositories[deps.repository.id]!.systemLabels;
    await deps.items.replaceManagedProjectLabels(
      deps.repository.address,
      issue.sourceNumber,
      configured,
      input!.labels.filter((label) => configured.includes(label)),
    );
    return ACCEPTED;
  });

const setParent = tool("item.setParent", "Set the parent of the current issue.", parentInput, true,
  async ({ deps, input }, issue) => {
    await deps.items.setParent({
      address: deps.repository.address,
      childNumber: issue.sourceNumber,
      parentNumber: input!.parentNumber,
    });
    return ACCEPTED;
  });

const setDependencies = tool("item.setDependencies", "Replace dependencies of the current issue.", dependenciesInput, true,
  async ({ deps, input }, issue) => {
    const address = deps.repository.address;
    await deps.items.setDependencies({ address, issueNumber: issue.sourceNumber, blockerNumbers: input!.issueNumbers });
    const current = await deps.items.getIssue(address, issue.sourceNumber);
    await deps.items.updateManagedSection({
      address,
      issueNumber: issue.sourceNumber,
      section: "dependencies",
      markdown: formatDependencies(input!.issueNumbers.map((number) => ({ number }))),
      expectedRevision: deps.items.managedRevision(current.body),
    });
    return ACCEPTED;
  });

interface MetadataPlan {
  type?: string;
  fields: ResolvedFieldValue[];
  /** What the organization does not offer, so the write was skipped rather than failed. */
  unavailable: string[];
}

/** Validate a type and field values against what the owner defines, before anything is written. */
async function planMetadata(deps: Deps, input: { type?: string | undefined; fields?: Array<{ name: string; value: string }> | undefined }): Promise<MetadataPlan> {
  const plan: MetadataPlan = { fields: [], unavailable: [] };
  const owner = ownerOf(deps.repository.address);
  if (input.type !== undefined) {
    const types = await deps.items.listIssueTypes(owner);
    if (types === null || types.length === 0) plan.unavailable.push(`issue types are not available for ${owner}`);
    else plan.type = resolveIssueType(types, input.type);
  }
  if (input.fields && input.fields.length > 0) {
    const configured = deps.config.repositories[deps.repository.id]!.refinement.fields;
    const defined: IssueFieldDefinition[] | null = await deps.items.listIssueFields(owner);
    if (configured.length > 0 && (defined === null || defined.length === 0)) {
      // Still reject a field this repository does not allow, even when the owner offers none.
      resolveFieldValues([], configured, input.fields.filter((field) => !configured.some((name) => sameName(name, field.name))));
      plan.unavailable.push(`issue fields are not available for ${owner}`);
    } else plan.fields = resolveFieldValues(defined ?? [], configured, input.fields);
  }
  return plan;
}

const setType = tool("item.setType",
  "Set the current issue's type (Bug for wrong existing behaviour, Feature for a new capability, Task otherwise). The value must be a type the repository owner's organization defines; an owner without types reports it as unavailable.",
  issueTypeInput, true,
  async ({ deps, input }, issue) => {
    const plan = await planMetadata(deps, { type: input!.type });
    if (plan.type === undefined) return { unavailable: true, reason: plan.unavailable.join("; ") };
    await deps.items.setIssueType(deps.repository.address, issue.sourceNumber, plan.type);
    deps.store.setIssueMetadata(issue.id, { type: plan.type });
    return { type: plan.type };
  });

const setFields = tool("item.setFields",
  "Set organization issue-field values (Effort reflects the refined scope; Priority only when the issue states one) on the current issue. Only fields named in the repository configuration can be written; single-select values must be one of the field's options and dates use YYYY-MM-DD.",
  issueFieldsInput, true,
  async ({ deps, input }, issue) => {
    const plan = await planMetadata(deps, { fields: input!.fields });
    if (plan.fields.length === 0) return { unavailable: true, reason: plan.unavailable.join("; ") };
    await deps.items.setIssueFieldValues(deps.repository.address, issue.sourceNumber, plan.fields);
    const fields = Object.fromEntries(plan.fields.map(({ name, value }) => [name, value]));
    deps.store.setIssueMetadata(issue.id, { fields });
    return { fields };
  });

const setRefinement = tool("item.setRefinement",
  "Write the managed Refinement section of the issue body: summary, scope, areas and files, coupling and how it was resolved, parallel children (roll-up parents), risks, and verification. Replaces only that section.",
  refinementInput, true,
  async ({ deps, input }, issue) => {
    const address = deps.repository.address;
    const current = await deps.items.getIssue(address, issue.sourceNumber);
    const updated = await deps.items.updateManagedSection({
      address,
      issueNumber: issue.sourceNumber,
      section: "refinement",
      markdown: renderRefinementSection(input!),
      expectedRevision: deps.items.managedRevision(current.body),
    });
    return { revision: deps.items.managedRevision(updated.body) };
  });

const createChild = tool("item.createChild",
  "Atomically create a child issue with its self-contained body, managed acceptance criteria, optional Refinement section, issue type, issue fields and configured system labels. Everything is validated before the child is created.",
  createChildInput, true,
  async ({ deps, input, instance }, issue) => {
    const repository = deps.config.repositories[deps.repository.id]!;
    const stages = deps.config.pipelines[repository.pipeline]!.stages;
    const currentIndex = stages.findIndex((stage) => stage.id === instance.stage);
    const nextStage = stages[currentIndex + 1]?.id ?? stages[currentIndex]?.id;
    const systemLabels = (input!.systemLabels ?? []).filter((label) => repository.systemLabels.includes(label));
    const plan = await planMetadata(deps, { type: input!.type, fields: input!.fields });
    let body = upsertManagedSection(
      input!.body,
      "acceptance-criteria",
      renderAcceptanceCriteriaSection(input!.acceptanceCriteria.map(normalise)),
      parseManagedSections(input!.body).revision,
    );
    if (input!.refinement) {
      body = upsertManagedSection(body, "refinement", renderRefinementSection(input!.refinement), parseManagedSections(body).revision);
    }
    const child = await deps.items.createChildIssue({
      address: deps.repository.address,
      parentNumber: issue.sourceNumber,
      title: input!.title,
      body,
      labels: [
        deps.config.labels.enrollment,
        ...(nextStage ? [deps.config.labels.stageTemplate.replace("{stage}", nextStage)] : []),
        ...systemLabels,
      ],
      ...(plan.type ? { type: plan.type } : {}),
      ...(plan.fields.length > 0 ? { fields: plan.fields } : {}),
    });
    return {
      ...child,
      ...(plan.type ? { type: plan.type } : {}),
      ...(plan.fields.length > 0 ? { fields: Object.fromEntries(plan.fields.map(({ name, value }) => [name, value])) } : {}),
      ...(plan.unavailable.length > 0 ? { unavailable: plan.unavailable } : {}),
    };
  });

export const itemGroup = defineGroup("item", [
  load, criteriaDefined, labelsValid, childrenValid, refinementComplete, dependenciesMet,
  get, guidance, listOpen, comment, setCriteria, setTitle, setSystemLabels, setParent, setDependencies,
  setType, setFields, setRefinement, createChild,
]);
