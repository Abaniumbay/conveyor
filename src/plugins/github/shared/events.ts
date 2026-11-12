// Turns a verified GitHub webhook delivery into the neutral observation Conveyor records for it: the
// facts a reaction needs (numbers, commit, action) and, for an issue delivery, the issue as the
// delivery describes it, so the core applies it without reading GitHub again. Pure, so it is tested
// against recorded payloads.

import type { Observation } from "../../../events/catalogue";
import { deliveredIssueChange } from "../items/delivery-issue";

export interface NormalizeOptions {
  /** The repository address as configured; the delivered issue is identified by it. */
  address?: string;
  /** The enrollment label, which decides who enrolled an issue; without it no issue is delivered. */
  enrollmentLabel?: string;
}

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

/** The observation for a delivery, or null when nothing in Conveyor reacts to its type. */
export function normalizeGitHubEvent(eventType: string, payload: unknown, options: NormalizeOptions = {}): Observation | null {
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
      const delivered = !pullRequest && options.enrollmentLabel !== undefined
        ? deliveredIssueChange(options.address ?? address, eventType, payload, options.enrollmentLabel)
        : null;
      return {
        type: "itemSource.itemChanged",
        payload: { repository, number, action, pullRequest, item: delivered?.issue ?? null, actors: delivered?.actors ?? null },
      };
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
      return { type: "itemSource.relationsChanged", payload: { repository, numbers: [...new Set(numbers)] } };
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
        type: "code.changeUpdated",
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
      const changes = (Array.isArray(run.pull_requests) ? run.pull_requests : []).flatMap((entry) => {
        const number = numberOf(entry);
        return number === null ? [] : [number];
      });
      return { type: "ci.runUpdated", payload: { repository, sha, changes, completed: action === "completed" } };
    }
    case "ping":
      return { type: "itemSource.pinged", payload: { repository } };
    default:
      return null;
  }
}
