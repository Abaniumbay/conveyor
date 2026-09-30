import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { CiGateWaitRegistry } from "../../src/app/provider-event";
import { GitHubWebhookProvider } from "../../src/source/github/webhook-provider";

describe("CI gate event wakeups", () => {
  test("wakes only a parked gate waiting on the matching repository and full commit", () => {
    const waits = new CiGateWaitRegistry();
    waits.track("issue-1", "repo-a", "7", "a".repeat(40));
    waits.track("issue-2", "repo-a", "8", "b".repeat(40));
    waits.track("issue-3", "repo-b", "9", "a".repeat(40));
    for (const id of ["issue-1", "issue-2", "issue-3"]) expect(waits.park(id)).toBe(true);

    expect(waits.wakeCommit("repo-a", "c".repeat(40))).toEqual([]);
    expect(waits.wakeCommit("repo-b", "a".repeat(40))).toEqual(["issue-3"]);
    expect(waits.wakeCommit("repo-a", "a".repeat(40))).toEqual(["issue-1"]);
    expect(waits.wakeCommit("repo-a", "a".repeat(40))).toEqual([]);
  });

  test("coalesces events racing with polling and allows a later parked retry", () => {
    const waits = new CiGateWaitRegistry();
    const commit = "a".repeat(40);
    waits.track("issue-1", "repo", "7", commit);
    expect(waits.wakeCommit("repo", commit)).toEqual([]);
    expect(waits.wakeCommit("repo", commit)).toEqual([]);
    expect(waits.park("issue-1")).toBe(true);
    expect(waits.wakeCommit("repo", commit)).toEqual(["issue-1"]);
    expect(waits.wakeCommit("repo", commit)).toEqual([]);

    waits.track("issue-1", "repo", "7", commit);
    expect(waits.park("issue-1")).toBe(true);
    expect(waits.wakeCommit("repo", commit)).toEqual(["issue-1"]);
    waits.track("issue-1", "repo", "7", "b".repeat(40));
    expect(waits.wakeCommit("repo", commit)).toEqual([]);
    expect(waits.park("issue-1")).toBe(true);
  });

  test("a pull request head update wakes only its associated waiting change", () => {
    const waits = new CiGateWaitRegistry();
    waits.track("issue-1", "repo", "7", "a".repeat(40));
    waits.track("issue-2", "repo", "8", "a".repeat(40));
    waits.park("issue-1");
    waits.park("issue-2");
    expect(waits.wakeChange("repo", "7")).toEqual(["issue-1"]);
    expect(waits.wakeChange("other-repo", "8")).toEqual([]);
  });

  test("a signed completed workflow delivery promptly wakes its parked commit gate once", async () => {
    const commit = "c".repeat(40);
    const waits = new CiGateWaitRegistry();
    waits.track("issue-1", "repo", "12", commit);
    expect(waits.park("issue-1")).toBe(true);
    const seen = new Set<string>();
    const provider = new GitHubWebhookProvider({
      recordSourceEvent(event) {
        if (seen.has(event.deliveryId)) return false;
        seen.add(event.deliveryId);
        return true;
      },
    } as never, [{ id: "repo", address: "owner/repo" }], () => "secret");

    const send = (deliveryId: string) => {
      const body = new TextEncoder().encode(JSON.stringify({
        action: "completed",
        repository: { full_name: "owner/repo" },
        workflow_run: { status: "completed", head_sha: commit },
      }));
      const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
      return provider.receive(body, new Headers({
        "x-hub-signature-256": signature,
        "x-github-delivery": deliveryId,
        "x-github-event": "workflow_run",
      }));
    };

    const events = await send("completion-1");
    expect(events).toEqual([{ type: "ci.completed", repositoryId: "repo", commitSha: commit }]);
    expect(events.flatMap((event) => event.type === "ci.completed" ? waits.wakeCommit(event.repositoryId, event.commitSha) : [])).toEqual(["issue-1"]);
    expect(await send("completion-2")).toHaveLength(1);
    const burst = await send("completion-3");
    expect(burst.flatMap((event) => event.type === "ci.completed" ? waits.wakeCommit(event.repositoryId, event.commitSha) : [])).toEqual([]);
  });
});
