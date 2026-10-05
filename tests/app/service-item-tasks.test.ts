import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ScopedMcpFactory } from "../../src/app/runtime";
import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore, type StoredIssue } from "../../src/db/store";
import { createTaskRegistry } from "../../src/tasks/catalogue";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const CRITERIA = "<!-- conveyor:acceptance-criteria:start -->\n- [ ] It works <!-- conveyor:criterion:a -->\n<!-- conveyor:acceptance-criteria:end -->\n";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-item-service-"));
  directories.push(root);
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: {}
sources: { github: { type: github } }
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    stages:
      - id: refinement
        concurrency: 1
        retries: 0
        actions: []
        exit-gate: [{ task: item.criteriaDefined }]
      - id: implementation
        concurrency: 1
        actions: []
        exit-gate: [{ task: item.criteriaDefined }]
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repositoryPath}
    pipeline: default
`);
  const config = await loadConfig(path.join(root, "config.yml"), createTaskRegistry());
  const store = await ConveyorStore.open(config.settings.database);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash });
  const labelWrites: string[][] = [];
  const github = { replaceConveyorLabels: async (_a: string, _n: number, labels: string[]) => { labelWrites.push([...labels]); } };
  const service = new ConveyorService(config, store, github as never);
  Object.assign(service as object, { reconcileRepository: async () => {}, updateStatusComment: async () => {} });
  const enroll = (id: string, number: number, body: string) => {
    store.upsertIssue({
      id, repositoryId: "repo", sourceNumber: number, sourceUrl: `https://example.test/${number}`, title: id, body,
      sourceState: "open", labels: ["conveyor", "conveyor:refinement"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setIssueProjection(id, { stage: "refinement", state: "active", warning: null });
    store.setQueueRank(id, store.nextQueueRank());
    store.setStageState({ issueId: id, stageId: "refinement", status: "ready", feedbackCycle: 0, configHash: config.hash });
    return store.getIssue(id)!;
  };
  const execute = (issue: StoredIssue) =>
    (service as unknown as { execute(i: StoredIssue, s: AbortSignal): Promise<void> }).execute(issue, new AbortController().signal);
  return { store, enroll, execute, labelWrites, service, root, github: github as Record<string, unknown> };
}

describe("native stages with item tasks through the service", () => {
  test("an exit gate with item.criteriaDefined loads the item with real deps and advances the stage", async () => {
    const w = await setup();
    await w.execute(w.enroll("ok", 1, CRITERIA));
    expect(w.labelWrites.at(-1)).toContain("conveyor:implementation");
    expect(w.store.getStageState("ok")?.status).not.toBe("error");
    await w.service.close();
  });

  test("a missing criterion stops the stage and the conversation says what is missing", async () => {
    const w = await setup();
    await w.execute(w.enroll("bare", 2, "no criteria here"));
    const messages = w.store.listConversationMessages("bare", 50).map((m) => m.message).join("\n");
    expect(messages).toContain("Acceptance criteria are missing: add at least one criterion to the managed section");
    expect(w.labelWrites.at(-1)).not.toContain("conveyor:implementation");
    await w.service.close();
  });
});

describe("legacy MCP names delegate to the item tools", () => {
  test("source.add_comment runs item.comment once per identical request, and source.set_labels is gone", async () => {
    const w = await setup();
    const issue = w.enroll("mcp", 3, "");
    const comments: Array<[string, number, string]> = [];
    w.github.addComment = async (a: string, n: number, m: string) => { comments.push([a, n, m]); return 7; };
    w.github.getIssue = async () => ({ id: "x", number: 3, body: "B" });
    const factory = (w.service as unknown as { mcpFactory(): ScopedMcpFactory }).mcpFactory();
    const lease = await factory.create({
      runId: "run-1", stageId: "refinement",
      context: {
        issue, repository: { id: "repo", address: "owner/repo", folder: w.root, baseBranch: "main" },
        workspace: null, sourceGuidance: "g",
      } as never,
      allowedTools: ["source.add_comment", "source.get_issue"], actor: { id: "a", name: "A", title: "T" },
    });
    const token = (JSON.parse(await readFile(path.join(w.root, "artifacts/run-1/mcp-context.json"), "utf8")) as { control: { token: string } }).control.token;
    const call = (tool: string, input: unknown) => w.service.handleMcp({ tool, input }, token);
    expect(await call("source.add_comment", { markdown: "hello" })).toEqual({ commentId: 7 });
    expect(await call("item.comment", { markdown: "hello" })).toEqual({ commentId: 7 });
    expect(comments).toEqual([["owner/repo", 3, "hello"]]);
    expect(await call("item.comment", { markdown: "other" })).toEqual({ commentId: 7 });
    expect(comments).toHaveLength(2);
    await expect(call("item.comment", { markdown: "" })).rejects.toThrow("Invalid input for task item.comment");
    expect(await call("source.get_issue", {})).toMatchObject({ body: "B" });
    await expect(call("source.set_labels", { labels: [] })).rejects.toThrow(/not granted/);
    await lease.close();
    await w.service.close();
  });

  test("Operator board tools are rejected even when an issue-scoped grant names them", async () => {
    const w = await setup();
    const issue = w.enroll("operator-item", 4, "");
    const factory = (w.service as unknown as { mcpFactory(): ScopedMcpFactory }).mcpFactory();
    const lease = await factory.create({
      runId: "run-operator-item", stageId: "refinement",
      context: {
        issue, repository: { id: "repo", address: "owner/repo", folder: w.root, baseBranch: "main" },
        workspace: null, sourceGuidance: "g",
      } as never,
      allowedTools: ["operator.getBoard"], actor: { id: "a", name: "A", title: "T" },
    });
    const token = (JSON.parse(await readFile(path.join(w.root, "artifacts/run-operator-item/mcp-context.json"), "utf8")) as { control: { token: string } }).control.token;
    await expect(w.service.handleMcp({ tool: "operator.getBoard", input: {} }, token))
      .rejects.toThrow("requires an active steering MCP grant");
    await lease.close();
    await w.service.close();
  });
});
