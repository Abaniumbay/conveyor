import { describe, expect, test } from "bun:test";

import { deliveredIssueChange } from "../../../src/source/github/delivery-issue";

const issue = (overrides: Record<string, unknown> = {}) => ({
  id: 1001, number: 12, html_url: "https://github.com/owner/my-app/issues/12", title: "Title", body: "Body", state: "open",
  state_reason: null, labels: [{ name: "conveyor" }, { name: "conveyor:refinement" }], updated_at: "2026-10-17T10:00:00Z", ...overrides,
});
const sender = { login: "maintainer" };
const change = (eventType: string, payload: Record<string, unknown>) => deliveredIssueChange("owner/my-app", eventType, { sender, ...payload }, "conveyor");

describe("deliveredIssueChange", () => {
  test("carries the issue's current state", () => {
    expect(change("issues", { action: "closed", issue: issue({ state: "closed", state_reason: "completed" }) })?.issue).toEqual({
      id: "github:owner/my-app#12", number: 12, url: "https://github.com/owner/my-app/issues/12", title: "Title", body: "Body",
      state: "closed", stateReason: "completed", labels: ["conveyor", "conveyor:refinement"], updatedAt: "2026-10-17T10:00:00Z",
    });
  });

  test("the enrollment label added: its sender enrolled the issue", () => {
    expect(change("issues", { action: "labeled", issue: issue(), label: { name: "conveyor" } })?.actors)
      .toEqual({ enrollment: sender, title: "unchanged", body: "unchanged" });
  });

  test("another label added changes neither enrollment nor text", () => {
    expect(change("issues", { action: "labeled", issue: issue(), label: { name: "backend" } })?.actors)
      .toEqual({ enrollment: "unchanged", title: "unchanged", body: "unchanged" });
  });

  test("an edited title: its sender wrote it", () => {
    expect(change("issues", { action: "edited", issue: issue(), changes: { title: { from: "Old" } } })?.actors)
      .toEqual({ enrollment: "unchanged", title: sender, body: "unchanged" });
  });

  test("an edited body: its sender wrote it", () => {
    expect(change("issues", { action: "edited", issue: issue(), changes: { body: { from: "Old" } } })?.actors)
      .toEqual({ enrollment: "unchanged", title: "unchanged", body: sender });
  });

  test("an opened issue: its sender wrote everything", () => {
    expect(change("issues", { action: "opened", issue: issue() })?.actors).toEqual({ enrollment: sender, title: sender, body: sender });
  });

  test("a comment changes nothing on the issue", () => {
    expect(change("issue_comment", { action: "created", issue: issue(), comment: { id: 1, body: "Hi" } })?.actors)
      .toEqual({ enrollment: "unchanged", title: "unchanged", body: "unchanged" });
  });

  test("a pull request cannot stand in for an issue read", () => {
    expect(change("issue_comment", { action: "created", issue: issue({ pull_request: { url: "x" } }) })).toBeNull();
  });

  test("a transfer cannot stand in for an issue read", () => {
    expect(change("issues", { action: "transferred", issue: issue() })).toBeNull();
  });

  test("a delivery without the full issue cannot stand in for an issue read", () => {
    expect(change("issues", { action: "labeled", issue: { number: 12 } })).toBeNull();
  });
});
