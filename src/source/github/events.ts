// Turns a verified GitHub webhook delivery into the event Conveyor records for it: only the facts
// a reaction needs (numbers, commit, action), never the delivery's text. Pure, so it is tested
// against recorded payloads.

import type { EventPayload } from "../../events/catalogue";

export type NormalizedGitHubEvent =
  | { type: "github.issueUpdated"; payload: EventPayload<"github.issueUpdated"> }
  | { type: "github.relationshipChanged"; payload: EventPayload<"github.relationshipChanged"> }
  | { type: "github.changeUpdated"; payload: EventPayload<"github.changeUpdated"> }
  | { type: "github.ciUpdated"; payload: EventPayload<"github.ciUpdated"> }
  | { type: "github.ping"; payload: EventPayload<"github.ping"> };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

const text = (value: unknown, max = 100): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;

const numberOf = (value: unknown): number | null => positive(record(value).number);

/** Whether a repository object in the payload names `address` (an absent one means the delivery's own). */
const sameRepository = (value: unknown, address: string): boolean => {
  const name = record(value).full_name;
  return typeof name !== "string" || name.toLowerCase() === address.toLowerCase();
};

/** The event for a delivery, or null when nothing in Conveyor reacts to its type. */
export function normalizeGitHubEvent(eventType: string, payload: unknown): NormalizedGitHubEvent | null {
  const body = record(payload);
  const address = text(record(body.repository).full_name, 300);
  if (!address) return null;
  const repository = address.toLowerCase();
  const action = text(body.action) ?? "";
  switch (eventType) {
    case "issues":
    case "issue_comment": {
      const number = numberOf(body.issue);
      if (number === null) return null;
      // A comment on a pull request arrives as an issue_comment whose issue is the pull request.
      const pullRequest = record(body.issue).pull_request !== undefined;
      return { type: "github.issueUpdated", payload: { repository, number, action, pullRequest } };
    }
    case "sub_issues":
    case "issue_dependencies": {
      const pairs: Array<[unknown, unknown]> = eventType === "sub_issues"
        ? [[body.parent_issue, body.parent_issue_repo], [body.sub_issue, body.sub_issue_repo]]
        : [[body.blocked_issue, undefined], [body.blocking_issue, body.blocking_issue_repo]];
      // An issue in another repository is that repository's to reconcile.
      const numbers = pairs.flatMap(([issue, issueRepository]) => {
        const number = numberOf(issue);
        return number !== null && sameRepository(issueRepository, address) ? [number] : [];
      });
      return { type: "github.relationshipChanged", payload: { repository, numbers: [...new Set(numbers)] } };
    }
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment":
    case "pull_request_review_thread": {
      const pullRequest = record(body.pull_request);
      const number = positive(pullRequest.number);
      if (number === null) return null;
      // A review's action (submitted, resolved) is kept apart from the pull request's own actions.
      const changeAction = eventType === "pull_request" ? action : `${eventType.slice("pull_request_".length)}_${action}`;
      return {
        type: "github.changeUpdated",
        payload: {
          repository,
          number,
          action: changeAction,
          headSha: text(record(pullRequest.head).sha),
          merged: eventType === "pull_request" && record(pullRequest).merged === true,
        },
      };
    }
    case "workflow_run":
    case "check_suite":
    case "check_run": {
      const run = record(body[eventType]);
      const sha = text(run.head_sha);
      if (!sha) return null;
      const pullRequests = (Array.isArray(run.pull_requests) ? run.pull_requests : []).flatMap((entry) => {
        const number = numberOf(entry);
        return number === null ? [] : [number];
      });
      return { type: "github.ciUpdated", payload: { repository, sha, pullRequests, completed: action === "completed" } };
    }
    case "ping":
      return { type: "github.ping", payload: { repository } };
    default:
      return null;
  }
}
