import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { TaskContext } from "../../src/tasks/context";
import {
  InfrastructureError,
  TaskConfigError,
  TaskRegistry,
  defineGroup,
  fail,
  pass,
  pending,
  runTask,
  type TaskArgs,
  type TaskDefinition,
} from "../../src/tasks/contract";

function context(): TaskContext {
  return {
    schemaVersion: 1,
    configHash: "h",
    run: {
      stage: "s",
      stageEpoch: 1,
      attempt: 1,
      maxAttempts: 3,
      taskInstanceId: "t1",
      enteredAt: "2026-01-01T00:00:00Z",
      feedback: null,
    },
    repository: { id: "r", address: "o/r", folder: "/r", baseBranch: "main", ciMode: "required" },
    item: {
      id: "i", number: 1, title: "T", body: "B", url: "u", labels: ["a"], state: "open",
      criteria: [], children: [], dependencies: [], systemLabels: [],
    },
    checkpoints: { ciPassed: null, reviewPassed: null },
  };
}

function args(ctx: Partial<TaskContext> = context(), extra: Partial<TaskArgs> = {}): TaskArgs {
  return {
    context: ctx as TaskContext,
    config: undefined,
    deps: undefined,
    instance: { id: "t1", stage: "s", idempotencyKey: "k", resumed: false },
    ...extra,
  };
}

const check = (over: Partial<TaskDefinition> = {}): TaskDefinition => ({
  name: "g.ok",
  kind: "check",
  description: "d",
  reads: ["item"],
  writes: [],
  invalidates: [],
  run: () => pass(),
  ...over,
});

describe("result helpers", () => {
  test("build results", () => {
    expect(pass()).toEqual({ status: "pass" });
    expect(pass(1)).toEqual({ status: "pass", output: 1 });
    expect(pending("wait", { after: 5 })).toEqual({ status: "pending", message: "wait", after: 5 });
    expect(pending("wait")).toEqual({ status: "pending", message: "wait" });
    expect(fail("no", { details: 1, route: { retry: true } })).toEqual({
      status: "fail", message: "no", details: 1, route: { retry: true },
    });
    expect(fail("no")).toEqual({ status: "fail", message: "no" });
  });
  test("InfrastructureError carries usageLimit", () => {
    const e = new InfrastructureError("x", { usageLimit: true });
    expect(e).toBeInstanceOf(Error);
    expect(e.usageLimit).toBe(true);
    expect(new InfrastructureError("y").usageLimit).toBeUndefined();
  });
});

describe("defineGroup", () => {
  test("accepts well-formed definitions", () => {
    const g = defineGroup("g", [check()]);
    expect(g.name).toBe("g");
    expect(g.definitions.map((d) => d.name)).toEqual(["g.ok"]);
  });
  test.each(["ok", "h.ok", "g.Ok", "g.ok_x", "g.", "g.a.b"])("rejects bad name %s", (name) => {
    expect(() => defineGroup("g", [check({ name })])).toThrow(/name/);
  });
  test("tools need input", () => {
    const tool = check({ kind: "tool", name: "g.t" });
    expect(() => defineGroup("g", [tool])).toThrow(/input/);
    expect(() => defineGroup("g", [{ ...tool, input: z.object({}) }])).not.toThrow();
  });
  test("loads write exactly one snapshot key", () => {
    const load = check({ kind: "load", name: "g.load", reads: [] });
    expect(() => defineGroup("g", [load])).toThrow(/exactly one/);
    expect(() => defineGroup("g", [{ ...load, writes: ["item", "ci"] }])).toThrow(/exactly one/);
    expect(() => defineGroup("g", [{ ...load, writes: ["agent"] }])).toThrow(/snapshot/);
    expect(() => defineGroup("g", [{ ...load, writes: ["ci"] }])).not.toThrow();
  });
  test("checks write and invalidate nothing", () => {
    expect(() => defineGroup("g", [check({ writes: ["agent"] })])).toThrow(/check/);
    expect(() => defineGroup("g", [check({ invalidates: ["ci"] })])).toThrow(/check/);
  });
  test("acts write only captured keys", () => {
    const act = check({ kind: "act", name: "g.do" });
    expect(() => defineGroup("g", [{ ...act, writes: ["item"] }])).toThrow(/captured/);
    expect(() => defineGroup("g", [{ ...act, writes: ["agent", "script"], invalidates: ["change"] }])).not.toThrow();
  });
});

