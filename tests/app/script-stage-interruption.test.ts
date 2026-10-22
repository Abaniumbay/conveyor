import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import { deliveryWorld, type DeliveryWorld } from "../support/delivery-world";

let world: DeliveryWorld | null = null;
afterEach(async () => { await world?.close(); world = null; });

async function waitForFile(filename: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(filename)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

test("records an interrupted deploy before a SIGTERM-responsive descendant can hold stdout open", async () => {
  world = await deliveryWorld({
    interruptGrace: "50ms",
    deployScript: [
      'import { writeFile } from "node:fs/promises";',
      'const child = Bun.spawn(["sh", "-c", "sleep 2"]);',
      'await writeFile("script-ready", String(child.pid));',
      'await new Promise<never>(() => {});',
    ].join("\n"),
  });
  const w = world;
  w.store.setIssueProjection("issue", { stage: "deploy", state: "active", warning: null });
  w.store.setStageState({ issueId: "issue", stageId: "deploy", status: "ready", feedbackCycle: 0, configHash: w.config.hash });

  const controller = new AbortController();
  const execution = w.runCurrentStage(controller.signal);
  await waitForFile(path.join(w.root, "repos", "conveyor", "script-ready"));

  const startedAt = Date.now();
  controller.abort();
  await execution;

  expect(Date.now() - startedAt).toBeLessThan(500);
  expect(w.store.getStageState("issue")).toMatchObject({ stageId: "deploy", status: "interrupted" });
});
