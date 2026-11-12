import { describe, expect, test } from "bun:test";

import { CallMeter, currentCallSource, withCallSource } from "../../src/source/calls";

describe("withCallSource", () => {
  test("the source follows asynchronous work and nested sources win", async () => {
    expect(currentCallSource()).toBe("other");
    const seen = await withCallSource("tick", async () => {
      await Bun.sleep(1);
      const inner = await withCallSource("webhook", async () => { await Bun.sleep(1); return currentCallSource(); });
      return [currentCallSource(), inner];
    });
    expect(seen).toEqual(["tick", "webhook"]);
  });
});

describe("CallMeter", () => {
  const call = (source: "tick" | "webhook", route = "repos/:repo/pulls/:n", repository: string | null = "owner/my-app") =>
    ({ method: "GET" as const, route, repository, source, durationMs: 1, ok: true, status: null });

  test("counts per source, repository and route", () => {
    const meter = new CallMeter(0);
    meter.record(call("tick"), 1_000);
    meter.record(call("tick", "repos/:repo/issues"), 2_000);
    meter.record(call("webhook"), 3_000);
    expect(meter.summary(60 * 60_000, 4_000)).toEqual({
      total: 3,
      bySource: { tick: 2, webhook: 1 },
      byRepository: { "owner/my-app": { tick: 2, webhook: 1 } },
      byRoute: { "GET repos/:repo/pulls/:n": 2, "GET repos/:repo/issues": 1 },
    });
  });

  test("a summary covers only its window", () => {
    const meter = new CallMeter(0);
    meter.record(call("tick"), 0);
    meter.record(call("webhook"), 30 * 60_000);
    expect(meter.summary(10 * 60_000, 31 * 60_000).bySource).toEqual({ webhook: 1 });
  });

  test("calls older than an hour are dropped", () => {
    const meter = new CallMeter(0);
    meter.record(call("tick"), 0);
    meter.record(call("webhook"), 61 * 60_000);
    expect(meter.summary(60 * 60_000, 61 * 60_000).total).toBe(1);
  });

  test("reading the rate limit is not counted", () => {
    const meter = new CallMeter(0);
    meter.record(call("tick", "rate_limit", null), 0);
    expect(meter.summary(60 * 60_000, 1).total).toBe(0);
  });
});
