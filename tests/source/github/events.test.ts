import { describe, expect, test } from "bun:test";

import { normalizeGitHubEvent } from "../../../src/source/github/events";

const repository = { full_name: "Owner/My-App" };
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("normalizeGitHubEvent", () => {
  test("an issue change names the issue", () => {
    expect(normalizeGitHubEvent("issues", { action: "labeled", repository, issue: { number: 12, title: "Secret plan" }, label: { name: "conveyor" } }))
      .toEqual({ type: "github.issueUpdated", payload: { repository: "owner/my-app", number: 12, action: "labeled", pullRequest: false } });
  });

  test("a comment on a pull request names the pull request", () => {
    expect(normalizeGitHubEvent("issue_comment", { action: "created", repository, issue: { number: 7, pull_request: { url: "x" } }, comment: { body: "Hi" } }))
      .toEqual({ type: "github.issueUpdated", payload: { repository: "owner/my-app", number: 7, action: "created", pullRequest: true } });
  });

  test("a sub-issue change names both issues of this repository", () => {
    expect(normalizeGitHubEvent("sub_issues", { action: "sub_issue_added", repository, parent_issue: { number: 1 }, parent_issue_repo: repository, sub_issue: { number: 2 }, sub_issue_repo: repository }))
      .toEqual({ type: "github.relationshipChanged", payload: { repository: "owner/my-app", numbers: [1, 2] } });
  });

  test("a sub-issue in another repository is left to that repository", () => {
    expect(normalizeGitHubEvent("sub_issues", { action: "sub_issue_added", repository, parent_issue: { number: 1 }, sub_issue: { number: 7 }, sub_issue_repo: { full_name: "other/repository" } })?.payload)
      .toEqual({ repository: "owner/my-app", numbers: [1] });
  });

  test("a dependency change names the blocked issue and a blocker of this repository", () => {
    expect(normalizeGitHubEvent("issue_dependencies", { action: "blocked_by_added", repository, blocked_issue: { number: 3 }, blocking_issue: { number: 4 }, blocking_issue_repo: repository })?.payload)
      .toEqual({ repository: "owner/my-app", numbers: [3, 4] });
  });

  test("a blocker in another repository is left out", () => {
    expect(normalizeGitHubEvent("issue_dependencies", { action: "blocked_by_added", repository, blocked_issue: { number: 3 }, blocking_issue: { number: 4 }, blocking_issue_repo: { full_name: "other/repository" } })?.payload)
      .toEqual({ repository: "owner/my-app", numbers: [3] });
  });

  test("a pull request change names the pull request and its head", () => {
    expect(normalizeGitHubEvent("pull_request", { action: "synchronize", repository, pull_request: { number: 9, head: { sha: SHA }, body: "Text" } }))
      .toEqual({ type: "github.changeUpdated", payload: { repository: "owner/my-app", number: 9, action: "synchronize", headSha: SHA, merged: false } });
  });

  test("a completed workflow run names the commit and its pull requests", () => {
    expect(normalizeGitHubEvent("workflow_run", { action: "completed", repository, workflow_run: { head_sha: SHA, pull_requests: [{ number: 9 }, { number: 10 }] } }))
      .toEqual({ type: "github.ciUpdated", payload: { repository: "owner/my-app", sha: SHA, pullRequests: [9, 10], completed: true } });
  });

  test("a workflow run in progress is CI progress, not a completion", () => {
    expect(normalizeGitHubEvent("workflow_run", { action: "in_progress", repository, workflow_run: { head_sha: SHA, pull_requests: [] } })?.payload)
      .toMatchObject({ completed: false });
  });

  test("a completed check suite is a CI completion", () => {
    expect(normalizeGitHubEvent("check_suite", { action: "completed", repository, check_suite: { head_sha: SHA, pull_requests: [{ number: 9 }] } }))
      .toEqual({ type: "github.ciUpdated", payload: { repository: "owner/my-app", sha: SHA, pullRequests: [9], completed: true } });
  });

  test("a completed check run is a CI completion of its commit", () => {
    expect(normalizeGitHubEvent("check_run", { action: "completed", repository, check_run: { head_sha: SHA, name: "Tests", pull_requests: [{ number: 9 }] } }))
      .toEqual({ type: "github.ciUpdated", payload: { repository: "owner/my-app", sha: SHA, pullRequests: [9], completed: true } });
  });

  test("a submitted review is a change to its pull request, kept apart from the pull request's own actions", () => {
    expect(normalizeGitHubEvent("pull_request_review", { action: "submitted", repository, pull_request: { number: 9, head: { sha: SHA } }, review: { body: "Looks good" } }))
      .toEqual({ type: "github.changeUpdated", payload: { repository: "owner/my-app", number: 9, action: "review_submitted", headSha: SHA, merged: false } });
  });

  test("a ping confirms the webhook", () => {
    expect(normalizeGitHubEvent("ping", { zen: "Keep it logically awesome.", repository }))
      .toEqual({ type: "github.ping", payload: { repository: "owner/my-app" } });
  });

  test("a type nothing reacts to is not an event", () => {
    expect(normalizeGitHubEvent("deployment_status", { repository, deployment_status: { state: "success" } })).toBeNull();
  });

  test("a delivery without the fields a reaction needs is not an event", () => {
    expect(normalizeGitHubEvent("issues", { action: "opened", repository, issue: {} })).toBeNull();
  });

  test("a delivery without a repository is not an event", () => {
    expect(normalizeGitHubEvent("issues", { action: "opened", issue: { number: 1 } })).toBeNull();
  });
});
