import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { RESTART_EXIT_CODE, SUPERVISED_RESTART_SHUTDOWN_TIMEOUT_MS, waitForSupervisedRestartShutdown } from "../../src/cli/commands/serve";
import { EXIT } from "../../src/cli/args";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";
import { referenceConfigDirectory } from "../config/reference-fixture";

const bases: string[] = [];
afterEach(async () => {
  await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

describe("ConveyorService shutdown", () => {
  test("fails a stalled supervised restart before the systemd stop timeout", async () => {
    let deadline: number | undefined;
    const stalled = new Promise<void>(() => {});

    const result = await waitForSupervisedRestartShutdown(stalled, {
      scheduleTimeout: (callback, milliseconds) => {
        deadline = milliseconds;
        queueMicrotask(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    });

    expect(deadline).toBe(SUPERVISED_RESTART_SHUTDOWN_TIMEOUT_MS);
    expect(SUPERVISED_RESTART_SHUTDOWN_TIMEOUT_MS).toBeLessThan(30_000);
    expect(result).toEqual({ exitCode: EXIT.failure, timedOut: true });
  });

  test("keeps the requested restart status when supervised cleanup finishes", async () => {
    let closed = false;

    const result = await waitForSupervisedRestartShutdown(Promise.resolve().then(() => { closed = true; }), {
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    });

    expect(closed).toBe(true);
    expect(result).toEqual({ exitCode: RESTART_EXIT_CODE, timedOut: false });
  });

  test("close waits for an in-flight reconcile instead of closing the database under it", async () => {
    const { directory, base } = await referenceConfigDirectory();
    bases.push(base);
    const config = await loadConfig(directory);
    const store = await ConveyorStore.open(path.join(base, "conveyor.sqlite"));
    let release!: () => void;
    const listing = new Promise<void>((resolve) => { release = resolve; });
    let listed = 0;
    const github = {
      async listIssues() { listed += 1; await listing; return []; },
      async listSubIssues() { return []; },
      async listDependencies() { return []; },
    };
    const service = new ConveyorService(config, store, github as never);
    const logged: string[] = [];
    log.configure({ sinks: [{ write: (record) => logged.push(JSON.stringify(record)) }] });
    try {
      const tick = service.tick();
      while (listed === 0) await Bun.sleep(5);
      let closed = false;
      const closing = service.close().then(() => { closed = true; });
      await Bun.sleep(50);
      expect(closed).toBe(false);
      release();
      await tick;
      await closing;
      expect(closed).toBe(true);
      expect(logged.filter((line) => /closed database/i.test(line))).toEqual([]);
    } finally {
      log.configure({ sinks: [new ConsoleSink()] });
    }
  });
});
