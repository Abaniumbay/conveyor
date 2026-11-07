import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { ConveyorStore } from "../../src/db/store";
import { createOperatorMcpHandler, OPERATOR_MCP_PATH } from "../../src/operator-mcp/server";

const BODY = "Text\n\n<!-- conveyor:acceptance-criteria:start -->\n## Acceptance Criteria\n\n- [ ] First <!-- conveyor:criterion:AC-1 -->\n- [ ] [Manual] Second <!-- conveyor:criterion:AC-2 -->\n<!-- conveyor:acceptance-criteria:end -->\n";
let directory: string;
let store: ConveyorStore;
let client: Client;
let stop: () => void;

const issue = (id: string, number: number, extra: { body?: string; labels?: string[]; parentId?: string } = {}) => store.upsertIssue({
  id, repositoryId: "repo", sourceNumber: number, sourceUrl: `https://example.test/${number}`, title: `Title ${number}`, body: extra.body ?? "",
  sourceState: "open", labels: extra.labels ?? [], sourceUpdatedAt: "2026-10-20T00:00:00.000Z", ...(extra.parentId ? { parentId: extra.parentId } : {}),
});

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "operator-state-"));
  store = await ConveyorStore.open(path.join(directory, "conveyor.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/app", folder: "f", configHash: "h" });
  store.upsertRepository({ id: "other", configName: "other", source: "github", address: "owner/other", folder: "f", configHash: "h" });
  issue("i1", 1, { body: BODY, labels: ["conveyor", "conveyor:implementation"] });
  issue("i2", 2, { parentId: "i1" });
  store.upsertIssue({ id: "o1", repositoryId: "other", sourceNumber: 7, sourceUrl: "u", title: "Elsewhere", body: "", sourceState: "open", labels: [], sourceUpdatedAt: "2026-10-20T00:00:00.000Z" });
  store.replaceRelationships("i2", { parentId: "i1", siblingOrder: 1 }, ["i1"]);
  store.setIssueProjection("i1", { stage: "implementation", state: "active", warning: null });
  store.setIssueProjection("i2", { stage: "refinement", state: "waiting", warning: null });
  store.setIssueProjection("o1", { stage: "review", state: "active", warning: null });
  store.activateEnrollment("i1");
  store.upsertPullRequest({ issueId: "i1", id: "pr1", number: 40, url: "https://example.test/pull/40", state: "open" });
  store.saveIndicator("i1", "abc123", { id: "ci", label: "CI", state: "failed", detail: "1 failed", progress: "1 failed", url: null, observedAt: "2026-10-20T00:00:00.000Z", entries: [{ name: "unit", state: "failed" } as never], reference: null }, false);
  store.createRun({ id: "run1", issueId: "i1", stageId: "implementation", attempt: 1, kind: "stage", status: "completed", configHash: "h", startedAt: "2026-10-20T00:00:00.000Z" });
  store.openQuestion({ issueId: "i1", runId: "run1", prompt: "Which?", reason: "unclear", options: ["a", "b"] });
  store.appendConversationMessage({ issueId: "i1", runId: null, stageId: null, actorType: "user", actorId: "u", actorName: "Owner", actorTitle: null, message: "hello" });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createOperatorMcpHandler({ facade: { store, status: () => ({}), findItem: () => null, dispatch: () => { throw new Error("unused"); } }, tokenIsActive: () => true }) });
  stop = () => void server.stop(true);
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(OPERATOR_MCP_PATH, server.url.href), { requestInit: { headers: { authorization: "Bearer abc" } } }) as Parameters<Client["connect"]>[0]);
});

afterAll(async () => {
  await client.close();
  stop();
  store.close();
  await rm(directory, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; value: any }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { isError: result.isError === true, value: result.isError ? text : JSON.parse(text) };
}

describe("operator state tools", () => {
  test("AC-1 list_repositories lists onboarded repositories", async () => {
    expect((await call("list_repositories")).value.map((r: { id: string }) => r.id)).toEqual(["other", "repo"]);
  });

  test("AC-2 list_items lists number, title, stage, state, dependencies and filters by repository", async () => {
    const all = (await call("list_items")).value;
    expect(all).toHaveLength(3);
    const filtered = (await call("list_items", { repository: "owner/app" })).value;
    expect(filtered).toEqual([
      { repository: "repo", number: 1, title: "Title 1", stage: "implementation", state: "active", dependencies: [] },
      { repository: "repo", number: 2, title: "Title 2", stage: "refinement", state: "waiting", dependencies: [1] },
    ]);
  });

  test("AC-3 get_item returns parent, children, criteria and labels", async () => {
    const parent = (await call("get_item", { repository: "repo", number: 1 })).value;
    expect(parent.labels).toEqual(["conveyor", "conveyor:implementation"]);
    expect(parent.children).toMatchObject([{ number: 2 }]);
    expect(parent.criteria).toMatchObject([{ id: "AC-1", manual: false }, { id: "AC-2", manual: true }]);
    expect((await call("get_item", { repository: "repo", number: 2 })).value.parent).toBe(1);
  });

  test("AC-4 get_conversation returns the shared conversation messages", async () => {
    expect((await call("get_conversation", { repository: "repo", number: 1 })).value).toMatchObject([{ actor: "Owner", message: "hello" }]);
  });

  test("AC-5 get_change_status returns the change request, pull request and CI checks", async () => {
    const status = (await call("get_change_status", { repository: "repo", number: 1 })).value;
    expect(status.pullRequest).toMatchObject({ number: 40, state: "open" });
    expect(status.changeRequest).toMatchObject({ number: 40 });
    expect(status.ci).toMatchObject({ state: "failed", headSha: "abc123", checks: [{ name: "unit" }] });
    expect((await call("get_change_status", { repository: "repo", number: 2 })).value).toEqual({ changeRequest: null, pullRequest: null, ci: null });
  });

  test("AC-6 get_questions_and_runs returns pending questions and run history", async () => {
    const value = (await call("get_questions_and_runs", { repository: "repo", number: 1 })).value;
    expect(value.pendingQuestions).toMatchObject([{ prompt: "Which?", options: ["a", "b"] }]);
    expect(value.runs).toMatchObject([{ id: "run1", stage: "implementation", status: "completed" }]);
  });

  test("AC-7 an unknown item or repository is a tool error naming it", async () => {
    const item = await call("get_item", { repository: "repo", number: 999 });
    expect(item.isError).toBe(true);
    expect(item.value).toContain("repo#999");
    const repository = await call("list_items", { repository: "nope/none" });
    expect(repository.isError).toBe(true);
    expect(repository.value).toContain("nope/none");
    expect((await call("get_conversation", { repository: "nope/none", number: 1 })).value).toContain("nope/none");
  });
});
