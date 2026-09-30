import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { configSchema, type ConveyorConfigData } from "../../src/config/schema";
import { defineGroup, pass, TaskRegistry, type TaskDefinition } from "../../src/tasks/contract";
import { compilePipeline, PlanError, renderPlan } from "../../src/tasks/plan";

type Def = Partial<TaskDefinition> & Pick<TaskDefinition, "name" | "kind">;

function def(input: Def): TaskDefinition {
  return { description: "", reads: [], writes: [], invalidates: [], run: () => pass(), ...input };
}

function registry(): TaskRegistry {
  const r = new TaskRegistry();
  const groups: Record<string, Def[]> = {
    item: [{ name: "item.load", kind: "load", writes: ["item"] }],
    workspace: [
      { name: "workspace.load", kind: "load", writes: ["workspace"] },
      { name: "workspace.ensure", kind: "act", reads: ["item"], invalidates: ["workspace"] },
      { name: "workspace.pushed", kind: "check", reads: ["workspace"] },
      { name: "workspace.clean", kind: "check", reads: ["workspace", "item"] },
    ],
    ci: [
      { name: "ci.load", kind: "load", writes: ["ci"] },
      { name: "ci.start", kind: "act", reads: ["item"], invalidates: ["ci"] },
      {
        name: "ci.passed",
        kind: "check",
        reads: ["ci"],
        defaultWait: { timeoutMs: 600_000, pollMs: 30_000 },
      },
    ],
    agent: [
      { name: "agent.run", kind: "act", reads: ["item", "workspace"], writes: ["agent"], invalidates: ["workspace"] },
      { name: "agent.done", kind: "check", reads: ["agent"] },
    ],
    script: [
      {
        name: "script.run",
        kind: "act",
        writes: ["script"],
        config: z.object({ recovery: z.enum(["replay-safe", "reconcile"]) }).passthrough(),
      },
      { name: "script.succeeded", kind: "check", reads: ["script"], config: z.object({ run: z.string() }) },
    ],
    tools: [{ name: "tools.comment", kind: "tool", input: z.object({}) }],
  };
  for (const [group, defs] of Object.entries(groups)) r.register(defineGroup(group, defs.map(def)));
  return r;
}

function build(pipeline: unknown, repositoryExtra: Record<string, unknown> = {}): ConveyorConfigData {
  return configSchema.parse({
    settings: { database: "/d", logs: "/l", workspaces: "/w", artifacts: "/a" },
    labels: {
      stageTemplate: "c:{stage}",
      states: { blocked: "c:blocked", done: "c:done" },
      metadata: { closable: "c:closable", orderTemplate: "c:order:{number}" },
    },
    sources: { github: { type: "github" } },
    pipelines: { delivery: pipeline },
    repositories: {
      sample: {
        source: "github",
        address: "o/r",
        folder: "/r",
        pipeline: "delivery",
        ...repositoryExtra,
      },
    },
  });
}

const stage = (id: string, actions: unknown[], gate: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  concurrency: 1,
  actions,
  "exit-gate": gate,
  ...extra,
});

function compile(pipeline: unknown, repositoryExtra: Record<string, unknown> = {}) {
  return compilePipeline({ config: build(pipeline, repositoryExtra), repositoryId: "sample", registry: registry() });
}

function errorsOf(pipeline: unknown, repositoryExtra: Record<string, unknown> = {}): string {
  try {
    compile(pipeline, repositoryExtra);
  } catch (error) {
    expect(error).toBeInstanceOf(PlanError);
    return (error as PlanError).message;
  }
  throw new Error("expected PlanError");
}

const simple = (actions: unknown[], gate: unknown[] = [{ task: "workspace.pushed" }]) => ({
  stages: [stage("impl", actions, gate)],
});

