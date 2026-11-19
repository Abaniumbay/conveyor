import { afterEach, expect, test } from "bun:test";
import { chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { deliveryWorld, type DeliveryWorld } from "../support/delivery-world";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

let world: DeliveryWorld | null = null;
let dir: string | null = null;
afterEach(async () => {
  await world?.service.close().catch(() => undefined);
  await world?.close();
  world = null;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const RUN = (state: "running" | "passed") => [{ id: "1", name: "Tests", url: "https://ci.test/1", state, canRerun: false, hasLog: true }] as const;

/** A world whose `gh` prints the file `emit` once it exists and keeps running, as `gh event listen --follow` does. */
async function worldWithListener(): Promise<DeliveryWorld> {
  dir = await shortTemporaryDirectory("wait-listener-delivery-");
  const gh = path.join(dir, "gh");
  await writeFile(gh, `#!/bin/sh\nwhile [ ! -f "${dir}/emit" ]; do sleep 0.02; done\ncat "${dir}/emit"\nexec sleep 60\n`);
  await chmod(gh, 0o755);
  world = await deliveryWorld({ ghCommand: gh });
  return world;
}

/** Runs the item until its CI gate is parked, waiting for the head's CI. */
async function parkAtCi(w: DeliveryWorld): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await w.drive(1).catch(() => undefined);
    if (w.store.executions().getCursor("issue")?.state === "pending" && w.store.executions().subscriptions("issue").some((s) => s.topic.startsWith("ci:"))) return;
  }
  throw new Error(`never parked at CI: ${JSON.stringify(w.store.getStageState("issue"))}`);
}

/** GitHub reports a completed check suite for the head, claiming `conclusion`; resolves when the item became due. */
async function emitCompletion(w: DeliveryWorld, conclusion: string): Promise<void> {
  const line = JSON.stringify({
    type: "com.github.pull_request.check_suite.status.changed.v1",
    data: { api_url: "https://api.github.com/repos/owner/conveyor/pulls/5", head_sha: w.host.headSha, conclusion },
  });
  await writeFile(path.join(dir!, "emit.tmp"), `${line}\n`);
  await Bun.$`mv ${path.join(dir!, "emit.tmp")} ${path.join(dir!, "emit")}`;
  await becomesDue(w);
}

async function becomesDue(w: DeliveryWorld): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.parse(w.store.executions().getCursor("issue")!.wakeAt!) > Date.now() && Date.now() < deadline) await Bun.sleep(20);
  expect(Date.parse(w.store.executions().getCursor("issue")!.wakeAt!)).toBeLessThanOrEqual(Date.now());
}

const outcome = (w: DeliveryWorld) => {
  const cursor = w.store.executions().getCursor("issue");
  return { stage: w.store.getStageState("issue")?.stageId, cursor: cursor ? { stage: cursor.stage, task: cursor.taskInstanceId, state: cursor.state } : null };
};

test("AC-8.1 a woken CI wait re-reads the source and stays pending while it is still running", async () => {
  const w = await worldWithListener();
  w.ci.runs = [...RUN("running")];
  await parkAtCi(w);
  const before = w.ci.lists;
  w.service.start();

  await emitCompletion(w, "success");
  await w.drive(1).catch(() => undefined);

  expect(w.ci.lists).toBeGreaterThan(before);
  expect(w.store.executions().getCursor("issue")?.state).toBe("pending");
  expect(Date.parse(w.store.executions().getCursor("issue")!.wakeAt!)).toBeGreaterThan(Date.now());
  expect(w.store.executions().subscriptions("issue").some((s) => s.topic.startsWith("ci:"))).toBe(true);
});

test("AC-8.2 a woken CI wait ends as a poll would when the source shows success, whatever the payload claims", async () => {
  const woken = await worldWithListener();
  woken.ci.runs = [...RUN("running")];
  await parkAtCi(woken);
  woken.ci.runs = [...RUN("passed")];
  woken.service.start();
  await emitCompletion(woken, "failure");
  await woken.drive(1).catch(() => undefined);
  const viaEvent = outcome(woken);
  expect(viaEvent.cursor?.state).not.toBe("pending");
  await woken.service.close();
  await woken.close();
  await rm(dir!, { recursive: true, force: true });
  world = null;

  // Control: the same item, polled at its wake_at, with no event.
  const polled = await worldWithListener();
  polled.ci.runs = [...RUN("running")];
  await parkAtCi(polled);
  polled.ci.runs = [...RUN("passed")];
  polled.store.sqlite().query("UPDATE stage_cursors SET wake_at = ? WHERE issue_id = 'issue'").run(new Date(Date.now() - 1_000).toISOString());
  await polled.drive(1).catch(() => undefined);
  expect(outcome(polled)).toEqual(viaEvent);
});
