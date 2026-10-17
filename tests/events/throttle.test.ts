import { afterEach, describe, expect, jest, test } from "bun:test";

import { EventThrottle } from "../../src/events/throttle";

afterEach(() => { jest.useRealTimers(); });

describe("EventThrottle", () => {
  test("the first change of a quiet key is recorded at once", () => {
    const recorded: string[] = [];
    new EventThrottle(1_000, (key) => recorded.push(key)).note("run-1", 0);
    expect(recorded).toEqual(["run-1"]);
  });

  test("a burst within the window is recorded once more, when the window ends", () => {
    jest.useFakeTimers();
    const recorded: string[] = [];
    const throttle = new EventThrottle(1_000, (key) => recorded.push(key));
    throttle.note("run-1");
    jest.advanceTimersByTime(100);
    throttle.note("run-1");
    jest.advanceTimersByTime(400);
    throttle.note("run-1");
    expect(recorded).toEqual(["run-1"]);
    // The window ends one second after the first record.
    jest.advanceTimersByTime(499);
    expect(recorded).toEqual(["run-1"]);
    jest.advanceTimersByTime(1);
    expect(recorded).toEqual(["run-1", "run-1"]);
    jest.advanceTimersByTime(5_000);
    expect(recorded).toEqual(["run-1", "run-1"]);
  });

  test("keys are throttled independently", () => {
    const recorded: string[] = [];
    const throttle = new EventThrottle(1_000, (key) => recorded.push(key));
    throttle.note("run-1", 0);
    throttle.note("run-2", 10);
    expect(recorded).toEqual(["run-1", "run-2"]);
  });

  test("forgetting a key drops its pending record", () => {
    jest.useFakeTimers();
    const recorded: string[] = [];
    const throttle = new EventThrottle(1_000, (key) => recorded.push(key));
    throttle.note("run-1", Date.now());
    throttle.note("run-1", Date.now());
    throttle.forget("run-1");
    jest.advanceTimersByTime(2_000);
    expect(recorded).toEqual(["run-1"]);
  });

  test("a failing record does not throw to the writer", () => {
    const throttle = new EventThrottle(1_000, () => { throw new Error("database closed"); });
    expect(() => throttle.note("run-1", 0)).not.toThrow();
  });
});
