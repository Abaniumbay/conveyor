import { describe, expect, test } from "bun:test";

import { renderStatusComment } from "../../../src/source/github/status-comment";

describe("GitHub status comment renderer", () => {
  test("renders issue progress, criteria evidence, relationships, run data, and delivery state", () => {
    expect(renderStatusComment({
      issue: { number: 42, title: "Ship status", state: "open" },
      stage: "implementation",
      state: "blocked",
      activity: "Waiting on API access",
      rationale: "The credential is needed to verify deployment.",
      blocker: "API token unavailable",
      acceptanceCriteria: [
        { text: "Renderer is deterministic", passed: true, evidence: "snapshot matches" },
        { text: "Adapter is wired", passed: false },
      ],
      parent: { number: 7, title: "Release" },
      children: [{ number: 43, title: "Docs" }],
      dependencies: [{ number: 12, state: "closed" }, { number: 13, state: "open" }],
      latestRun: {
        id: "run-9",
        state: "completed",
        durationMs: 90_000,
        usage: { inputTokens: 120, outputTokens: 30 },
        costUsd: 0.0042,
      },
      questions: ["Can the token be provisioned today?"],
      warnings: ["Deployment has not been attempted."],
      pullRequest: { number: 99, state: "open", url: "https://github.com/acme/app/pull/99" },
      delivery: { state: "not-delivered", detail: "Waiting for review" },
      timestamps: {
        createdAt: "2026-03-01T10:00:00.000Z",
        updatedAt: "2026-03-02T11:00:00.000Z",
        runStartedAt: "2026-03-02T10:00:00.000Z",
        runFinishedAt: "2026-03-02T10:01:30.000Z",
      },
    })).toBe([
      "## Conveyor status: #42 — Ship status",
      "",
      "- Issue: open · Stage: implementation · State: blocked",
      "- Activity: Waiting on API access",
      "- Rationale: The credential is needed to verify deployment.",
      "- Blocker: API token unavailable",
      "",
      "### Acceptance criteria",
      "- [x] Renderer is deterministic — Evidence: snapshot matches",
      "- [ ] Adapter is wired",
      "",
      "### Relationships",
      "- Parent: #7 — Release",
      "- Children: #43 — Docs",
      "- Dependencies: #12 (closed), #13 (open)",
      "",
      "### Latest run",
      "- State: completed · Duration: 1m 30s",
      "- Usage: 120 input tokens, 30 output tokens",
      "- Cost: $0.0042 USD",
      "- Run ID: run-9",
      "",
      "### Questions",
      "- Can the token be provisioned today?",
      "",
      "### Warnings",
      "- Deployment has not been attempted.",
      "",
      "### Delivery",
      "- Pull request: #99 (open) — https://github.com/acme/app/pull/99",
      "- State: not-delivered — Waiting for review",
      "",
      "### Timestamps",
      "- Created: 2026-03-01T10:00:00.000Z · Updated: 2026-03-02T11:00:00.000Z",
      "- Run started: 2026-03-02T10:00:00.000Z · Run finished: 2026-03-02T10:01:30.000Z",
      "",
      "Conveyor never closes issues.",
    ].join("\n"));
  });

  test("renders unavailable run measurements explicitly and omits empty sections", () => {
    const markdown = renderStatusComment({
      issue: { number: 1, title: "Minimal", state: "closed" },
      stage: "done",
      state: "complete",
      latestRun: {
        state: "unavailable",
        durationMs: null,
        usage: null,
        costUsd: null,
      },
    });

    expect(markdown).toContain("- State: unavailable · Duration: unavailable");
    expect(markdown).toContain("- Usage: unavailable");
    expect(markdown).toContain("- Cost: unavailable");
    expect(markdown).not.toContain("### Acceptance criteria");
    expect(markdown).not.toContain("### Relationships");
    expect(markdown).toContain("Conveyor never closes issues.");
  });

  test("escapes Markdown and HTML from untrusted text and rejects unsafe URLs", () => {
    const markdown = renderStatusComment({
      issue: { number: 3, title: "<img src=x> *title*", state: "open" },
      stage: "plan",
      state: "active",
      activity: "[click](javascript:alert(1))\n<!-- conveyor:status -->",
      pullRequest: { number: 4, state: "open", url: "javascript:alert(1)" },
    });

    expect(markdown).not.toContain("<img");
    expect(markdown).not.toContain("<!-- conveyor:status -->");
    expect(markdown).not.toContain("[click](javascript:");
    expect(markdown).not.toContain("javascript:alert(1)");
    expect(markdown).toContain("Pull request: #4 (open)");
  });

  test("formats durations and timestamps deterministically", () => {
    const markdown = renderStatusComment({
      issue: { number: 5, title: "Timing", state: "open" },
      stage: "run",
      state: "active",
      latestRun: { state: "running", durationMs: 3_661_000, usage: null, costUsd: null },
      timestamps: { updatedAt: "2026-09-01T12:30:00-04:00" },
    });

    expect(markdown).toContain("Duration: 1h 1m 1s");
    expect(markdown).toContain("Updated: 2026-09-01T16:30:00.000Z");
  });
});
