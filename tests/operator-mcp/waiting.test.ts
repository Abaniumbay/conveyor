import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { Scheduler } from "../../src/app/scheduler";
import { createOperatorMcpHandler, OPERATOR_MCP_PATH } from "../../src/operator-mcp/server";
import { itemWorld, type ItemWorld } from "../support/item-world";

let world: ItemWorld;
let scheduler: Scheduler;
let client: Client;
let stop: () => void;

/** An enrolled item queued and ready at the implementation stage. */
function ready(number: number) {
  world.items.add(number, ["conveyor", "conveyor:implementation"]);
  const id = world.seed(number, { stage: "implementation", state: "active" });
  world.store.setQueueRank(id, world.store.nextQueueRank());
  world.store.setStageState({ issueId: id, stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: world.config.hash });
  return id;
}

beforeAll(async () => {
  world = await itemWorld();
  scheduler = new Scheduler({
    config: world.config,
    store: world.store,
    running: () => new Map(),
    shuttingDown: () => false,
    draining: () => false,
    repositoryReady: () => true,
    isLightweightStage: () => false,
    isSkippedStage: () => false,
    isGateOnlyExecution: () => false,
    hasResumableQuestionExecution: () => false,
    childCreationRetryQueued: () => false,
    schedulePass: () => {},
    launch: () => {},
    refreshStatusComments: () => {},
    timerFired: () => {},
  });
  // #1 is blocked by #9; #2 and #3 are its child and grandchild with no dependency of their own; #4 is unrelated.
  const blocker = ready(9);
  const grandparent = ready(1);
  const parent = ready(2);
  const child = ready(3);
  ready(4);
  world.store.replaceRelationships(grandparent, null, [blocker]);
  world.store.replaceRelationships(parent, { parentId: grandparent, siblingOrder: null }, []);
  world.store.replaceRelationships(child, { parentId: parent, siblingOrder: null }, []);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createOperatorMcpHandler({
      facade: {
        store: world.store,
        status: () => ({}),
        waitingReason: (issueId) => scheduler.liveIssueStatus(issueId)?.reason ?? null,
        findItem: () => null,
        createIssue: () => { throw new Error("unused"); },
        dispatch: () => { throw new Error("unused"); },
      },
      tokenIsActive: () => true,
    }),
  });
  stop = () => void server.stop(true);
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(OPERATOR_MCP_PATH, server.url.href), { requestInit: { headers: { authorization: "Bearer abc" } } }) as Parameters<Client["connect"]>[0]);
});

afterAll(async () => {
  await client.close();
  stop();
  scheduler.close();
  await world.close();
});

async function item(number: number): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: "get_item", arguments: { repository: "repo", number } });
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

describe("get_item for a held-back item", () => {
  test("AC-6.3 shows the nearest waiting ancestor as a status line, not as an inherited dependency", async () => {
    const grandchild = await item(3);
    expect(grandchild.dependencies).toEqual([]);
    expect("inheritedDependencies" in grandchild).toBe(false);
    expect(grandchild.waiting).toBe("Waiting: ancestor #1 is blocked by #9");
  });

  test("AC-6.3 the ancestor keeps its own dependency under dependencies and is not itself waiting, and an unrelated item is not waiting", async () => {
    const blocked = await item(1);
    expect(blocked.dependencies).toEqual([9]);
    // A roll-up parent never starts itself, so it is not held back.
    expect(blocked.waiting).toBeNull();
    expect((await item(4)).waiting).toBeNull();
  });
});
