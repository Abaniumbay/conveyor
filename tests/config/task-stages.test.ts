import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { loadConfig } from "../../src/config/load";
import type { Plugin } from "../../src/core/plugins";
import { PLUGINS } from "../../src/plugins";
import { piProfile } from "../../src/plugins/pi/profile";
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

async function load(body: string, options: { header?: string; plugins?: readonly Plugin[] } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-task-stages-"));
  directories.push(directory);
  await writeFile(path.join(directory, "config.yml"), (options.header ?? HEADER) + body);
  return { directory, config: await loadConfig(directory, null, { plugins: options.plugins ?? PLUGINS }) };
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

  test("validates extra trusted GitHub logins", async () => {
    const { config } = await load(
      NATIVE_PIPELINE + repository("    extraTrustedLogins: [Review-Bot, 'Reviewer[Bot]', maintainer]\n"),
    );
    expect(config.repositories.sample!.extraTrustedLogins).toEqual(["Review-Bot", "Reviewer[Bot]", "maintainer"]);
    await expect(load(NATIVE_PIPELINE + repository("    extraTrustedLogins: [not_valid]\n"))).rejects.toThrow(/GitHub login/);
    await expect(load(NATIVE_PIPELINE + repository("    extraTrustedLogins: ['reviewer[agent]']\n"))).rejects.toThrow(
      /GitHub login/,
    );
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

describe("GitHub cache settings", () => {
  const withCache = (cache: string) => ({ header: HEADER.replace("  artifacts: /tmp/artifacts\n", `  artifacts: /tmp/artifacts\n  githubCache:\n${cache}`) });

  test("defaults: an hour for issues, changes and permissions, 15 minutes for running checks, finished checks kept", async () => {
    const { config } = await load("");
    expect(config.settings.githubCache).toEqual({
      issue: 60 * 60_000, change: 60 * 60_000, permission: 60 * 60_000, runningChecks: 15 * 60_000, finishedChecks: Number.POSITIVE_INFINITY, other: 60 * 60_000,
    });
  });

  test("each lifetime is configurable", async () => {
    const { config } = await load("", withCache("    issue: 30m\n    finishedChecks: 1d\n"));
    expect(config.settings.githubCache).toMatchObject({ issue: 30 * 60_000, finishedChecks: 86_400_000 });
  });

  test("an unknown kind of data is an error", async () => {
    await expect(load("", withCache("    reviews: 5m\n"))).rejects.toThrow(/reviews/);
  });
});

describe("event settings", () => {
  const withEvents = (events: string) => ({ header: HEADER.replace("  artifacts: /tmp/artifacts\n", `  artifacts: /tmp/artifacts\n  events:\n${events}`) });

  test("defaults: 30 days of events, no sink and fallbacks by kind of wait", async () => {
    const { config } = await load("");
    expect(config.settings.events).toEqual({
      retentionMs: 30 * 86_400_000,
      sinks: [],
      fallbackMs: { default: 15 * 60_000, ci: 5 * 60_000, change: 10 * 60_000, dependencies: 30 * 60_000 },
    });
  });

  test("a retention and a JSON-lines sink", async () => {
    const { config } = await load("", withEvents("    retention: 7d\n    sinks: [{ type: jsonl, path: /var/log/conveyor/events.jsonl }]\n"));
    expect(config.settings.events).toMatchObject({ retentionMs: 7 * 86_400_000, sinks: [{ type: "jsonl", path: "/var/log/conveyor/events.jsonl" }] });
  });

  test("a sink receives facts and observations without content unless it selects otherwise", async () => {
    const { config } = await load("", withEvents("    sinks: [{ type: jsonl, path: /var/log/conveyor/events.jsonl }]\n"));
    expect(config.settings.events.sinks).toEqual([{ type: "jsonl", path: "/var/log/conveyor/events.jsonl", classes: ["fact", "ingest"], includeContent: false }]);
  });

  test("a sink may select traces and content", async () => {
    const { config } = await load("", withEvents("    sinks: [{ type: jsonl, path: /var/log/conveyor/events.jsonl, classes: [trace], includeContent: true }]\n"));
    expect(config.settings.events.sinks[0]).toMatchObject({ classes: ["trace"], includeContent: true });
  });

  test("an unknown event class is an error", async () => {
    await expect(load("", withEvents("    sinks: [{ type: jsonl, path: /var/log/conveyor/events.jsonl, classes: [gossip] }]\n"))).rejects.toThrow(/classes/);
  });

  test("fallbacks are configurable", async () => {
    const { config } = await load("", withEvents("    fallback: { ci: 2m, dependencies: 1h }\n"));
    expect(config.settings.events).toMatchObject({
      fallbackMs: { default: 15 * 60_000, ci: 2 * 60_000, change: 10 * 60_000, dependencies: 60 * 60_000 },
    });
  });

  test("the former safety-net reconcile intervals are accepted with a deprecation warning", async () => {
    const { config } = await load("", withEvents("    reconcileInterval: 1h\n    fullReconcileInterval: 12h\n"));
    // This fixture loads a configuration directory, which brings its own deprecation warning.
    expect(config.warnings?.filter((warning) => warning.startsWith("settings.events."))).toEqual([
      expect.stringMatching(/^settings\.events\.reconcileInterval is deprecated and has no effect/),
      expect.stringMatching(/^settings\.events\.fullReconcileInterval is deprecated and has no effect/),
    ]);
  });

  test("an unknown kind of wait is an error", async () => {
    await expect(load("", withEvents("    fallback: { deploy: 5m }\n"))).rejects.toThrow(/deploy/);
  });

  test("a sink path must be absolute", async () => {
    await expect(load("", withEvents("    sinks: [{ type: jsonl, path: events.jsonl }]\n"))).rejects.toThrow(/absolute path/);
  });

  test("an unknown sink type is an error", async () => {
    await expect(load("", withEvents("    sinks: [{ type: kafka, path: /tmp/x }]\n"))).rejects.toThrow(/sinks/);
  });

  test("an unknown key is an error", async () => {
    await expect(load("", withEvents("    keep: 7d\n"))).rejects.toThrow(/keep/);
  });
});

describe("repository ci and overrides", () => {
  const pipeline = NATIVE_PIPELINE;

  test("absent ci is source-native and required", async () => {
    const { config } = await load(pipeline + repository());
    expect(config.repositories.sample!.ci).toEqual({ provider: null, mode: "required", ignoreChecks: [] });
    expect(config.warnings?.some((warning) => warning.includes("repositories.sample.ci.junit is not configured"))).toBe(true);
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

  test("accepts a JUnit artifact locator and rejects unsafe locator values", async () => {
    const { config } = await load(pipeline + repository("    ci: { mode: required, junit: { artifact: test-results, path: reports/**/*.xml } }\n"));
    expect(config.repositories.sample!.ci.junit).toEqual({ artifact: "test-results", path: "reports/**/*.xml" });
    await expect(load(pipeline + repository("    ci: { mode: required, junit: { artifact: '', path: /reports.xml } }\n"))).rejects.toThrow(/artifact|path/);
    await expect(load(pipeline + repository("    ci: { mode: required, junit: { artifact: test-results, path: ../reports.xml } }\n"))).rejects.toThrow(/relative path pattern/);
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
  test("is absent (no enforcement, legacy behaviour) unless the repository declares it", async () => {
    const { config } = await load(NATIVE_PIPELINE + repository());
    expect(config.repositories.sample!.agentEgress).toBeUndefined();
  });

  test("an empty block enforces loopback MCP only", async () => {
    const { config } = await load(NATIVE_PIPELINE + repository("    agentEgress: {}\n"));
    expect(config.repositories.sample!.agentEgress).toEqual({ allowLoopbackMcp: true, httpsHosts: [], localServices: [] });
  });

  test("accepts exact hosts", async () => {
    const { config } = await load(
      NATIVE_PIPELINE + repository("    agentEgress: { allowLoopbackMcp: false, httpsHosts: [registry.npmjs.org, github.com] }\n"),
    );
    expect(config.repositories.sample!.agentEgress).toEqual({
      allowLoopbackMcp: false,
      httpsHosts: ["registry.npmjs.org", "github.com"],
      localServices: [],
    });
  });

  test("accepts named Unix local services at fixed loopback endpoints", async () => {
    const { config } = await load(NATIVE_PIPELINE + repository(`    agentEgress:
      localServices:
        - name: postgres
          socket: /run/postgresql/.s.PGSQL.5432
          endpoint: 127.0.0.1:5432
          environment:
            DATABASE_URL: postgres://conveyor@127.0.0.1:5432/test
`));
    expect(config.repositories.sample!.agentEgress!.localServices).toEqual([{
      name: "postgres",
      socket: "/run/postgresql/.s.PGSQL.5432",
      endpoint: "127.0.0.1:5432",
      environment: { DATABASE_URL: "postgres://conveyor@127.0.0.1:5432/test" },
    }]);
  });

  test("accepts a named local TCP service at a numeric loopback address", async () => {
    const { config } = await load(NATIVE_PIPELINE + repository(`    agentEgress:
      localServices:
        - { name: redis, tcp: "127.0.0.1:6379", endpoint: 127.0.0.1:6379 }
`));
    expect(config.repositories.sample!.agentEgress!.localServices).toEqual([
      { name: "redis", tcp: "127.0.0.1:6379", endpoint: "127.0.0.1:6379", environment: {} },
    ]);
  });

  test.each(["10.0.0.5:6379", "192.168.1.2:6379", "localhost:6379", "example.com:6379"])("rejects a non-loopback local TCP host %p", async (tcp) => {
    await expect(load(NATIVE_PIPELINE + repository(`    agentEgress:
      localServices:
        - { name: redis, tcp: "${tcp}", endpoint: 127.0.0.1:6379 }
`))).rejects.toThrow("numeric loopback address");
  });

  test.each(["0.0.0.0:6379", "[::]:6379"])("rejects a wildcard local TCP bind address %p", async (tcp) => {
    await expect(load(NATIVE_PIPELINE + repository(`    agentEgress:
      localServices:
        - { name: redis, tcp: "${tcp}", endpoint: 127.0.0.1:6379 }
`))).rejects.toThrow("wildcard and non-loopback addresses are not allowed");
  });

  test("rejects a duplicate name across Unix-socket and TCP entries", async () => {
    await expect(load(NATIVE_PIPELINE + repository(`    agentEgress:
      localServices:
        - { name: db, socket: /run/db.sock, endpoint: 127.0.0.1:5432 }
        - { name: db, tcp: "127.0.0.1:6379", endpoint: 127.0.0.1:6379 }
`))).rejects.toThrow('duplicate of localServices[0]');
  });

  test("rejects a service that declares both or neither of socket and tcp", async () => {
    await expect(load(NATIVE_PIPELINE + repository(`    agentEgress:
      localServices:
        - { name: db, socket: /run/db.sock, tcp: "127.0.0.1:6379", endpoint: 127.0.0.1:6379 }
`))).rejects.toThrow("exactly one of socket or tcp");
    await expect(load(NATIVE_PIPELINE + repository(`    agentEgress:
      localServices:
        - { name: db, endpoint: 127.0.0.1:6379 }
`))).rejects.toThrow("exactly one of socket or tcp");
  });

  test("rejects unknown local-service keys", async () => {
    await expect(load(NATIVE_PIPELINE + repository(`    agentEgress:
      localServices:
        - name: postgres
          socket: /run/postgresql/.s.PGSQL.5432
          endpoint: 127.0.0.1:5432
          unexpected: true
`))).rejects.toThrow();
  });

  test("rejects duplicate local-service names", async () => {
    await expect(load(NATIVE_PIPELINE + repository(`    agentEgress:
      localServices:
        - { name: postgres, socket: /run/postgresql/.s.PGSQL.5432, endpoint: 127.0.0.1:5432 }
        - { name: postgres, socket: /run/postgresql/.s.PGSQL.5433, endpoint: 127.0.0.1:5433 }
`))).rejects.toThrow('duplicate of localServices[0]');
  });

  test("rejects duplicate local-service endpoints", async () => {
    await expect(load(NATIVE_PIPELINE + repository(`    agentEgress:
      localServices:
        - { name: postgres, socket: /run/postgresql/.s.PGSQL.5432, endpoint: 127.0.0.1:5432 }
        - { name: replica, socket: /run/postgresql/.s.PGSQL.5433, endpoint: 127.0.0.1:5432 }
`))).rejects.toThrow('localServices[1].endpoint "127.0.0.1:5432": duplicate of localServices[0]');
  });

  test("names the offending entry and rule", async () => {
    await expect(
      load(NATIVE_PIPELINE + repository('    agentEgress: { httpsHosts: [a.example.com, b.example.com, "*.npmjs.org"] }\n')),
    ).rejects.toThrow('agentEgress.httpsHosts[2] "*.npmjs.org": wildcards are not allowed');
  });

  test("lets the operator list a code host's API", async () => {
    const { config } = await load(NATIVE_PIPELINE + repository("    agentEgress: { httpsHosts: [api.github.com] }\n"));
    expect(config.repositories.sample!.agentEgress?.httpsHosts).toEqual(["api.github.com"]);
  });

  test("rejects unknown keys", async () => {
    await expect(load(NATIVE_PIPELINE + repository("    agentEgress: { hosts: [] }\n"))).rejects.toThrow();
  });

  const pipeline = (stage: string) => `
pipelines:
  default:
    stages:
${stage}`;

  describe("agents of a harness that cannot enforce it", () => {
    // No shipped harness lacks egress any more; a stand-in plugin keeps the rule covered.
    const legacyPlugin: Plugin = {
      role: "harness",
      type: "legacy",
      configSchema: z.object({ type: z.literal("legacy"), command: z.string().default("legacy") }).strict(),
      profile: { ...piProfile, name: "Legacy", agentEgress: false },
      create: () => { throw new Error("not started in this test"); },
    };
    const agents = `
runners:
  claude: { type: claude-code }
  legacy: { type: legacy }
agents:
  claude-worker: { runner: claude, instructions: /tmp/worker.md, workspaceAccess: read-only }
  legacy-worker: { runner: legacy, instructions: /tmp/worker.md, workspaceAccess: read-only }
`;
    const fallback = "      - { id: review, concurrency: 1, actions: [{ task: agent.run, with: { agents: [claude-worker, legacy-worker] } }], exit-gate: [{ task: item.criteriaDefined }] }\n";
    const loadWithLegacy = (body: string) => load(body, { plugins: [...PLUGINS, legacyPlugin] });

    test("an agent of such a harness in an agent.run fallback list is refused with a message naming it", async () => {
      await expect(loadWithLegacy(agents + pipeline(fallback) + repository("    agentEgress: {}\n")))
        .rejects.toThrow('repositories.sample.agentEgress cannot be enforced for agent "legacy-worker", which runs on Legacy');
    });

    test("the same pipeline is accepted where the repository declares no agentEgress", async () => {
      const { config } = await loadWithLegacy(agents + pipeline(fallback) + repository());
      expect(config.agents["legacy-worker"]?.runner).toBe("legacy");
    });
  });

  describe("pi runners need control-plane hosts", () => {
    const agents = (runner: string) => `
runners:
  claude: { type: claude-code }
  pi: ${runner}
agents:
  claude-worker: { runner: claude, instructions: /tmp/worker.md, workspaceAccess: read-only }
  pi-worker: { runner: pi, instructions: /tmp/worker.md, workspaceAccess: read-only }
`;
    const fallback = "      - { id: review, concurrency: 1, actions: [{ task: agent.run, with: { agents: [claude-worker, pi-worker] } }], exit-gate: [{ task: item.criteriaDefined }] }\n";
    const required = 'runners.pi.controlPlaneHosts is required: runner "pi" runs agent "pi-worker" in repository "sample", which declares agentEgress';

    test("a pi runner with neither controlPlaneHosts nor a provider with default hosts is refused, naming the runner", async () => {
      await expect(load(agents("{ type: pi }") + pipeline(fallback) + repository("    agentEgress: {}\n"))).rejects.toThrow(required);
      await expect(load(agents("{ type: pi, provider: azure }") + pipeline(fallback) + repository("    agentEgress: {}\n"))).rejects.toThrow(required);
    });

    test("a pi agent of an exit-gate agent.run is checked too", async () => {
      const gate = "      - { id: review, concurrency: 1, actions: [], exit-gate: [{ task: agent.run, with: { agent: pi-worker } }] }\n";
      await expect(load(agents("{ type: pi }") + pipeline(gate) + repository("    agentEgress: {}\n"))).rejects.toThrow(required);
    });

    test("the repository's task overrides decide which agents run: one that swaps a pi agent in is checked, one that swaps it out is not", async () => {
      const claudeOnly = "      - { id: review, concurrency: 1, actions: [{ task: agent.run, with: { agent: claude-worker } }], exit-gate: [{ task: item.criteriaDefined }] }\n";
      const swapIn = "    agentEgress: {}\n    overrides: { stages: { review: { actions: { agent.run: { with: { agent: pi-worker } } } } } }\n";
      await expect(load(agents("{ type: pi }") + pipeline(claudeOnly) + repository(swapIn))).rejects.toThrow(required);
      const swapOut = "    agentEgress: {}\n    overrides: { stages: { review: { actions: { agent.run: { with: { agent: claude-worker } } } } } }\n";
      expect((await load(agents("{ type: pi }") + pipeline(fallback) + repository(swapOut))).config.repositories.sample!.agentEgress).toBeDefined();
      const skipped = "    agentEgress: {}\n    overrides: { stages: { review: { skip: true } } }\n";
      expect((await load(agents("{ type: pi }") + pipeline(fallback) + repository(skipped))).config.repositories.sample!.agentEgress).toBeDefined();
    });

    test("a pi runner whose provider has default hosts runs under agentEgress", async () => {
      const { config } = await load(agents("{ type: pi, provider: openai-codex }") + pipeline(fallback) + repository("    agentEgress: {}\n"));
      expect(config.repositories.sample!.agentEgress).toBeDefined();
    });

    test("a pi runner's own controlPlaneHosts satisfy agentEgress whatever its provider", async () => {
      const { config } = await load(agents("{ type: pi, provider: azure, controlPlaneHosts: [my-resource.openai.azure.com] }") + pipeline(fallback) + repository("    agentEgress: {}\n"));
      expect(config.runners.pi).toMatchObject({ controlPlaneHosts: ["my-resource.openai.azure.com"] });
    });

    test("without agentEgress a pi runner needs no hosts", async () => {
      const { config } = await load(agents("{ type: pi }") + pipeline(fallback) + repository());
      expect(config.agents["pi-worker"]?.runner).toBe("pi");
    });
  });
});

describe("claude-code runner controlPlaneHosts", () => {
  const runners = (hosts: string) => `
runners:
  claude: { type: claude-code, command: claude, controlPlaneHosts: ${hosts} }
`;

  test("accepts valid exact hosts", async () => {
    const { config } = await load(runners("[api.anthropic.com, model.example.test]") + NATIVE_PIPELINE + repository());
    expect(config.runners.claude).toMatchObject({ type: "claude-code", controlPlaneHosts: ["api.anthropic.com", "model.example.test"] });
  });

  test("accepts a code host's API, for a harness whose login refreshes there", async () => {
    const { config } = await load(runners("[api.github.com, api.githubcopilot.com]") + NATIVE_PIPELINE + repository());
    expect(config.runners.claude).toMatchObject({ controlPlaneHosts: ["api.github.com", "api.githubcopilot.com"] });
  });

  test.each(["*.anthropic.com", "10.0.0.5"])("rejects %p", async (host) => {
    await expect(load(runners(`["${host}"]`) + NATIVE_PIPELINE + repository())).rejects.toThrow("controlPlaneHosts");
  });
});