describe("TaskRegistry", () => {
  const load = (name: string, key: "item" | "ci") =>
    check({ kind: "load", name, reads: [], writes: [key] });
  test("register, get, require, list", () => {
    const r = new TaskRegistry();
    r.register(defineGroup("g", [check(), load("g.load", "item")]));
    expect(r.get("g.ok")?.kind).toBe("check");
    expect(r.get("g.nope")).toBeUndefined();
    expect(r.require("g.ok").name).toBe("g.ok");
    expect(() => r.require("g.nope")).toThrow(/g\.nope/);
    expect(r.list().length).toBe(2);
    expect(r.list("load").map((d) => d.name)).toEqual(["g.load"]);
  });
  test("loaderFor", () => {
    const r = new TaskRegistry();
    r.register(defineGroup("g", [load("g.load", "item")]));
    expect(r.loaderFor("item")?.name).toBe("g.load");
    expect(r.loaderFor("ci")).toBeUndefined();
  });
  test("duplicate names throw", () => {
    const r = new TaskRegistry();
    r.register(defineGroup("g", [check()]));
    expect(() => r.register(defineGroup("g", [check()]))).toThrow(/duplicate/i);
  });
  test("two loaders for one key throw", () => {
    const r = new TaskRegistry();
    r.register(defineGroup("g", [load("g.load", "item")]));
    expect(() => r.register(defineGroup("h", [load("h.load", "item")]))).toThrow(/loader/i);
  });
});

describe("runTask", () => {
  test("a check cannot mutate its context", async () => {
    const def = check({
      reads: ["item", "checkpoints"],
      run: ({ context }) => {
        (context.item as { title: string }).title = "x";
        return pass();
      },
    });
    await expect(runTask(def, args())).rejects.toThrow();
    const nested = check({
      reads: ["item"],
      run: ({ context }) => {
        context.item!.labels.push("x");
        return pass();
      },
    });
    await expect(runTask(nested, args())).rejects.toThrow();
  });
  test("the original context is not frozen or altered", async () => {
    const ctx = context();
    await runTask(check(), args(ctx));
    expect(Object.isFrozen(ctx.item)).toBe(false);
  });
  test("a task cannot see undeclared keys", async () => {
    let seen: string[] = [];
    const def = check({
      reads: ["item"],
      run: ({ context }) => {
        seen = Object.keys(context);
        return pass();
      },
    });
    await runTask(def, args());
    expect(seen).toEqual(["item"]);
  });
  test("invalid with is rejected", async () => {
    const def = check({ config: z.object({ n: z.number() }) });
    await expect(runTask(def, args(context(), { config: { n: "x" } }))).rejects.toBeInstanceOf(TaskConfigError);
  });
  test("validated config is passed to run", async () => {
    let got: unknown;
    const def = check({
      config: z.object({ n: z.number().default(2) }),
      run: ({ config }) => {
        got = config;
        return pass();
      },
    });
    await runTask(def, args(context(), { config: {} }));
    expect(got).toEqual({ n: 2 });
  });
  test("checks get no deps and an empty idempotency key", async () => {
    let seen: TaskArgs | undefined;
    const def = check({ run: (a) => ((seen = a), pass()) });
    await runTask(def, args(context(), { deps: { db: 1 } }));
    expect(seen?.deps).toBeUndefined();
    expect(seen?.instance.idempotencyKey).toBe("");
  });
  test("acts keep deps and instance", async () => {
    let seen: TaskArgs | undefined;
    const def = check({ kind: "act", name: "g.do", run: (a) => ((seen = a), pass()) });
    await runTask(def, args(context(), { deps: { db: 1 } }));
    expect(seen?.deps).toEqual({ db: 1 });
    expect(seen?.instance.idempotencyKey).toBe("k");
  });
  test("returned result is validated", async () => {
    for (const bad of [undefined, null, { status: "nope" }, { status: "fail" }, { status: "pending" }, { status: "fail", message: "m", route: { x: 1 } }]) {
      const def = check({ run: () => bad as never });
      await expect(runTask(def, args())).rejects.toThrow(/result/i);
    }
    expect(await runTask(check({ run: () => fail("m", { route: { return: "a" } }) }), args())).toEqual({
      status: "fail", message: "m", route: { return: "a" },
    });
  });
  test("thrown errors propagate unchanged", async () => {
    const err = new InfrastructureError("boom", { usageLimit: true });
    const def = check({ run: () => { throw err; } });
    await expect(runTask(def, args())).rejects.toBe(err);
  });
  test("async run is awaited", async () => {
    expect(await runTask(check({ run: async () => pass(3) }), args())).toEqual({ status: "pass", output: 3 });
  });
});
