import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { ConfigError, loadConfig } from "../../src/config/load";
import { configSchema, type StageConfig } from "../../src/config/schema";
import { resolveFilesystemPath } from "../../src/core/paths";
import { PLUGINS } from "../../src/plugins";

const LABELS = "labels:\n  enrollment: conveyor\n  stageTemplate: \"conveyor:{stage}\"\n  states: { done: conveyor:done, blocked: conveyor:blocked }\n  metadata: { closable: conveyor:closable, orderTemplate: \"conveyor:order:{number}\" }\n";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("loadConfig", () => {
  test("merges split YAML maps, applies defaults, and resolves declared paths", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "conveyor.yml"),
      `
settings:
  runners: 3
  database: ./state/conveyor.sqlite
  logs: ./state/logs
  workspaces: ./state/worktrees
  artifacts: ./state/artifacts
web:
  listen: 127.0.0.1:4300
  steering:
    agent: checker
    workspace: ../
    periodic:
      interval: 15m
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states:
    done: conveyor:done
    blocked: conveyor:blocked
  metadata:
    closable: conveyor:closable
    orderTemplate: "conveyor:order:{number}"
`,
    );
    await writeFile(
      path.join(directory, "runners.yml"),
      `
runners:
  process:
    type: json-process
  codex:
    type: codex
    command: codex
agents:
  checker:
    name: Verifier
    title: Quality Verifier
    runner: codex
    model: gpt-test
    effort: high
    instructions: ./instructions/checker.md
    tools: [source.get_issue, run.report_progress]
checks:
  enter:
    verifier: checker
  exit:
    verifier: checker
`,
    );
    await writeFile(
      path.join(directory, "pipelines.yml"),
      `
pipelines:
  default:
    successStatuses: [done, skipped]
    failureStatuses: [blocked, rejected, error]
    stages:
      - id: inspect
        run:
          runner: process
          script: ./scripts/inspect.ts
        concurrency: 2
repositories:
  sample:
    source: github
    address: owner/sample
    folder: ../sample
    pipeline: default
`,
    );
    await writeFile(
      path.join(directory, "sources.yml"),
      `
sources:
  github:
    type: github
    webhookPath: /hooks/github
`,
    );

    const config = await loadConfig(directory);

    expect(config.settings.runners).toBe(3);
    expect(config.labels.metadata.noSplit).toBe("conveyor:no-split");
    expect(config.settings.reconcileIntervalMs).toBe(300_000);
    expect(config.settings.database).toBe(
      path.join(directory, "state/conveyor.sqlite"),
    );
    expect(config.web.steering).toEqual({
      agent: "checker",
      workspace: path.resolve(directory, "../"),
      periodic: { intervalMs: 900_000 },
    });
    expect(config.agents.checker?.instructions).toBe(
      path.join(directory, "instructions/checker.md"),
    );
    expect(config.agents.checker).toMatchObject({
      name: "Verifier",
      title: "Quality Verifier",
    });
    expect(config.agents.checker?.tasks).toEqual(["item.get", "agent.reportProgress"]);
    expect((config.pipelines.default?.stages[0] as StageConfig | undefined)?.run).toEqual({
      type: "script",
      runner: "process",
      script: path.join(directory, "scripts/inspect.ts"),
    });
    expect(config.repositories.sample?.folder).toBe(
      path.resolve(directory, "../sample"),
    );
    expect(config.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("canonicalizes every configured run path through symbolic links", async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, "target");
    const link = path.join(directory, "link");
    await mkdir(path.join(target, "state"), { recursive: true });
    await mkdir(path.join(target, "repository"));
    await mkdir(path.join(target, "cache"));
    await writeFile(path.join(target, "state", "database-target.sqlite"), "database");
    await symlink("database-target.sqlite", path.join(target, "state", "conveyor.sqlite"));
    await symlink(target, link);
    await writeFile(path.join(directory, "conveyor.yml"), `
settings:
  database: ${link}/state/conveyor.sqlite
  logs: ${link}/state/logs
  workspaces: ${link}/state/workspaces
  artifacts: ${link}/state/artifacts
labels:
  stageTemplate: "conveyor:{stage}"
  states: { done: done }
  metadata: { closable: close, orderTemplate: "order:{number}" }
sources: { github: { type: github } }
runners: { codex: { type: codex, command: codex } }
agents:
  worker:
    runner: codex
    instructions: ${link}/instructions.md
    writableRoots: [${link}/cache]
    env: { CACHE_DIR: ${link}/cache, LOG_LEVEL: info }
    mcpServers:
      helper:
        command: helper
        env: { HELPER_CACHE: ${link}/cache }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages: [{ id: work, run: { agent: worker }, concurrency: 1 }]
repositories:
  sample: { source: github, address: owner/sample, folder: ${link}/repository, pipeline: default }
`);

    const config = await loadConfig(directory);

    expect(config.settings).toMatchObject({
      database: path.join(target, "state", "database-target.sqlite"),
      logs: path.join(target, "state", "logs"),
      workspaces: path.join(target, "state", "workspaces"),
      artifacts: path.join(target, "state", "artifacts"),
    });
    expect(config.repositories.sample?.folder).toBe(path.join(target, "repository"));
    expect(config.agents.worker).toMatchObject({
      instructions: path.join(target, "instructions.md"),
      writableRoots: [path.join(target, "cache")],
      env: { CACHE_DIR: path.join(target, "cache"), LOG_LEVEL: "info" },
      mcpServers: { helper: { env: { HELPER_CACHE: path.join(target, "cache") } } },
    });
  });

  test("derives the no-split label from enrollment and honors an explicit override", () => {
    const base = {
      settings: { database: "/d", logs: "/l", workspaces: "/w", artifacts: "/a" },
      labels: {
        enrollment: "delivery",
        stageTemplate: "delivery:{stage}",
        states: { done: "delivery:done" },
        metadata: { closable: "delivery:closable", orderTemplate: "delivery:order:{number}" },
      },
    };

    expect(configSchema.parse(base).labels.metadata.noSplit).toBe("delivery:no-split");
    expect(configSchema.parse({
      ...base,
      labels: {
        ...base.labels,
        metadata: { ...base.labels.metadata, noSplit: "workflow:keep-whole" },
      },
    }).labels.metadata.noSplit).toBe("workflow:keep-whole");
  });

  test("defaults webhook delivery retention to 7d and rejects less than the 24h redelivery window", () => {
    const parse = (retention: object) => configSchema.safeParse({
      settings: { database: "/d", logs: "/l", workspaces: "/w", artifacts: "/a", retention },
      labels: { enrollment: "delivery", stageTemplate: "delivery:{stage}", states: { done: "delivery:done" }, metadata: { closable: "delivery:closable", orderTemplate: "delivery:order:{number}" } },
    });
    const retentionMs = (result: ReturnType<typeof parse>) => (result.success ? result.data.settings.retention.webhookDeliveriesMs : null);
    expect(retentionMs(parse({}))).toBe(7 * 86_400_000);
    expect(retentionMs(parse({ webhookDeliveries: "24h" }))).toBe(86_400_000);
    const short = parse({ webhookDeliveries: "23h" });
    expect(short.success).toBe(false);
    expect(JSON.stringify(short.error?.issues)).toContain("at least 24h");
  });

  test("rejects the removed allowedHumanLogins provider setting", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "conveyor.yaml"),
      `${LABELS}sources:\n  github:\n    type: github\n    allowedHumanLogins: [owner]\n`,
    );

    await expect(loadConfig(directory, undefined, { plugins: PLUGINS })).rejects.toThrow(/Unrecognized key: "allowedHumanLogins"/);
  });

  test("a provider type no plugin provides is an error naming the known types", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "conveyor.yaml"), `${LABELS}sources:\n  boards:\n    type: azure-boards\n`);
    await expect(loadConfig(directory, undefined, { plugins: PLUGINS })).rejects.toThrow(/sources\.boards\.type.*no items plugin provides type "azure-boards" \(known: github\)/s);
  });

  test("the plugin's schema completes a provider entry with its defaults", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "conveyor.yaml"), `${LABELS}sources:\n  github:\n    type: github\n`);
    const config = await loadConfig(directory, undefined, { plugins: PLUGINS });
    expect(config.sources.github).toEqual({ type: "github", webhookPath: "/hooks/github", autoConfigureWebhook: false });
  });

  test("without plugins a provider entry is checked only for its type and kept as written", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "conveyor.yaml"), `${LABELS}sources:\n  boards:\n    type: azure-boards\n    organization: example\n`);
    const config = await loadConfig(directory, null);
    expect(config.sources.boards).toEqual({ type: "azure-boards", organization: "example" });
  });

  test("rejects an agent granting source.set_labels because workflow labels are engine-owned", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "conveyor.yml"),
      `
settings: {}
web:
  steering: { agent: worker, workspace: /tmp/steering }
labels:
  stageTemplate: "conveyor:{stage}"
  states: { done: done }
  metadata: { closable: close, orderTemplate: "order:{number}" }
sources: { github: { type: github } }
runners: { codex: { type: codex, command: codex } }
agents:
  worker:
    runner: codex
    instructions: /tmp/worker.md
    tools: [source.get_issue, source.set_labels]
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - { id: work, run: { agent: worker }, concurrency: 1 }
repositories:
  sample: { source: github, address: owner/sample, folder: /tmp/sample, pipeline: default }
`,
    );
    await expect(loadConfig(directory)).rejects.toThrow(/source\.set_labels.*workflow labels are engine-owned/);
  });

  describe("agent task grants", () => {
    const configWith = (agentLines: string) => `
settings: {}
labels:
  stageTemplate: "conveyor:{stage}"
  states: { done: done }
  metadata: { closable: close, orderTemplate: "order:{number}" }
sources: { github: { type: github } }
runners: { codex: { type: codex, command: codex } }
agents:
  worker:
    runner: codex
    instructions: /tmp/worker.md
${agentLines}
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - { id: work, run: { agent: worker }, concurrency: 1 }
repositories:
  sample: { source: github, address: owner/sample, folder: /tmp/sample, pipeline: default }
`;
    async function load(agentLines: string) {
      const directory = await temporaryDirectory();
      await writeFile(path.join(directory, "conveyor.yml"), configWith(agentLines));
      return loadConfig(directory, undefined, { plugins: PLUGINS });
    }
    async function rejectionMessage(config: string) {
      const directory = await temporaryDirectory();
      await writeFile(path.join(directory, "conveyor.yml"), config);
      try {
        await loadConfig(directory, undefined, { plugins: PLUGINS });
      } catch (error) {
        if (error instanceof Error) return error.message;
        throw error;
      }
      throw new Error("expected configuration to be rejected");
    }

    test("network defaults off; writable roots accept absolute and ~/ paths", async () => {
      expect((await load("")).agents.worker).toMatchObject({ network: false, writableRoots: [] });
      const config = await load("    network: true\n    writableRoots: [/var/cache/x, ~/.bun/install/cache]");
      expect(config.agents.worker).toMatchObject({ network: true, writableRoots: ["/var/cache/x", resolveFilesystemPath(path.join(homedir(), ".bun/install/cache"))] });
    });
    test("harnessSettings and mcpServers default empty; server env values and ~/ are expanded", async () => {
      expect((await load("")).agents.worker).toMatchObject({ harnessSettings: {}, mcpServers: {} });
      const config = await load([
        "    harnessSettings: { model_auto_compact_token_limit: 80000, model_verbosity: low }",
        "    mcpServers:",
        "      serena:",
        "        command: serena",
        "        args: [start-mcp-server, --project-from-cwd]",
        "        env: { SERENA_HOME: ~/.serena }",
        "        startupTimeoutSec: 60",
        "        enabledTools: [find_symbol]",
        "        gitExclude: [.serena/]",
      ].join("\n"));
      expect(config.agents.worker).toMatchObject({
        harnessSettings: { model_auto_compact_token_limit: 80000, model_verbosity: "low" },
        mcpServers: {
          serena: {
            command: "serena", args: ["start-mcp-server", "--project-from-cwd"],
            env: { SERENA_HOME: resolveFilesystemPath(path.join(homedir(), ".serena")) }, startupTimeoutSec: 60, enabledTools: ["find_symbol"], gitExclude: [".serena/"],
          },
        },
      });
    });
    test("a Codex agent's harnessSettings cannot override what Conveyor sets, and the conveyor MCP server name is reserved", async () => {
      await expect(load("    harnessSettings: { sandbox_mode: danger-full-access }")).rejects.toThrow("agents.worker.harnessSettings.sandbox_mode: is set by Conveyor");
      await expect(load("    harnessSettings: { mcp_servers.x.command: evil }")).rejects.toThrow("set by Conveyor");
      await expect(load("    harnessSettings: { \"bad key\": 1 }")).rejects.toThrow("dotted Codex config key");
      await expect(load("    codexConfig: { sandbox_mode: danger-full-access }")).rejects.toThrow("agents.worker.codexConfig.sandbox_mode: is set by Conveyor");
      await expect(load("    mcpServers: { conveyor: { command: x } }")).rejects.toThrow("reserved");
    });
    test("the deprecated codexConfig loads as harnessSettings, with a warning naming the agent", async () => {
      const config = await load("    codexConfig: { model_auto_compact_token_limit: 80000 }");
      expect(config.agents.worker?.harnessSettings).toEqual({ model_auto_compact_token_limit: 80000 });
      expect(config.warnings).toContain("agent codexConfig is deprecated, used by worker: rename it to harnessSettings (same keys and values)");
      expect((await load("    harnessSettings: { model_auto_compact_token_limit: 80000 }")).warnings?.filter((warning) => warning.includes("codexConfig"))).toEqual([]);
    });
    test("an agent may not set both harnessSettings and the deprecated codexConfig", async () => {
      await expect(load("    harnessSettings: { model_verbosity: low }\n    codexConfig: { model_verbosity: high }")).rejects.toThrow("is the deprecated name of harnessSettings");
    });
    test("shell: false is refused on a Codex agent, naming it; shell: true or absent passes", async () => {
      const message = await rejectionMessage(configWith("    shell: false"));
      expect(message).toContain('agent "worker"');
      expect(message).toContain("Codex reaches files only through its shell");
      expect((await load("")).agents.worker).toMatchObject({ shell: true });
      expect((await load("    shell: true")).agents.worker).toMatchObject({ shell: true });
    });
    test("env defaults empty, expands ~/ values and rejects invalid variable names", async () => {
      expect((await load("")).agents.worker).toMatchObject({ env: {} });
      const config = await load("    env: { NUGET_PACKAGES: ~/.nuget/packages, DOTNET_NOLOGO: '1' }");
      expect(config.agents.worker!.env).toEqual({ NUGET_PACKAGES: resolveFilesystemPath(path.join(homedir(), ".nuget/packages")), DOTNET_NOLOGO: "1" });
      await expect(load("    env: { BAD-NAME: x }")).rejects.toThrow("env");
    });
    test("a relative writable root is a config error", async () => {
      await expect(load("    writableRoots: [cache]")).rejects.toThrow("writableRoots");
    });

    test("confined access is rejected for pipeline stages", async () => {
      const steeringDirectory = await temporaryDirectory();
      await writeFile(
        path.join(steeringDirectory, "conveyor.yml"),
        configWith("    workspaceAccess: confined").replace(
          "settings: {}",
          "settings: {}\nweb:\n  steering: { agent: worker, workspace: /tmp/steering }",
        ),
      );
      await expect(loadConfig(steeringDirectory)).rejects.toThrow(/confined agent "worker", which cannot run pipeline stages/);

    });

    test("confined access is rejected from every native agent task entry", async () => {
      const config = configWith("    workspaceAccess: confined").replace(
        `    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - { id: work, run: { agent: worker }, concurrency: 1 }`,
        `    stages:
      - id: work
        concurrency: 1
        actions:
          - { id: action-one, task: agent.run, with: { agent: worker } }
          - { id: action-many, task: agent.run, with: { agents: [worker, worker] } }
        exit-gate:
          - { id: gate-one, task: agent.run, with: { agent: worker } }
          - { id: gate-many, task: agent.run, with: { agents: [worker] } }`,
      );

      const message = await rejectionMessage(config);
      expect(message).toContain("pipelines.default.stages.0.actions.0.with.agent references confined agent");
      expect(message).toContain("pipelines.default.stages.0.actions.1.with.agents.0 references confined agent");
      expect(message).toContain("pipelines.default.stages.0.actions.1.with.agents.1 references confined agent");
      expect(message).toContain("pipelines.default.stages.0.exit-gate.0.with.agent references confined agent");
      expect(message).toContain("pipelines.default.stages.0.exit-gate.1.with.agents.0 references confined agent");
    });

    test("confined access is rejected for legacy check verifiers", async () => {
      const message = await rejectionMessage(
        configWith("    workspaceAccess: confined").replace(
          `    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - { id: work, run: { agent: worker }, concurrency: 1 }`,
          `    stages:
      - id: work
        concurrency: 1
        actions: []
        exit-gate:
          - { id: criteria, task: item.criteriaDefined }`,
        ).replace(
          "settings: {}",
          "settings: {}\nchecks:\n  verify: { verifier: worker }",
        ),
      );

      expect(message).toContain("checks.verify.verifier references confined agent");
      expect(message).toContain('confined agent "worker", which cannot run legacy checks');
    });

    test("tasks is the exact grant, in camelCase", async () => {
      const config = await load("    tasks: [item.get, change.setMetadata]");
      expect(config.agents.worker?.tasks).toEqual(["item.get", "change.setMetadata"]);
    });

    test("legacy tools are normalised to tasks through the alias table", async () => {
      const config = await load("    tools: [source.get_issue, workspace.request_push, run.record_artifact, workspace.record_artifact]");
      expect(config.agents.worker?.tasks).toEqual(["item.get", "workspace.push", "agent.recordArtifact"]);
    });

    test("the default grant is every agent-grantable tool", async () => {
      const config = await load("    name: Worker");
      expect(config.agents.worker?.tasks).toContain("item.setCriteria");
      expect(config.agents.worker?.tasks).toContain("ci.getLogs");
      expect(config.agents.worker?.tasks).not.toContain("change.dismissFinding");
    });

    test("tasks and tools together are a config error", async () => {
      await expect(load("    tasks: [item.get]\n    tools: [source.get_issue]")).rejects.toThrow(/either "tasks" or the legacy "tools"/);
    });

    test("an unknown task is a config error", async () => {
      await expect(load("    tasks: [item.typo]")).rejects.toThrow(/unknown task "item\.typo"/);
    });

    test("change.dismissFinding can never be granted to an agent, even before the tool exists", async () => {
      await expect(load("    tasks: [change.dismissFinding]")).rejects.toThrow(/change\.dismissFinding can never be granted to an agent/);
      await expect(load("    tools: [change.dismissFinding]")).rejects.toThrow(/can never be granted to an agent/);
    });

    test("a task granted twice is a config error", async () => {
      await expect(load("    tasks: [item.get, item.get]")).rejects.toThrow(/granted more than once/);
    });
  });

  test("rejects duplicate named definitions across files", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "one.yml"),
      "runners:\n  process:\n    type: json-process\n",
    );
    await writeFile(
      path.join(directory, "two.yml"),
      "runners:\n  process:\n    type: json-process\n",
    );

    await expect(loadConfig(directory)).rejects.toThrow(
      /duplicate runners definition "process"/i,
    );
  });

  test("reports all schema violations with their configuration paths", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "invalid.yml"),
      `
settings:
  runners: 0
repositories:
  broken:
    source: missing
    address: not-a-repository
    folder: 42
    pipeline: absent
`,
    );

    try {
      await loadConfig(directory);
      throw new Error("expected loadConfig to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = String(error);
      expect(message).toContain("settings.runners");
      expect(message).toContain("repositories.broken.address");
      expect(message).toContain("repositories.broken.folder");
    }
  });

  test("loads named CI providers from split files and defaults repositories to native CI", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "base.yml"), `
settings: {}
labels:
  stageTemplate: "ci:{stage}"
  states: { done: done }
  metadata: { closable: close, orderTemplate: "order:{number}" }
sources: { github: { type: github } }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - { id: ci, run: { sourceAction: ci.await }, concurrency: 1 }
repositories:
  sample: { source: github, address: owner/sample, folder: /tmp/sample, pipeline: default }
`);
    await writeFile(path.join(directory, "ci.yml"), `
ci:
  actions:
    type: github-actions
    triggers:
      - { label: go, workflow: build.yml, check: Build }
`);
    const config = await loadConfig(directory, undefined, { plugins: PLUGINS });
    expect(config.ci.actions).toMatchObject({ triggers: [{ label: "go", workflow: "build.yml", check: "Build", replaces: [] }] });
    expect(config.repositories.sample?.ci).toEqual({ provider: null, mode: "required", ignoreChecks: [] });
  });

  test("reports unknown CI provider references with the repository path", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "config.yml"), `
settings: {}
labels:
  stageTemplate: "ci:{stage}"
  states: { done: done }
  metadata: { closable: close, orderTemplate: "order:{number}" }
sources: { github: { type: github } }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages: [{ id: work, run: { sourceAction: ci.await }, concurrency: 1 }]
repositories:
  sample: { source: github, address: owner/sample, folder: /tmp/sample, pipeline: default, ci: absent }
`);
    await expect(loadConfig(directory)).rejects.toThrow(/repositories.sample.ci references unknown CI provider/);
  });

  test("rejects conflicting provider and legacy stage triggers with the stage path", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "config.yml"), `
settings: {}
labels:
  stageTemplate: "ci:{stage}"
  states: { done: done }
  metadata: { closable: close, orderTemplate: "order:{number}" }
sources: { github: { type: github } }
ci:
  actions:
    type: github-actions
    triggers: [{ label: provider, workflow: provider.yml, check: Provider }]
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: work
        run: { sourceAction: pullRequest.awaitChecks, with: { triggers: [{ label: stage, workflow: stage.yml, check: Stage }] } }
        concurrency: 1
repositories:
  sample: { source: github, address: owner/sample, folder: /tmp/sample, pipeline: default, ci: actions }
`);
    await expect(loadConfig(directory)).rejects.toThrow(/pipelines.default.stages.0.run.with.triggers conflicts with ci.actions.triggers/);
  });

  test("does not apply an unreferenced named provider to a repository using native CI", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "config.yml"), `
settings: {}
labels:
  stageTemplate: "ci:{stage}"
  states: { done: done }
  metadata: { closable: close, orderTemplate: "order:{number}" }
sources: { github: { type: github } }
ci:
  actions:
    type: github-actions
    triggers: [{ label: provider, workflow: provider.yml, check: Provider }]
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: work
        run: { sourceAction: pullRequest.awaitChecks, with: { triggers: [{ label: stage, workflow: stage.yml, check: Stage }] } }
        concurrency: 1
repositories:
  sample: { source: github, address: owner/sample, folder: /tmp/sample, pipeline: default }
`);
    const config = await loadConfig(directory);
    expect(config.repositories.sample?.ci).toEqual({ provider: null, mode: "required", ignoreChecks: [] });
  });

  test("validates a repository in-flight interval against its merge stage", async () => {
    const document = (inFlight: string, stages = `
      - { id: refinement, concurrency: 1, actions: [], exit-gate: [{ task: item.criteriaDefined }] }
      - { id: implementation, concurrency: 1, actions: [], exit-gate: [{ task: item.criteriaDefined }] }
      - { id: merge, concurrency: 1, actions: [{ id: merge, task: change.merge }], exit-gate: [{ task: item.criteriaDefined }] }
      - { id: deploy, concurrency: 1, actions: [], exit-gate: [{ task: item.criteriaDefined }] }`) => `
settings: {}
labels:
  stageTemplate: "ci:{stage}"
  states: { done: done }
  metadata: { closable: close, orderTemplate: "order:{number}" }
sources: { github: { type: github } }
pipelines:
  default:
    stages:${stages}
repositories:
  sample:
    source: github
    address: owner/sample
    folder: /tmp/sample
    pipeline: default
    inFlight: ${inFlight}
`;
    const valid = await temporaryDirectory();
    await writeFile(path.join(valid, "conveyor.yml"), document("{ limit: 2, from: implementation }"));
    await expect(loadConfig(valid)).resolves.toMatchObject({
      repositories: { sample: { inFlight: { limit: 2, from: "implementation" } } },
    });

    const zero = await temporaryDirectory();
    await writeFile(path.join(zero, "conveyor.yml"), document("{ limit: 0, from: implementation }"));
    await expect(loadConfig(zero)).rejects.toThrow(/repositories.sample.inFlight.limit.*>0/);

    const fractional = await temporaryDirectory();
    await writeFile(path.join(fractional, "conveyor.yml"), document("{ limit: 1.5, from: implementation }"));
    await expect(loadConfig(fractional)).rejects.toThrow(/repositories.sample.inFlight.limit.*expected int/);

    const unknown = await temporaryDirectory();
    await writeFile(path.join(unknown, "conveyor.yml"), document("{ limit: 2, from: absent }"));
    await expect(loadConfig(unknown)).rejects.toThrow(/repositories.sample.inFlight.from references unknown stage "absent"/);

    const afterMerge = await temporaryDirectory();
    await writeFile(path.join(afterMerge, "conveyor.yml"), document("{ limit: 2, from: deploy }"));
    await expect(loadConfig(afterMerge)).rejects.toThrow(/repositories.sample.inFlight.from must name a stage at or before the merge stage/);

    const withoutMerge = await temporaryDirectory();
    await writeFile(
      path.join(withoutMerge, "conveyor.yml"),
      document("{ limit: 2, from: implementation }", `
      - { id: refinement, concurrency: 1, actions: [], exit-gate: [{ task: item.criteriaDefined }] }
      - { id: implementation, concurrency: 1, actions: [], exit-gate: [{ task: item.criteriaDefined }] }`),
    );
    await expect(loadConfig(withoutMerge)).rejects.toThrow(/repositories.sample.inFlight requires pipeline "default" to include a stage with the change.merge action/);
  });
});

