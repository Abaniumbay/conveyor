import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfigError, loadConfig } from "../../src/config/load";
import type { StageConfig } from "../../src/config/schema";

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
    allowedHumanLogins: [owner]
`,
    );

    const config = await loadConfig(directory);

    expect(config.settings.runners).toBe(3);
    expect(config.settings.reconcileIntervalMs).toBe(300_000);
    expect(config.settings.database).toBe(
      path.join(directory, "state/conveyor.sqlite"),
    );
    expect(config.web.steering).toEqual({
      agent: "checker",
      workspace: path.resolve(directory, "../"),
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

  test("rejects an agent granting source.set_labels because workflow labels are engine-owned", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "conveyor.yml"),
      `
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
      return loadConfig(directory);
    }

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
    const config = await loadConfig(directory);
    expect(config.ci.actions?.triggers[0]).toMatchObject({ label: "go", workflow: "build.yml", check: "Build" });
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
});
