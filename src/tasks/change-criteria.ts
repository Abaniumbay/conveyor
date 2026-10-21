// SHA-bound acceptance-criterion approvals for the `change` group. The approvals table is the
// authority; the checklist in the pull request body is a projection of it, checked only for
// criteria approved at the change's current head.

import { z } from "zod";

import type { CiTestReport } from "../app/ci-provider";
import type { CodeHost } from "../codehost/types";
import { CriterionApprovals, criterionTextHash, isCriterionApprovedAt } from "../engine/review-records";
import { formatAcceptanceCriteria, ManagedSectionError, parseManagedSections } from "../source/github/managed-sections";
import type { ChangeContext } from "./context";
import { fail, InfrastructureError, pass, pending, type TaskArgs, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";
import { criteriaOf } from "./item";

type Deps = TaskDeps;

const criterionInput = z.object({ criterionId: z.string().min(1), headSha: z.string().min(1) }).strict();
type CriterionInput = z.output<typeof criterionInput>;
const oneLine = z.string().refine((value) => value.trim().length > 0 && !/[\r\n]/.test(value), "must be non-empty and one line");
const repositoryFile = z.string().refine((value) => value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."), "must be a safe repository-relative path");
const linkedTest = z.object({ name: oneLine, file: repositoryFile, line: z.number().int().positive().optional(), description: oneLine.optional() }).strict();
const criterionEvidence = z.union([z.object({ criterionId: z.string().min(1), tests: z.array(linkedTest).min(1) }).strict(), z.object({ criterionId: z.string().min(1), manual: z.literal(true) }).strict()]);
const recordEvidenceInput = z.object({ headSha: z.string().min(1).optional(), criteria: z.array(criterionEvidence).min(1).superRefine((entries, context) => { const seen = new Set<string>(); entries.forEach((entry, index) => { if (seen.has(entry.criterionId)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "criterionId"], message: "criterion ids must be unique" }); seen.add(entry.criterionId); }); }) }).strict();
type RecordEvidenceInput = z.output<typeof recordEvidenceInput>;

const NO_CHANGE = "No change request exists yet";

