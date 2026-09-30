import { describe, expect, test } from "bun:test";

import { selectRunnableIssues } from "../../src/core/scheduler";

describe("selectRunnableIssues", () => {
  test("scans global hierarchy order and skips dependencies without blocking later work", () => {
    const selected = selectRunnableIssues(
      [
        {
          id: "a1",
          repositoryId: "repo-a",
          stageId: "implementation",
          queueRank: 1,
          siblingOrder: 1,
          eligible: true,
          dependenciesSatisfied: true,
        },
        {
          id: "a2",
          repositoryId: "repo-a",
          stageId: "implementation",
          queueRank: 1,
          siblingOrder: 2,
          eligible: true,
          dependenciesSatisfied: false,
        },
        {
          id: "a3",
          repositoryId: "repo-a",
          stageId: "implementation",
          queueRank: 1,
          siblingOrder: 3,
          eligible: true,
          dependenciesSatisfied: true,
        },
        {
          id: "b",
          repositoryId: "repo-b",
          stageId: "implementation",
          queueRank: 2,
          siblingOrder: null,
          eligible: true,
          dependenciesSatisfied: true,
        },
      ],
      {
        global: 3,
        stages: { implementation: 3 },
        repositories: { "repo-a": 2, "repo-b": 1 },
      },
      { global: 0, stages: {}, repositories: {} },
    );

    expect(selected.map((candidate) => candidate.id)).toEqual(["a1", "a3", "b"]);
  });

  test("accounts for already running work across every concurrency scope", () => {
    const selected = selectRunnableIssues(
      [
        {
          id: "first",
          repositoryId: "repo-a",
          stageId: "refinement",
          queueRank: 1,
          siblingOrder: null,
          eligible: true,
          dependenciesSatisfied: true,
        },
        {
          id: "second",
          repositoryId: "repo-b",
          stageId: "implementation",
          queueRank: 2,
          siblingOrder: null,
          eligible: true,
          dependenciesSatisfied: true,
        },
      ],
      {
        global: 2,
        stages: { refinement: 1, implementation: 2 },
        repositories: { "repo-a": 1, "repo-b": 1 },
      },
      {
        global: 1,
        stages: { refinement: 1 },
        repositories: { "repo-a": 1 },
      },
    );

    expect(selected.map((candidate) => candidate.id)).toEqual(["second"]);
  });

  test("does not schedule roll-up parents or ineligible issues", () => {
    const selected = selectRunnableIssues(
      [
        {
          id: "parent",
          repositoryId: "repo-a",
          stageId: "implementation",
          queueRank: 1,
          siblingOrder: null,
          eligible: true,
          dependenciesSatisfied: true,
          rollupOnly: true,
        },
        {
          id: "paused",
          repositoryId: "repo-b",
          stageId: "implementation",
          queueRank: 2,
          siblingOrder: null,
          eligible: false,
          dependenciesSatisfied: true,
        },
      ],
      {
        global: 2,
        stages: { implementation: 2 },
        repositories: { "repo-a": 1, "repo-b": 1 },
      },
      { global: 0, stages: {}, repositories: {} },
    );

    expect(selected).toEqual([]);
  });
});

describe("lightweight stages", () => {
  test("a source-action-only stage runs even when repository and global permits are exhausted", () => {
    const selected = selectRunnableIssues(
      [
        { id: "agent", repositoryId: "repo", stageId: "implementation", queueRank: 1, siblingOrder: null, eligible: true, dependenciesSatisfied: true },
        { id: "ci-1", repositoryId: "repo", stageId: "ci", queueRank: 2, siblingOrder: null, eligible: true, dependenciesSatisfied: true, lightweight: true },
        { id: "ci-2", repositoryId: "repo", stageId: "ci", queueRank: 3, siblingOrder: null, eligible: true, dependenciesSatisfied: true, lightweight: true },
      ],
      { global: 2, stages: { implementation: 2, ci: 1 }, repositories: { repo: 2 } },
      { global: 2, stages: { implementation: 2 }, repositories: { repo: 2 } },
    );
    expect(selected.map((candidate) => candidate.id)).toEqual(["ci-1"]);
  });
});
