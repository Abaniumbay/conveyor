import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { stalledShutdownFields, stopAgentTransportsAfterService, type ShutdownStep } from "../../src/cli/commands/serve";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { DashboardFeed } from "../../src/plugins/dashboard/feed";
import { createWebAuth, hashPassword } from "../../src/web/auth";
import { normalizeDashboard } from "../../src/web/model";
import { createWebHandler } from "../../src/web/server";
import type { DashboardViewModel } from "../../src/web/types";
import { referenceConfigDirectory } from "../config/reference-fixture";
import { withCommands } from "../support/web-commands";

const bases: string[] = [];
afterEach(async () => {
  await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

/** A real HTTP server serving the real web handler, with the shutdown signal serve.ts wires in. */
function liveServer() {
  const auth = createWebAuth({
    passwordHash: undefined,
    sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
    accountById: (id) => (id === "a" ? account : null),
    accountByUsername: () => account,
  });
  const account = { id: "a", username: "admin", role: "superuser" as const, avatar: "🐼", sessionVersion: 1, passwordHash: hashPassword("pw", { salt: "0123456789abcdef" }) };
  const board = { backlog: [], restrictedRepositories: [] } as unknown as DashboardViewModel;
  const feed = new DashboardFeed({ build: () => normalizeDashboard(board) });
  const shutdown = new AbortController();
  const { dependencies } = withCommands({
    auth,
    username: "admin",
    webhookPath: "/webhook",
    handleWebhook: async () => {},
    isReady: () => true,
    shutdown: shutdown.signal,
    getDashboardSnapshot: () => feed.snapshot(),
    subscribeDashboardFeed: (listener: Parameters<DashboardFeed["subscribe"]>[0], after: number | null) => feed.subscribe(listener, after),
    getDashboardFeedStatus: () => feed.status,
    getSteeringRun: async () => ({ id: "run-1", status: "running" }),
    getSteeringEvents: async (_run: string, after: number) => (after === 0 ? [{ sequence: 1, type: "report", text: "Working", createdAt: "2026-11-14T12:00:00Z" }] : []),
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createWebHandler(dependencies as never) });
  const cookie = auth.createSession(account)!.cookie.split(";", 1)[0]!;
  return { server, shutdown, feed, cookie };
}

async function drain(response: Response): Promise<void> {
  const reader = response.body!.getReader();
  for (;;) if ((await reader.read()).done) return;
}

async function completesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([work.then(() => true), Bun.sleep(ms).then(() => false)]);
}

describe("serve shutdown with open event streams", () => {
  for (const [name, route] of [["dashboard live patch stream", "/api/v1/stream"], ["steering event stream", "/steering/run-1/events"]] as const) {
    test(`ends an open ${name} so the web server stop completes`, async () => {
      const { server, shutdown, feed, cookie } = liveServer();
      try {
        const response = await fetch(`${server.url.href}${route.slice(1)}`, { headers: { cookie } });
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const ended = drain(response).catch(() => {});
        const steps: ShutdownStep[] = [];
        const stopped = stopAgentTransportsAfterService({ close: async () => {} }, server, null, {
          onStep: (step) => steps.push(step),
          endStreams: () => shutdown.abort(),
        });
        expect(await completesWithin(stopped, 2_000)).toBe(true);
        expect(await completesWithin(ended, 1_000)).toBe(true);
        expect(steps).toEqual(["service close", "web server stop", "MCP socket stop"]);
      } finally {
        feed.close();
        await server.stop(true);
      }
    });
  }

  test("a stream opened after shutdown began ends at once", async () => {
    const { server, shutdown, feed, cookie } = liveServer();
    try {
      shutdown.abort();
      for (const route of ["api/v1/stream", "steering/run-1/events"]) {
        const response = await fetch(`${server.url.href}${route}`, { headers: { cookie } });
        expect(await completesWithin(drain(response), 1_000)).toBe(true);
      }
    } finally {
      feed.close();
      await server.stop(true);
    }
  });
});

describe("a timed-out shutdown names what it waited on", () => {
  test("names the step, and the busy conditions only while in service close", async () => {
    const busyConditions = () => ["tick", "retention"];
    expect(stalledShutdownFields("service close", { busyConditions })).toEqual({ step: "service close", busy: ["tick", "retention"] });
    expect(stalledShutdownFields("web server stop", { busyConditions })).toEqual({ step: "web server stop" });
    expect(stalledShutdownFields("MCP socket stop", { busyConditions })).toEqual({ step: "MCP socket stop" });
  });

  test("close() reports the tick it is waiting on until it ends", async () => {
    const { directory, base } = await referenceConfigDirectory();
    bases.push(base);
    const config = await loadConfig(directory);
    const store = await ConveyorStore.open(path.join(base, "conveyor.sqlite"));
    let release!: () => void;
    const listing = new Promise<void>((resolve) => { release = resolve; });
    let listed = 0;
    const github = {
      async repositoryVisibility() { return "private" as const; },
      async ensureLabels() {},
      async listIssues() { listed += 1; await listing; return []; },
      async listSubIssues() { return []; },
      async listDependencies() { return []; },
    };
    const service = new ConveyorService(config, store, github as never);
    try {
      expect(service.busyConditions()).toEqual([]);
      const tick = service.tick();
      while (listed === 0) await Bun.sleep(5);
      const closing = service.close();
      await Bun.sleep(50);
      const busy = service.busyConditions();
      expect(busy).toContain("tick");
      const names = ["active stages", "steering", "purges", "status comments", "answers", "sync", "tick", "advisory polling", "retention"];
      expect(busy.every((name) => names.includes(name))).toBe(true);
      release();
      await tick;
      await closing;
      expect(service.busyConditions()).toEqual([]);
    } finally {
      release();
    }
  });

  test("close() reports a running startup sync until it ends", async () => {
    const { directory, base } = await referenceConfigDirectory();
    bases.push(base);
    const config = await loadConfig(directory);
    const store = await ConveyorStore.open(path.join(base, "conveyor.sqlite"));
    let release!: () => void;
    const listing = new Promise<void>((resolve) => { release = resolve; });
    let listed = 0;
    const github = {
      async repositoryVisibility() { return "private" as const; },
      async ensureLabels() {},
      async listIssues() { listed += 1; await listing; return []; },
      async listSubIssues() { return []; },
      async listDependencies() { return []; },
    };
    const service = new ConveyorService(config, store, github as never);
    try {
      service.start();
      while (listed === 0) await Bun.sleep(5);
      const closing = service.close();
      await Bun.sleep(50);
      expect(service.busyConditions()).toContain("sync");
      release();
      await closing;
      expect(service.busyConditions()).toEqual([]);
    } finally {
      release();
    }
  });
});