type JunitCase = { name: string; suite: string | null; outcome: "passed" | "skipped" | "failed" | "errored" };
const JUNIT_SIMILAR_LIMIT = 5;

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (entity, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function junitCases(xml: string, path: string): JunitCase[] | { error: string } {
  if (!/<(?:testsuites?|testcase)\b/.test(xml)) return { error: `report ${path} is not JUnit XML` };
  const cases: JunitCase[] = [];
  const matcher = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(matcher)) {
    const attrs = new Map<string, string>();
    for (const attr of match[1]!.matchAll(/([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) attrs.set(attr[1]!, decodeXml(attr[3]!));
    const name = attrs.get("name");
    if (!name) return { error: `report ${path} has a testcase without a name` };
    const body = match[2] ?? "";
    const outcome = /<skipped\b/.test(body) ? "skipped" : /<failure\b/.test(body) ? "failed" : /<error\b/.test(body) ? "errored" : "passed";
    cases.push({ name, suite: attrs.get("classname") ?? null, outcome });
  }
  return cases.length > 0 ? cases : { error: `report ${path} contains no test cases` };
}

function displayJunitCase(test: JunitCase): string { return test.suite ? `${test.suite}#${test.name}` : test.name; }

function similarJunitCases(test: string, cases: JunitCase[]): string {
  const needle = test.toLowerCase();
  const names = [...new Set(cases.map(displayJunitCase).filter((name) => name.toLowerCase().includes(needle) || needle.includes(name.toLowerCase())))].slice(0, JUNIT_SIMILAR_LIMIT);
  return names.length > 0 ? ` Similar report cases: ${names.map((name) => `"${name}"`).join(", ")}.` : " No similar report cases were found.";
}

function matchJunitCase(link: string, cases: JunitCase[]): JunitCase[] {
  const hash = link.indexOf("#");
  if (hash < 0) return cases.filter((test) => test.name === link);
  const suite = link.slice(0, hash);
  const name = link.slice(hash + 1);
  return suite.length > 0 && name.length > 0 ? cases.filter((test) => test.suite === suite && test.name === name) : [];
}

const MALFORMED = (detail: string) => `PR checklist markers are malformed: ${detail}; restore or remove the conveyor managed section`;

function testNameSegments(name: string): string[] {
  const qualified = name.split(/::|#| > /);
  const final = qualified.at(-1)!;
  const qualifiers = qualified.slice(0, -1).flatMap((part) => part.includes("/") ? [] : part.split("."));
  const segments = qualified.length === 1 && !final.includes("/") ? final.split(".") : [...qualifiers, final];
  const names = segments.filter((segment) => segment.length > 0);
  return names.length > 0 ? names : [name];
}

function sourceLineForTest(source: string, name: string): { line: number } | { missing: string } {
  const segments = testNameSegments(name);
  const missing = segments.find((segment) => !source.includes(segment));
  if (missing) return { missing };
  const final = segments.at(-1)!;
  return { line: source.split(/\r?\n/).findIndex((sourceLine) => sourceLine.includes(final)) + 1 };
}

/** The item's criteria with their approval at `headSha` (an approval for another head or other text is none). */
export function criteriaView(deps: Deps, body: string, headSha: string): ChangeContext["criteria"] {
  const approvals = new Map(new CriterionApprovals(deps.store.sqlite()).list(deps.issueId).map((a) => [a.criterionId, a]));
  const evidence = new Map(deps.store.criterionTestEvidence(deps.issueId).map((entry) => [entry.criterionId, entry]));
  const projected = projectedChecklist(body).checked;
  return criteriaOf(deps.store.getIssue(deps.issueId)?.body ?? "").map(({ id, text, manual: criterionManual }) => {
    const approval = approvals.get(id);
    const recorded = evidence.get(id);
    return {
      id,
      manual: recorded?.manual ?? false,
      criterionManual,
      tests: recorded?.tests ?? [],
      recordedHead: recorded?.recordedHead ?? null,
      sourceLinkHead: recorded?.sourceLinkHead ?? null,
      projectedChecked: projected.get(id) ?? false,
      approval: approval && isCriterionApprovedAt(approvals, { id, text }, headSha)
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
function render(deps: Deps, headSha: string | null, host?: CodeHost): { markdown: string } | { error: string } {
  const approvals = new Map(new CriterionApprovals(deps.store.sqlite()).list(deps.issueId).map((a) => [a.criterionId, a]));
  const evidence = new Map(deps.store.criterionTestEvidence(deps.issueId).map((entry) => [entry.criterionId, entry]));
  const criteria = criteriaOf(deps.store.getIssue(deps.issueId)?.body ?? "");
  try {
    return {
      markdown: formatAcceptanceCriteria(criteria.map(({ id, text }) => {
        const recorded = evidence.get(id);
        const detail = recorded?.manual ? "manual" : recorded?.tests.length ? `tests: ${recorded.tests.map((test) => {
          const location = `${test.file}${test.line ? `:${test.line}` : ""}`;
          const linkedLocation = host && test.line && recorded.sourceLinkHead
            ? `[${location}](${host.sourceFileUrl({ address: deps.repository.address, path: test.file, headSha: recorded.sourceLinkHead, line: test.line })})`
            : location;
          return `${test.name} (${linkedLocation}${test.description ? ` — ${test.description}` : ""})`;
        }).join("; ")}` : "no tests linked";
        return { id, text, completed: isCriterionApprovedAt(approvals, { id, text }, headSha), detail };
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
  const rendered = render(deps, live.headSha, host);
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

/** Atomically replaces only the supplied criterion evidence entries. */
export const recordCriterionTests: TaskDefinition<unknown, RecordEvidenceInput, Deps> = {
  name: "change.recordCriterionTests",
  kind: "tool",
  description: "Records tests whose name appears in its file as written, optionally qualified by its class, or a permitted manual designation for item criteria. Before a pull request exists this is an unverified claim; the review gate verifies every linked test at the pull request head. With a pull request, headSha must be its current head and the managed checklist is refreshed.",
  reads: [], writes: [], invalidates: ["change"], mutating: true, journal: false,
  input: recordEvidenceInput,
  async run({ deps, input }: TaskArgs<unknown, RecordEvidenceInput, Deps>) {
    const known = new Map(criteriaOf(deps.store.getIssue(deps.issueId)?.body ?? "").map((criterion) => [criterion.id, criterion]));
    for (const entry of input!.criteria) {
      const criterion = known.get(entry.criterionId);
      if (!criterion) return fail(`Unknown criterion "${entry.criterionId}"; no evidence was recorded`);
      if ("manual" in entry && !criterion.manual) return fail(`Criterion "${entry.criterionId}" is not marked [Manual]; no evidence was recorded`);
    }
    const evidence = (headSha: string | null) => input!.criteria.map((entry) => ({
      criterionId: entry.criterionId, manual: "manual" in entry, tests: "tests" in entry ? entry.tests.map((test) => {
        const recorded: { name: string; file: string; line?: number; description?: string } = { name: test.name, file: test.file };
        if (test.line !== undefined) recorded.line = test.line;
        if (test.description !== undefined) recorded.description = test.description;
        return recorded;
      }) : [],
      recordedHead: headSha, sourceLinkHead: headSha, recordedAt: new Date().toISOString(),
    }));
    const stored = deps.store.getCurrentPullRequest(deps.issueId);
    if (!stored) {
      if (input!.headSha !== undefined) return fail("No change request exists yet; do not supply headSha until one exists");
      deps.store.replaceCriterionTestEvidence(deps.issueId, evidence(null));
      return pass({ headSha: null });
    }
    if (input!.headSha === undefined) return fail("A headSha is required while a change request exists; read change.get and retry");
    const host = deps.codeHost;
    if (!host) throw new Error(`no code host configured for ${deps.issueId}`);
    const live = await host.getChange({ address: deps.repository.address, id: stored.id });
    if (live.headSha !== input!.headSha) return fail(`The change head is ${live.headSha}, not ${input!.headSha}; read change.get and retry`);
    deps.store.replaceCriterionTestEvidence(deps.issueId, evidence(live.headSha));
    const synced = await syncChecklist(host, deps, stored.id);
    return pass(synced.ok ? { headSha: live.headSha } : { headSha: live.headSha, checklist: `Recorded, but the PR checklist could not be updated: ${synced.message}` });
  },
};

/** A deterministic admission gate which also refreshes source lines at the verified head. */
export const criterionTestsVerified: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.criterionTestsVerified",
  kind: "check",
  description: "At implementation exit and before review, requires test evidence for every non-manual criterion and verifies each linked test name exists in its file at the current change head. It refreshes stored display lines and source-link heads only when all links verify.",
  reads: ["item", "change"], writes: [], invalidates: [], refreshesProjection: true,
  async run({ context, deps }: TaskArgs<unknown, unknown, Deps>) {
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    const host = deps.codeHost;
    if (!host) throw new Error(`no code host configured for ${deps.issueId}`);
    const live = await host.getChange({ address: deps.repository.address, id: change.ref.id });
    if (live.headSha !== change.headSha) return fail(`Change head moved from ${change.headSha} to ${live.headSha}; record evidence for the current head`);
    const entries = new Map(deps.store.criterionTestEvidence(deps.issueId).map((entry) => [entry.criterionId, entry]));
    const files = new Map<string, string | null>();
    const gaps: string[] = [];
    const lines = new Map<string, number[]>();
    for (const criterion of context.item!.criteria) {
      if (criterion.manual) continue;
      const entry = entries.get(criterion.id);
      if (!entry) {
        gaps.push(`${criterion.id}: no tests linked`);
        continue;
      }
      if (entry.tests.length === 0) {
        gaps.push(`${criterion.id}: no tests linked`);
        continue;
      }
      const foundLines: number[] = [];
      for (const test of entry.tests) {
        let source = files.get(test.file);
        if (source === undefined) {
          source = await host.readFileAtRevision({ address: deps.repository.address, path: test.file, headSha: live.headSha });
          files.set(test.file, source);
        }
        if (source === null) { gaps.push(`${criterion.id}: file ${test.file} is missing at ${live.headSha}`); continue; }
        const match = sourceLineForTest(source, test.name);
        if ("missing" in match) { gaps.push(`${criterion.id}: test "${match.missing}" must appear in ${test.file} as written at ${live.headSha}`); continue; }
        foundLines.push(match.line);
      }
      if (foundLines.length === entry.tests.length) lines.set(criterion.id, foundLines);
    }
    if (gaps.length > 0) return fail(`Criterion test evidence is incomplete or stale: ${gaps.join("; ")}`);
    deps.store.refreshCriterionTestEvidence(deps.issueId, live.headSha, lines);
    const synced = await syncChecklist(host, deps, change.ref.id);
    return synced.ok ? pass() : fail(`Criterion test evidence was verified, but the PR checklist could not be updated: ${synced.message}`);
  },
};

/** Confirms linked tests executed successfully in head-bound JUnit artifacts when configured. */
export const criterionTestsPassed: TaskDefinition<unknown, unknown, Deps> = {
  name: "change.criterionTestsPassed",
  kind: "check",
  description: "After required CI passes, verifies every linked non-manual criterion test has one exact, passing JUnit case in configured artifacts from the current change head. Without a JUnit locator, retains the source-link verification fallback.",
  observesExternal: true,
  reads: ["item", "change", "ci"], writes: [], invalidates: [],
  async run({ context, deps }: TaskArgs<unknown, unknown, Deps>) {
    const locator = deps.config.repositories[deps.repository.id]?.ci.junit;
    if (!locator) return pass({ fallback: "source-link verification" });
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    const ci = context.ci;
    if (!ci || ci.headSha !== change.headSha || ci.awaitingStart.length > 0 || ci.runs.some((run) => run.state === "queued" || run.state === "running")) {
      return pending("JUnit test report verification is waiting for CI for the current change head");
    }
    const host = deps.codeHost;
    if (!host) throw new Error(`no code host configured for ${deps.issueId}`);
    const live = await host.getChange({ address: deps.repository.address, id: change.ref.id });
    if (live.headSha !== change.headSha) return pending(`Change head moved from ${change.headSha} to ${live.headSha}; waiting for CI for the new head`);
    const provider = deps.ci?.provider();
    if (!provider?.reports) throw new InfrastructureError(`CI provider cannot retrieve configured JUnit reports for ${deps.repository.id}`);
    let reports: CiTestReport[];
    try {
      reports = await provider.reports({ repository: deps.repository.address, changeId: String(change.ref.number ?? change.ref.id), url: change.url }, live.headSha, ci.runs.map((run) => ({ id: run.id, name: run.name, url: run.url, state: run.state, canRerun: run.rerunnable, hasLog: run.hasLog })), locator);
    } catch (error) {
      throw new InfrastructureError(`Could not retrieve configured JUnit reports for ${deps.repository.id}`, { cause: error });
    }
    if (reports.length === 0) return fail(`No JUnit report matched artifact "${locator.artifact}" and path "${locator.path}" for CI head ${live.headSha}`);
    const unreadable = reports.find((report) => report.error !== undefined);
    if (unreadable?.error) return fail(`Configured JUnit report is unusable: ${unreadable.error}`);
    const parsed = reports.map((report) => junitCases(report.content, report.path));
    const malformed = parsed.find((result): result is { error: string } => "error" in result);
    if (malformed) return fail(`Configured JUnit report is unusable: ${malformed.error}`);
    const cases = parsed.flat() as JunitCase[];
    const entries = new Map(deps.store.criterionTestEvidence(deps.issueId).map((entry) => [entry.criterionId, entry]));
    const gaps: string[] = [];
    for (const criterion of context.item!.criteria) {
      if (criterion.manual) continue;
      const links = entries.get(criterion.id)?.tests ?? [];
      if (links.length === 0) { gaps.push(`${criterion.id}: no tests linked`); continue; }
      for (const link of links) {
        const matches = matchJunitCase(link.name, cases);
        if (matches.length === 0) { gaps.push(`${criterion.id}: linked test "${link.name}" did not match a JUnit case.${similarJunitCases(link.name, cases)}`); continue; }
        if (matches.length > 1) { gaps.push(`${criterion.id}: linked test "${link.name}" is ambiguous; it matches ${matches.length} JUnit cases.${link.name.includes("#") ? " Rename the duplicate tests." : " Use suite#test."}${similarJunitCases(link.name, matches)}`); continue; }
        const outcome = matches[0]!.outcome;
        if (outcome !== "passed") gaps.push(`${criterion.id}: linked test "${link.name}" ${outcome === "errored" ? "errored" : `was ${outcome}`} in JUnit`);
      }
    }
    return gaps.length > 0 ? fail(`Criterion test report verification failed: ${gaps.join("; ")}`) : pass({ reports: reports.length, headSha: live.headSha });
  },
};

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