describe("compilePipeline", () => {
  test("defaults the instance id to the task name and merges wait defaults", () => {
    const plan = compile(simple([{ task: "workspace.ensure" }], [{ task: "ci.passed", wait: { poll: "5s" } }]));
    const s = plan.stages[0]!;
    expect(plan.id).toBe("delivery");
    expect(plan.repositoryId).toBe("sample");
    expect(s.retries).toBe(2);
    expect(s.legacy).toBe(false);
    expect(s.actions[0]!.id).toBe("workspace.ensure");
    // entry poll 5s, task default timeout 10m (pollMs from entry wins)
    expect(s.exitGate[0]!.wait).toEqual({ timeoutMs: 600_000, pollMs: 5_000 });
    // no entry or task default: settings.taskDefaults.wait
    expect(s.actions[0]!.wait).toEqual({ timeoutMs: 1_800_000, pollMs: 60_000 });
    expect(s.actions[0]!.onFail).toBeNull();
  });

  test("entry unlimited timeout wins over defaults", () => {
    const plan = compile(simple([], [{ task: "ci.passed", wait: { timeout: "unlimited" } }]));
    expect(plan.stages[0]!.exitGate[0]!.wait).toEqual({ timeoutMs: null, pollMs: 30_000 });
  });

  test("computes implicit loads, invalidation and fresh loads for the exit gate", () => {
    const plan = compile(
      simple(
        [{ task: "workspace.ensure" }, { task: "agent.run" }],
        [{ task: "workspace.pushed" }, { task: "workspace.clean" }],
      ),
    );
    const [ensure, agent] = plan.stages[0]!.actions;
    expect(ensure!.implicitLoads).toEqual(["item"]);
    // workspace never loaded; item still loaded; ensure invalidated workspace (nothing loaded yet)
    expect(agent!.implicitLoads).toEqual(["workspace"]);
    const [pushed, clean] = plan.stages[0]!.exitGate;
    expect(pushed!.implicitLoads).toEqual(["workspace"]);
    expect(clean!.implicitLoads).toEqual(["item"]);
  });

  test("an act invalidates a snapshot so a later reader reloads it", () => {
    const plan = compile(
      simple([{ id: "first", task: "agent.run" }, { task: "workspace.ensure" }, { id: "again", task: "agent.run" }]),
    );
    const again = plan.stages[0]!.actions[2]!;
    expect(again.implicitLoads).toEqual(["workspace"]);
    expect(plan.stages[0]!.actions[0]!.implicitLoads).toEqual(["item", "workspace"]);
  });

  test("errors on duplicate task names without ids and duplicate ids", () => {
    const message = errorsOf(
      simple([{ task: "workspace.ensure" }, { task: "workspace.ensure" }, { id: "x", task: "agent.run" }, { id: "x", task: "agent.run" }]),
    );
    expect(message).toContain("pipelines.delivery.stages[0].actions[0]");
    expect(message).toMatch(/needs an explicit id/);
    expect(message).toContain("actions[3]");
    expect(message).toMatch(/duplicate instance id "x"/);
  });

  test("guards resolve from the repository ci mode", () => {
    const pipeline = simple(
      [{ task: "workspace.ensure" }, { task: "ci.start", when: "ci.enabled" }],
      [{ task: "workspace.pushed" }, { task: "ci.passed", when: "ci.required" }],
    );
    const ids = (plan: ReturnType<typeof compile>) => [
      plan.stages[0]!.actions.map((t) => t.id),
      plan.stages[0]!.exitGate.map((t) => t.id),
    ];
    expect(ids(compile(pipeline, { ci: { mode: "required" } }))).toEqual([
      ["workspace.ensure", "ci.start"],
      ["workspace.pushed", "ci.passed"],
    ]);
    expect(ids(compile(pipeline, { ci: { mode: "advisory" } }))).toEqual([
      ["workspace.ensure", "ci.start"],
      ["workspace.pushed"],
    ]);
    expect(ids(compile(pipeline, { ci: { mode: "disabled" } }))).toEqual([
      ["workspace.ensure"],
      ["workspace.pushed"],
    ]);
    expect(ids(compile(pipeline, {}))).toEqual([
      ["workspace.ensure", "ci.start"],
      ["workspace.pushed", "ci.passed"],
    ]);
  });

  test("an exit gate emptied by guards is an error", () => {
    const message = errorsOf(simple([], [{ task: "ci.passed", when: "ci.required" }]), { ci: { mode: "disabled" } });
    expect(message).toMatch(/exit-gate is empty/);
  });

  test("overrides replace with and onFail, merge wait, by instance id", () => {
    const plan = compile(
      simple(
        [{ id: "run", task: "script.run", with: { recovery: "replay-safe", script: "/a" }, wait: { timeout: "1m", poll: "2s" } }],
        [{ task: "script.succeeded", with: { run: "run" } }],
      ),
      {
        overrides: {
          stages: {
            impl: {
              actions: { run: { with: { recovery: "reconcile", script: "/b" }, wait: { poll: "9s" }, onFail: "retry" } },
            },
          },
        },
      },
    );
    const run = plan.stages[0]!.actions[0]!;
    expect(run.with).toEqual({ recovery: "reconcile", script: "/b" });
    expect(run.wait).toEqual({ timeoutMs: 60_000, pollMs: 9_000 });
    expect(run.onFail).toEqual({ retry: true });
  });

  test("errors on overrides naming an unknown stage, list or instance", () => {
    const message = errorsOf(simple([{ task: "workspace.ensure" }]), {
      overrides: {
        stages: {
          nope: { actions: { a: {} } },
          impl: { actions: { missing: {} }, "exit-gate": { ghost: {} } },
        },
      },
    });
    expect(message).toMatch(/unknown stage "nope"/);
    expect(message).toMatch(/unknown instance "missing"/);
    expect(message).toMatch(/exit-gate.*unknown instance "ghost"/);
  });

  test("validates kinds and registry membership", () => {
    const message = errorsOf(
      simple(
        [{ task: "workspace.pushed" }, { task: "tools.comment" }, { task: "item.load" }, { task: "no.such" }],
        [{ task: "workspace.ensure" }],
      ),
    );
    expect(message).toMatch(/actions\[0\].*check.*only act/);
    expect(message).toMatch(/actions\[1\].*tool/);
    expect(message).toMatch(/actions\[2\].*load/);
    expect(message).toMatch(/actions\[3\].*unknown task "no.such"/);
    expect(message).toMatch(/exit-gate\[0\].*act.*only check/);
  });

  test("validates with against the task schema and requires a script recovery", () => {
    const message = errorsOf(
      simple(
        [{ task: "script.run", with: { script: "/x" } }],
        [{ task: "script.succeeded", with: { run: "script.run" } }],
      ),
    );
    expect(message).toMatch(/actions\[0\].*recovery/);
  });

  test("validates onFail routes", () => {
    const pipeline = {
      stages: [
        stage("a", [], [{ task: "workspace.pushed", onFail: { return: "ghost" } }]),
        stage("b", [], [{ task: "workspace.pushed", onFail: { return: "b" } }, { id: "s", task: "workspace.clean", onFail: { stop: "nowhere" } }]),
        stage("c", [], [{ task: "workspace.pushed", onFail: { return: "a" } }, { id: "s", task: "workspace.clean", onFail: { stop: "blocked" } }]),
      ],
    };
    const message = errorsOf(pipeline);
    expect(message).toMatch(/stages\[0\].exit-gate\[0\].*return.*unknown stage "ghost"/);
    expect(message).toMatch(/stages\[1\].exit-gate\[0\].*another stage/);
    expect(message).toMatch(/stages\[1\].exit-gate\[1\].*stop.*"nowhere"/);
    expect(message).not.toContain("stages[2]");
  });

  test("dataflow: captured keys need an earlier act in the same stage", () => {
    const message = errorsOf({
      stages: [stage("impl", [], [{ task: "agent.done" }])],
    });
    expect(message).toMatch(/exit-gate\[0\].*reads agent.*earlier act/);
    const ordered = errorsOf(simple([{ task: "workspace.ensure" }], [{ task: "agent.done" }]));
    expect(ordered).toMatch(/reads agent/);
    expect(() => compile(simple([{ task: "agent.run" }], [{ task: "agent.done" }]))).not.toThrow();
  });

  test("dataflow: an unregistered loader is an error", () => {
    const r = new TaskRegistry();
    r.register(defineGroup("workspace", [def({ name: "workspace.pushed", kind: "check", reads: ["workspace"] })]));
    expect(() =>
      compilePipeline({ config: build(simple([], [{ task: "workspace.pushed" }])), repositoryId: "sample", registry: r }),
    ).toThrow(/no loader is registered for it/);
  });

  test("script.succeeded must name a script.run instance in the same stage", () => {
    const bad = errorsOf(
      simple([{ id: "go", task: "script.run", with: { recovery: "reconcile" } }], [{ task: "script.succeeded", with: { run: "other" } }]),
    );
    expect(bad).toMatch(/with\.run.*"other"/);
    const notScript = errorsOf(
      simple([{ id: "go", task: "workspace.ensure" }], [{ task: "script.succeeded", with: { run: "go" } }]),
    );
    expect(notScript).toMatch(/with\.run.*"go"/);
    const ok = compile(
      simple([{ id: "go", task: "script.run", with: { recovery: "reconcile" } }], [{ task: "script.succeeded", with: { run: "go" } }]),
    );
    expect(ok.stages[0]!.exitGate[0]!.implicitLoads).toEqual([]);
  });

  test("collects every error in one PlanError with the repository named", () => {
    try {
      compile(simple([{ task: "no.such" }, { task: "also.missing" }]));
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanError);
      expect((error as PlanError).errors).toHaveLength(2);
      expect((error as PlanError).message).toContain("sample");
    }
  });

  test("legacy stages are not yet supported and only throw when compiled", () => {
    const legacy = {
      successStatuses: ["done"],
      failureStatuses: ["blocked"],
      stages: [{ id: "old", concurrency: 1, run: { sourceAction: "noop" } }],
    };
    expect(() => compile(legacy)).toThrow(/legacy stage "old" not yet supported/);
  });

  test("carries childrenStartAt and concurrency", () => {
    const plan = compile({ stages: [stage("impl", [], [{ task: "workspace.pushed" }], { childrenStartAt: "next", retries: 4, concurrency: 3 })] });
    expect(plan.stages[0]).toMatchObject({ id: "impl", concurrency: 3, retries: 4, childrenStartAt: "next" });
  });
});