describe("harness runners", () => {
  const RUNNERS = "runners:\n  codex: { type: codex }\n  claude: { type: claude-code }\n  process: { type: json-process }\n";

  async function loadWith(body: string, options: { plugins?: boolean } = {}) {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "conveyor.yaml"), `${LABELS}${body}`);
    return loadConfig(directory, null, options.plugins === false ? {} : { plugins: PLUGINS });
  }

  /** The runners above and one agent `worker` on `runner`, with extra agent lines. */
  const agentOn = (runner: string, ...lines: string[]) =>
    `${RUNNERS}agents:\n  worker:\n    runner: ${runner}\n    instructions: /tmp/worker.md\n${lines.map((line) => `    ${line}\n`).join("")}`;

  test("each harness plugin's schema completes its runners with their defaults", async () => {
    const config = await loadWith(RUNNERS);
    expect(config.runners.codex).toEqual({ type: "codex", command: "codex", sandbox: "workspace-write", automaticApprovals: true });
    expect(config.runners.claude).toEqual({ type: "claude-code", command: "claude" });
    expect(config.runners.process).toEqual({ type: "json-process" });
  });

  test("a runner completed with its defaults hashes like one written out in full", async () => {
    const directory = await temporaryDirectory();
    const hashOf = async (body: string) => {
      await writeFile(path.join(directory, "conveyor.yaml"), `${LABELS}${body}`);
      return (await loadConfig(directory, null, { plugins: PLUGINS })).hash;
    };
    const written = await hashOf("runners:\n  codex: { type: codex, command: codex, sandbox: workspace-write, automaticApprovals: true }\n  claude: { type: claude-code, command: claude }\n  process: { type: json-process }\n");
    expect(await hashOf(RUNNERS)).toBe(written);
  });

  test("a setting the runner's harness does not take is refused", async () => {
    await expect(loadWith("runners:\n  codex: { type: codex, configDir: /tmp/codex }\n")).rejects.toThrow(/runners\.codex.*Unrecognized key: "configDir"/s);
    await expect(loadWith("runners:\n  claude: { type: claude-code, sandbox: read-only }\n")).rejects.toThrow(/runners\.claude.*Unrecognized key: "sandbox"/s);
    await expect(loadWith("runners:\n  process: { type: json-process, command: run }\n")).rejects.toThrow(/runners\.process.*Unrecognized key: "command"/s);
  });

  test("the harness plugin validates a runner's settings", async () => {
    await expect(loadWith("runners:\n  claude: { type: claude-code, configDir: relative/claude }\n")).rejects.toThrow(/runners\.claude\.configDir.*must resolve to an absolute path/s);
  });

  test("a runner type no harness plugin provides is an error naming the known types", async () => {
    await expect(loadWith("runners:\n  pi: { type: pi }\n")).rejects.toThrow(/runners\.pi\.type.*no harness plugin provides type "pi" \(known: codex, claude-code, json-process\)/s);
    await expect(loadWith("runners:\n  codex: { type: \" codex\" }\n")).rejects.toThrow(/runners\.codex\.type.*no harness plugin provides type " codex"/s);
  });

  test("without plugins a harness runner is checked only for its type and kept as written", async () => {
    const config = await loadWith("runners:\n  codex: { type: codex, extra: 1 }\n", { plugins: false });
    // Typed as a completed runner, but no plugin completed it.
    const written: unknown = config.runners.codex;
    expect(written).toEqual({ type: "codex", extra: 1 });
    await expect(loadWith("runners:\n  process: { type: json-process, command: run }\n", { plugins: false })).rejects.toThrow(/Unrecognized key: "command"/);
  });

  test("an agent's access must suit its runner's harness", async () => {
    await expect(loadWith(agentOn("claude", "workspaceAccess: confined"))).rejects.toThrow("agents.worker uses access: confined, which requires the Codex runner");
    await expect(loadWith(agentOn("process", "workspaceAccess: confined"))).rejects.toThrow("agents.worker uses access: confined, which requires the Codex runner");
    await expect(loadWith(agentOn("process", "workspaceAccess: confined"), { plugins: false })).rejects.toThrow("agents.worker uses access: confined, which requires a harness that can confine it");
    await expect(loadWith(agentOn("codex", "workspaceAccess: confined", "writableRoots: [/tmp/cache]"))).rejects.toThrow("agents.worker is confined, so writableRoots does not apply");
    await expect(loadWith(agentOn("claude", "workspaceAccess: workspace-write"))).rejects.toThrow("agents.worker runs on Claude Code with access: workspace-write, which needs network: true (its commands cannot be kept off the network yet)");
    await expect(loadWith(agentOn("claude", "workspaceAccess: read-only", "writableRoots: [/tmp/cache]"))).rejects.toThrow("agents.worker is read-only, so writableRoots does not apply");
    await expect(loadWith(agentOn("codex", "shell: false"))).rejects.toThrow('agents.worker sets shell: false, but Codex reaches files only through its shell, so agent "worker" cannot run without one');
    await expect(loadWith(agentOn("claude", "workspaceAccess: read-only", "codexConfig: { model_auto_compact_token_limit: 1 }"))).rejects.toThrow("agents.worker runs on Claude Code, which does not take codexConfig");
    await expect(loadWith(agentOn("claude", "workspaceAccess: read-only", "harnessSettings: { effort: 1 }"))).rejects.toThrow("agents.worker runs on Claude Code, which does not take harnessSettings");
  });

  test("an agent its runner's harness can run is accepted", async () => {
    expect((await loadWith(agentOn("codex", "workspaceAccess: confined"))).agents.worker?.workspaceAccess).toBe("confined");
    expect((await loadWith(agentOn("codex", "workspaceAccess: workspace-write"))).agents.worker?.network).toBe(false);
    expect((await loadWith(agentOn("codex", "workspaceAccess: read-only", "writableRoots: [/tmp/cache]"))).agents.worker?.writableRoots).toEqual(["/tmp/cache"]);
    expect((await loadWith(agentOn("claude", "workspaceAccess: workspace-write", "network: true"))).agents.worker?.network).toBe(true);
    expect((await loadWith(agentOn("claude", "workspaceAccess: read-only", "shell: false"))).agents.worker?.shell).toBe(false);
    expect((await loadWith(agentOn("codex", "harnessSettings: { model_auto_compact_token_limit: 1 }"))).agents.worker?.harnessSettings).toEqual({ model_auto_compact_token_limit: 1 });
    expect((await loadWith(agentOn("codex", "codexConfig: { model_auto_compact_token_limit: 1 }"))).agents.worker?.harnessSettings).toEqual({ model_auto_compact_token_limit: 1 });
    expect((await loadWith(agentOn("claude", "workspaceAccess: read-only", "harnessSettings: {}"))).agents.worker?.harnessSettings).toEqual({});
  });
});
