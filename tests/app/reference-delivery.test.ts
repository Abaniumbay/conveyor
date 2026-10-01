import { afterEach, expect, test } from "bun:test";

import { deliveryWorld, type DeliveryWorld } from "../support/delivery-world";

let world: DeliveryWorld | null = null;
afterEach(async () => { await world?.close(); world = null; });

test("a fresh item runs the whole reference delivery pipeline and ends done", async () => {
  world = await deliveryWorld();
  const w = world;
  await w.drive();

  expect([...new Set(w.executed)]).toEqual(["refinement", "implementation", "review", "merge", "deploy", "verify", "cleanup"]);
  expect(w.agentRuns).toEqual(["refinement", "implementation", "review"]);
  expect(w.scriptRuns).toEqual(["deploy", "verify"]);
  expect(w.store.getStageState("issue")?.status).toBe("done");
  expect(w.store.getActiveWorkspace("issue")).toBeNull();

  const { checkpoints } = w.store.executions().getContext("issue")!.context;
  expect(w.host.headSha).toMatch(/^[0-9a-f]{40}$/);
  expect(checkpoints.ciPassed?.sha).toBe(w.host.headSha);
  expect(checkpoints.reviewPassed?.sha).toBe(w.host.headSha);
  expect(w.host.merges).toHaveLength(1);
  expect(w.host.merges[0]!.expectedHeadSha).toBe(w.host.headSha);
});