describe("renderPlan", () => {
  test("renders numbered lists, implicit loads, wait and onFail", () => {
    const plan = compile(
      {
        stages: [
          stage(
            "impl",
            [{ task: "agent.run", with: { agent: "implementer" } }],
            [
              { task: "workspace.pushed", onFail: "retry" },
              { id: "ciGate", task: "ci.passed", when: "ci.required", onFail: { return: "review" } },
            ],
            { childrenStartAt: "next" },
          ),
          stage("review", [], [{ task: "workspace.pushed", onFail: { stop: "blocked" } }]),
        ],
      },
      { ci: { mode: "advisory" } },
    );
    const text = renderPlan(plan);
    expect(text).toContain("sample");
    expect(text).toContain("Stage impl");
    expect(text).toContain("childrenStartAt next");
    expect(text).toContain("actions");
    expect(text).toContain("exit-gate");
    expect(text).toMatch(/\(load workspace\)\n\s+1\. agent\.run/);
    expect(text).toContain('with {"agent":"implementer"}');
    expect(text).toMatch(/\(load workspace\)\n\s+1\. workspace\.pushed/);
    expect(text).toContain("onFail retry");
    expect(text).toContain("onFail stop blocked");
    expect(text).toContain("wait timeout 30m, poll 1m");
    // guard resolved away in advisory mode
    expect(text).not.toContain("ciGate");
    expect(text).toContain("(none)");
  });

  test("renders explicit ids and unlimited timeouts", () => {
    const text = renderPlan(compile(simple([], [{ id: "gate", task: "ci.passed", wait: { timeout: "unlimited" } }])));
    expect(text).toContain("gate: ci.passed");
    expect(text).toContain("timeout unlimited, poll 30s");
    expect(text).toContain("onFail retry (default)");
  });
});
