import { describe, expect, test } from "bun:test";

import { evaluateIssueState } from "../../src/core/issue-state";

const labels = {
  enrollment: "conveyor",
  stageTemplate: "conveyor:{stage}",
  states: {
    done: "conveyor:done",
    blocked: "conveyor:blocked",
    rejected: "conveyor:reject",
    waiting: "conveyor:waiting",
    "needs-input": "conveyor:needs-input",
    "needs-intervention": "conveyor:needs-intervention",
  },
  metadata: {
    closable: "conveyor:closable",
    orderTemplate: "conveyor:order:{number}",
  },
};

const stages = ["refinement", "implementation", "review", "deploy", "verify"];

describe("evaluateIssueState", () => {
  test("fully offboards an issue with no Conveyor labels", () => {
    expect(
      evaluateIssueState({
        sourceState: "open",
        sourceLabels: ["backend"],
        labels,
        stages,
        expectedPostMergeClosure: false,
      }),
    ).toEqual({
      mode: "offboarded",
      visible: false,
      eligible: false,
      stage: null,
      state: null,
      warnings: [],
    });
  });

  test("shows a labeled issue without the base label as paused", () => {
    expect(
      evaluateIssueState({
        sourceState: "open",
        sourceLabels: ["conveyor:implementation"],
        labels,
        stages,
        expectedPostMergeClosure: false,
      }),
    ).toMatchObject({
      mode: "paused",
      visible: true,
      eligible: false,
      stage: "implementation",
    });
  });

  test("places a new enrolled issue at the first stage", () => {
    expect(
      evaluateIssueState({
        sourceState: "open",
        sourceLabels: ["conveyor"],
        labels,
        stages,
        expectedPostMergeClosure: false,
      }),
    ).toMatchObject({
      mode: "active",
      eligible: true,
      stage: "refinement",
      state: null,
    });
  });

  test("terminal and waiting states remain visible but unscheduled", () => {
    for (const [label, state] of [
      ["conveyor:done", "done"],
      ["conveyor:blocked", "blocked"],
      ["conveyor:needs-input", "needs-input"],
    ] as const) {
      expect(
        evaluateIssueState({
          sourceState: "open",
          sourceLabels: ["conveyor", "conveyor:review", label],
          labels,
          stages,
          expectedPostMergeClosure: false,
        }),
      ).toMatchObject({ mode: "stopped", eligible: false, state });
    }
  });

  test("blocks ambiguous stage labels instead of guessing", () => {
    const result = evaluateIssueState({
      sourceState: "open",
      sourceLabels: [
        "conveyor",
        "conveyor:implementation",
        "conveyor:review",
      ],
      labels,
      stages,
      expectedPostMergeClosure: false,
    });

    expect(result.mode).toBe("inconsistent");
    expect(result.eligible).toBe(false);
    expect(result.warnings[0]).toContain("multiple stage labels");
  });

  test("stops manual closure but permits a correlated post-merge closure", () => {
    const manuallyClosed = evaluateIssueState({
      sourceState: "closed",
      sourceLabels: ["conveyor", "conveyor:deploy"],
      labels,
      stages,
      expectedPostMergeClosure: false,
    });
    const merged = evaluateIssueState({
      sourceState: "closed",
      sourceLabels: ["conveyor", "conveyor:deploy"],
      labels,
      stages,
      expectedPostMergeClosure: true,
    });

    expect(manuallyClosed).toMatchObject({ mode: "closed", eligible: false });
    expect(manuallyClosed.warnings[0]).toContain("closed before");
    expect(merged).toMatchObject({ mode: "active", eligible: true, stage: "deploy" });
  });
});
