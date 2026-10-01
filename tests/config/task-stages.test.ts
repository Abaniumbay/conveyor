import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../../src/config/load";
import { isNativeStage, type NativeStageConfig } from "../../src/config/schema";

const directories: string[] = [];

const HEADER = `
settings:
  database: /tmp/conveyor.sqlite
  logs: /tmp/logs
  workspaces: /tmp/workspaces
  artifacts: /tmp/artifacts
labels:
  stageTemplate: "conveyor:{stage}"
  states: { done: conveyor:done }
  metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" }
sources:
  github: { type: github }
`;

function repository(extra = ""): string {
  return `
repositories:
  sample:
    source: github
    address: owner/sample
    folder: /tmp/sample
    pipeline: default
${extra}`;
}

async function load(body: string, options: { header?: string } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-task-stages-"));
  directories.push(directory);
  await writeFile(path.join(directory, "config.yml"), (options.header ?? HEADER) + body);
  return { directory, config: await loadConfig(directory, null) };
}

const NATIVE_PIPELINE = `
pipelines:
  default:
    stages:
      - id: implementation
        concurrency: 2
        childrenStartAt: next
        actions:
          - { id: workspace, task: workspace.ensure }
          - { id: startCi, task: ci.start, when: ci.enabled }
        exit-gate:
          - { id: pushed, task: workspace.pushed, onFail: retry }
          - id: ciGate
            task: ci.passed
            when: ci.required
            wait: { timeout: unlimited, poll: 5m }
            onFail: { return: implementation }
          - { id: stopper, task: x.y, onFail: { stop: blocked } }
      - id: review
        concurrency: 1
        actions: []
        exit-gate:
          - { task: change.mergeable, wait: { timeout: 30m } }
`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("task-chain stage configuration", () => {
  test("normalises a native stage", async () => {
    const { config } = await load(NATIVE_PIPELINE + repository());
    const stage = config.pipelines.default!.stages[0]!;
    expect(isNativeStage(stage)).toBe(true);
    const native = stage as NativeStageConfig;
    expect(native.retries).toBe(2);
    expect(native.childrenStartAt).toBe("next");
    expect(native.actions[1]).toEqual({ id: "startCi", task: "ci.start", when: "ci.enabled" });
    expect("exit-gate" in native).toBe(false);
    expect(native.exitGate[0]!.onFail).toEqual({ retry: true });
    expect(native.exitGate[1]).toEqual({
      id: "ciGate",
      task: "ci.passed",
      when: "ci.required",
      wait: { timeoutMs: null, pollMs: 300_000 },
      onFail: { return: "implementation" },
    });
    expect(native.exitGate[2]!.onFail).toEqual({ stop: "blocked" });
    const review = config.pipelines.default!.stages[1] as NativeStageConfig;
    expect(review.exitGate[0]!.wait).toEqual({ timeoutMs: 1_800_000 });
    expect(config.pipelines.default!.successStatuses).toBeUndefined();
  });

  test("rejects an empty exit gate", async () => {
    await expect(
      load(`
pipelines:
  default:
    stages:
      - { id: a, concurrency: 1, actions: [], exit-gate: [] }
`),
    ).rejects.toThrow(/exit-gate/);
  });

  test("rejects a stage that mixes native and legacy shapes", async () => {
    await expect(
      load(`
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: a
        concurrency: 1
        run: { sourceAction: noop }
        actions: []
        exit-gate: [{ task: x.y }]
`),
    ).rejects.toThrow(/either native .* or legacy/);
  });

  test("requires statuses when the pipeline has a legacy stage, and allows mixing", async () => {
    const mixed = `
      - id: old
        concurrency: 1
        run: { sourceAction: noop }
      - id: fresh
        concurrency: 1
        actions: []
        exit-gate: [{ task: x.y }]
`;
    await expect(load(`\npipelines:\n  default:\n    stages:${mixed}`)).rejects.toThrow(/successStatuses is required/);
    const { config } = await load(
      `\npipelines:\n  default:\n    successStatuses: [done]\n    failureStatuses: [blocked]\n    stages:${mixed}`,
    );
    expect(config.pipelines.default!.stages.map(isNativeStage)).toEqual([false, true]);
  });

  test("legacy stages still load unchanged", async () => {
    const { config } = await load(`
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: inspect
        run: { sourceAction: noop }
        concurrency: 1
` + repository());
    const stage = config.pipelines.default!.stages[0]!;
    expect(isNativeStage(stage)).toBe(false);
    expect(stage).toMatchObject({ id: "inspect", run: { type: "source-action", action: "noop" }, failurePolicies: {}, afterSuccess: [] });
  });

  test("rejects an unknown childrenStartAt on a native stage", async () => {
    await expect(
      load(`
pipelines:
  default:
    stages:
      - { id: a, concurrency: 1, childrenStartAt: nowhere, actions: [], exit-gate: [{ task: x.y }] }
` + repository()),
    ).rejects.toThrow(/childrenStartAt references unknown stage "nowhere"/);
  });
});

