// What an issue delivery says about the issue: its full current state, and who made the change it
// reports. Conveyor applies that instead of reading the issue and its history from GitHub again.

import { z } from "zod";

import type { DeliveredActors } from "../../core/reconciler";
import type { SourceEventActor, SourceIssue } from "../types";
import { sourceIssue } from "./adapter";

const issueSchema = z.object({
  id: z.number(),
  number: z.number().int().positive(),
  html_url: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().nullable().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() }).loose()])),
  updated_at: z.string(),
  type: z.object({ name: z.string() }).loose().nullable().optional(),
  pull_request: z.unknown().optional(),
}).loose();

const deliverySchema = z.object({
  action: z.string(),
  issue: issueSchema,
  sender: z.object({ login: z.string() }).loose().nullable().optional(),
  label: z.object({ name: z.string() }).loose().nullable().optional(),
  changes: z.object({ title: z.unknown().optional(), body: z.unknown().optional() }).loose().nullable().optional(),
}).loose();

/** Issue actions that change neither the enrollment label nor the title or body. */
const NEUTRAL_ISSUE_ACTIONS = new Set([
  "unlabeled", "closed", "reopened", "assigned", "unassigned", "milestoned", "demilestoned",
  "typed", "untyped", "pinned", "unpinned", "locked", "unlocked",
]);

/**
 * The issue an `issues` or `issue_comment` delivery carries, and who made the change. Null when the
 * delivery cannot stand in for a read: a pull request, a transfer or deletion, or an unknown action.
 */
export function deliveredIssueChange(address: string, eventType: string, payload: unknown, enrollmentLabel: string): { issue: SourceIssue; actors: DeliveredActors } | null {
  const parsed = deliverySchema.safeParse(payload);
  if (!parsed.success || parsed.data.issue.pull_request !== undefined) return null;
  const { action, issue, sender, label, changes } = parsed.data;
  const actor: SourceEventActor = { login: sender?.login ?? null };
  const unchanged: DeliveredActors = { enrollment: "unchanged", title: "unchanged", body: "unchanged" };
  let actors: DeliveredActors;
  if (eventType === "issue_comment") {
    // A comment changes nothing on the issue it is on.
    actors = unchanged;
  } else if (eventType !== "issues") {
    return null;
  } else if (action === "opened") {
    actors = { enrollment: actor, title: actor, body: actor };
  } else if (action === "labeled") {
    actors = { ...unchanged, enrollment: label?.name === enrollmentLabel ? actor : "unchanged" };
  } else if (action === "edited") {
    actors = { ...unchanged, title: changes?.title !== undefined ? actor : "unchanged", body: changes?.body !== undefined ? actor : "unchanged" };
  } else if (NEUTRAL_ISSUE_ACTIONS.has(action)) {
    actors = unchanged;
  } else {
    return null;
  }
  return {
    issue: sourceIssue(address, {
      id: issue.id,
      number: issue.number,
      html_url: issue.html_url,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      state_reason: issue.state_reason ?? null,
      labels: issue.labels.map((entry) => (typeof entry === "string" ? entry : { name: entry.name })),
      updated_at: issue.updated_at,
      ...(issue.type !== undefined ? { type: issue.type === null ? null : { name: issue.type.name } } : {}),
    }),
    actors,
  };
}
