import { afterEach, expect, test } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { GitHubAdapter } from "../../src/plugins/github/shared/adapter";
import { ciTopic } from "../../src/events/topics";
import { itemWorld, type ItemWorld } from "../support/item-world";

let world: ItemWorld | null = null;
let service: ConveyorService | null = null;
afterEach(async () => {
  await service?.close().catch(() => undefined);
  service = null;
  await world?.close();
  world = null;
});

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("AC-9.1 the service starts the listener for a pending wait and stops it with the service", async () => {
  world = await itemWorld();
  const gh = path.join(world.root, "gh");
  await writeFile(gh, `#!/bin/sh\necho "$$ $*" >> "${world.root}/spawns"\nexec sleep 60\n`);
  await chmod(gh, 0o755);
  const spawns = async () => (existsSync(path.join(world!.root, "spawns")) ? (await readFile(path.join(world!.root, "spawns"), "utf8")).trim().split("\n") : []);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  world.store.upsertIssue({
    id: "issue-1", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.com/1", title: "T", body: "",
    sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
  const journal = world.store.executions();
  const epoch = journal.stageEpoch("issue-1");
  const wakeAt = new Date(Date.now() + 60_000).toISOString();
  service = new ConveyorService(world.config, world.store, {} as unknown as GitHubAdapter, { ghCommand: gh });
  service.start();
  await Bun.sleep(200);
  // No wait is pending yet: nothing listens.
  expect(await spawns()).toEqual([]);

  const { record } = journal.planExecution({ itemId: "issue-1", stage: "review", stageEpoch: epoch, attempt: 1, list: "exit-gate", taskInstanceId: "gate" });
  journal.markPending(record.id, { wakeAt, deadlineAt: null, waitFor: { topics: [ciTopic("owner/my-app", SHA)], kind: "ci" } }, epoch);
  journal.saveCursor({ issueId: "issue-1", stage: "review", stageEpoch: epoch, attempt: 1, returns: 0, list: "exit-gate", taskInstanceId: "gate", state: "pending", feedback: null, pendingSince: null, wakeAt, deadlineAt: null }, epoch);
  const deadline = Date.now() + 4_000;
  while ((await spawns()).length === 0 && Date.now() < deadline) await Bun.sleep(20);
  expect(await spawns()).toHaveLength(1);
  const pid = Number((await spawns())[0]!.split(" ")[0]);
  expect(alive(pid)).toBe(true);

  await service.close();
  service = null;
  const stopped = Date.now() + 4_000;
  while (alive(pid) && Date.now() < stopped) await Bun.sleep(20);
  expect(alive(pid)).toBe(false);
  expect(await spawns()).toHaveLength(1);
});
