import { describe, expect, test } from "bun:test";

import { changeAction, linkExistingChange } from "../../src/codehost/actions";

describe("change stage action aliases", () => {
  test("maps ensure names to the same operation", () => {
    expect(changeAction("change.ensure")).toBe("ensure");
    expect(changeAction("pullRequest.ensure")).toBe(changeAction("change.ensure"));
  });

  test("maps squash merge names to the same operation", () => {
    expect(changeAction("change.merge")).toBe("merge");
    expect(changeAction("pullRequest.squashMerge")).toBe(changeAction("change.merge"));
  });

  test("leaves unrelated actions available to their own handlers", () => {
    expect(changeAction("pullRequest.awaitChecks")).toBeNull();
  });
});

describe("linkExistingChange", () => {
  test("records an already-open branch change without creating another", async () => {
    const calls: unknown[] = [];
    const stored: unknown[] = [];
    const linked = await linkExistingChange({
      codeHost: {
        async findOpenChange(input) {
          calls.push(input);
          return { id: "github:owner/repository#pr-17", number: 17, url: "https://example.test/pr/17", state: "open", headSha: "a".repeat(40), draft: false, mergeable: null };
        },
      },
      store: {
        getCurrentPullRequest: () => null,
        upsertPullRequest: (input) => { stored.push(input); },
      },
      address: "owner/repository", issueId: "issue-1", branch: "conveyor/17-r1-existing",
    });

    expect(calls).toEqual([{ address: "owner/repository", branch: "conveyor/17-r1-existing" }]);
    expect(stored).toEqual([{ issueId: "issue-1", id: "github:owner/repository#pr-17", number: 17, url: "https://example.test/pr/17", state: "open" }]);
    expect(linked?.headSha).toBe("a".repeat(40));
  });

  test("leaves an existing change record untouched on retries", async () => {
    let lookups = 0;
    const linked = await linkExistingChange({
      codeHost: { async findOpenChange() { lookups += 1; return null; } },
      store: {
        getCurrentPullRequest: () => ({}) as never,
        upsertPullRequest: () => { throw new Error("must not replace the record"); },
      },
      address: "owner/repository", issueId: "issue-1", branch: "conveyor/17-r1-existing",
    });

    expect(linked).toBeNull();
    expect(lookups).toBe(0);
  });
});