describe("settings for task chains", () => {
  test("defaults", async () => {
    const { config } = await load("");
    expect(config.settings.maxReturns).toBe(5);
    expect(config.settings.taskDefaults).toEqual({ wait: { timeoutMs: 1_800_000, pollMs: 60_000 } });
    expect(config.settings.history).toEqual({ contextSummaryBytes: 65536 });
  });

  test("explicit values including unlimited", async () => {
    const { config } = await load("", {
      header: HEADER.replace(
        "  artifacts: /tmp/artifacts\n",
        "  artifacts: /tmp/artifacts\n  maxReturns: 3\n  history: { contextSummaryBytes: 1024 }\n  taskDefaults:\n    wait: { timeout: unlimited, poll: 10s }\n",
      ),
    });
    expect(config.settings.maxReturns).toBe(3);
    expect(config.settings.taskDefaults.wait).toEqual({ timeoutMs: null, pollMs: 10_000 });
    expect(config.settings.history.contextSummaryBytes).toBe(1024);
  });
});

describe("repository ci and overrides", () => {
  const pipeline = NATIVE_PIPELINE;

  test("absent ci is source-native and required", async () => {
    const { config } = await load(pipeline + repository());
    expect(config.repositories.sample!.ci).toEqual({ provider: null, mode: "required", ignoreChecks: [] });
  });

  test("legacy string names the provider", async () => {
    const { config } = await load(`
ci:
  actions: { type: github-actions }
` + pipeline + repository("    ci: actions\n"));
    expect(config.repositories.sample!.ci).toEqual({ provider: "actions", mode: "required", ignoreChecks: [] });
  });

  test("object form", async () => {
    const { config } = await load(pipeline + repository("    ci: { mode: advisory, ignoreChecks: [Lint] }\n"));
    expect(config.repositories.sample!.ci).toEqual({ provider: null, mode: "advisory", ignoreChecks: ["Lint"] });
    const named = await load(`
ci:
  actions: { type: github-actions }
` + pipeline + repository("    ci: { provider: actions, mode: disabled }\n"));
    expect(named.config.repositories.sample!.ci).toEqual({ provider: "actions", mode: "disabled", ignoreChecks: [] });
  });

  test("rejects an unknown mode and an unknown provider", async () => {
    await expect(load(pipeline + repository("    ci: { mode: sometimes }\n"))).rejects.toThrow(/ci/);
    await expect(load(pipeline + repository("    ci: { provider: nope, mode: required }\n"))).rejects.toThrow(
      /unknown CI provider "nope"/,
    );
  });

  test("parses stable-id overrides and resolves script paths", async () => {
    const { config, directory } = await load(
      `
pipelines:
  default:
    stages:
      - id: deploy
        concurrency: 1
        actions:
          - { id: deployScript, task: script.run, with: { script: ./stages/deploy.ts } }
        exit-gate:
          - { id: deployed, task: script.succeeded, with: { run: deployScript } }
` + repository(`    overrides:
      stages:
        deploy:
          actions:
            deployScript: { with: { script: ./sample/deploy.ts } }
          exit-gate:
            deployed: { wait: { timeout: unlimited }, onFail: { stop: needs-intervention } }
`),
    );
    const stage = config.pipelines.default!.stages[0] as NativeStageConfig;
    expect(stage.actions[0]!.with).toEqual({ script: path.join(directory, "stages/deploy.ts") });
    expect(config.repositories.sample!.overrides).toEqual({
      stages: {
        deploy: {
          actions: { deployScript: { with: { script: path.join(directory, "sample/deploy.ts") } } },
          exitGate: { deployed: { wait: { timeoutMs: null }, onFail: { stop: "needs-intervention" } } },
        },
      },
    });
  });
});

describe("repository agentEgress", () => {
  test("defaults to loopback MCP only", async () => {
    const { config } = await load(NATIVE_PIPELINE + repository());
    expect(config.repositories.sample!.agentEgress).toEqual({ allowLoopbackMcp: true, httpsHosts: [] });
  });

  test("accepts exact hosts", async () => {
    const { config } = await load(
      NATIVE_PIPELINE + repository("    agentEgress: { allowLoopbackMcp: false, httpsHosts: [registry.npmjs.org, github.com] }\n"),
    );
    expect(config.repositories.sample!.agentEgress).toEqual({
      allowLoopbackMcp: false,
      httpsHosts: ["registry.npmjs.org", "github.com"],
    });
  });

  test("names the offending entry and rule", async () => {
    await expect(
      load(NATIVE_PIPELINE + repository('    agentEgress: { httpsHosts: [a.example.com, b.example.com, "*.npmjs.org"] }\n')),
    ).rejects.toThrow('agentEgress.httpsHosts[2] "*.npmjs.org": wildcards are not allowed');
    await expect(
      load(NATIVE_PIPELINE + repository("    agentEgress: { httpsHosts: [api.github.com] }\n")),
    ).rejects.toThrow("provider APIs are never reachable from agent sandboxes");
  });

  test("rejects unknown keys", async () => {
    await expect(load(NATIVE_PIPELINE + repository("    agentEgress: { hosts: [] }\n"))).rejects.toThrow();
  });
});
