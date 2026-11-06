import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { createTaskRegistry } from "../../src/tasks/catalogue";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const CRITERIA = "<!-- conveyor:acceptance-criteria:start -->\n- [ ] It works <!-- conveyor:criterion:a -->\n<!-- conveyor:acceptance-criteria:end -->\n";
const OUTAGE = "gh: HTTP 502 Bad Gateway (https://api.github.com/graphql)";

/**
 * A pipeline whose only stage finishes at once, so the one GitHub call that matters is the label
 * write that moves the item on: the fake GitHub fails it the way the test needs.
 */
async function setup(githubConfig = "github: { outageWaitLimit: 5s }\n") {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-script-transient-"));
  directories.push(root);
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await writeFile(path.join(root, "worker.md"), "Work.");
  await writeFile(path.join(root, "mode"), "exit75");
  await writeFile(path.join(root, "runs"), "");
  await writeFile(path.join(root, "stage.sh"), `cat > /dev/null
echo run >> ${root}/runs
case "$(cat ${root}/mode)" in
  exit75) echo "upstream busy" >&2; exit 75 ;;
  transient) echo '{"transient": true}' ;;
  transientFailure) echo '{"outcome":"failure","summary":"deploy not ready","transient":true}' ;;
  exit1) echo "boom" >&2; exit 1 ;;
  *) echo '{"outcome":"success","summary":"deployed"}' ;;
esac
`);
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
  retries: { infrastructureAttempts: 1, usageLimitAttempts: unlimited, minBackoff: 20ms, maxBackoff: 40ms }
${githubConfig}web: {}
sources: { github: { type: github } }
runners: { codex: { type: codex } }
agents: { worker: { runner: codex, instructions: ./worker.md } }
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked", error: "conveyor:error", needs-intervention: "conveyor:needs-intervention" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    stages:
      - id: implementation
        concurrency: 1
        actions:
          - { id: runScript, task: script.run, with: { script: ./stage.sh, interpreter: [bash], recovery: replay-safe } }
        exit-gate: [{ id: scriptGate, task: script.succeeded, with: { run: runScript } }]
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repositoryPath}
    pipeline: default
`);
  const config = await loadConfig(path.join(root, "config.yml"), createTaskRegistry());
  const store = await ConveyorStore.open(config.settings.database);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash });
  const fake = {
    labelFailure: new Error(OUTAGE) as Error | null,
    probeFailure: new Error("HTTP 503 Service Unavailable") as Error | null,
    labelWrites: [] as string[][],
    probes: 0,
  };
  const labelsOf = () => store.getIssue("issue")!.labels;
  const toIssue = () => {
    const issue = store.getIssue("issue")!;
    return {
      id: issue.id, number: issue.sourceNumber, url: issue.sourceUrl, title: issue.title, body: issue.body,
      state: issue.sourceState, stateReason: issue.sourceStateReason, labels: labelsOf(), updatedAt: issue.sourceUpdatedAt,
    };
  };
  const github = {
    async listIssues() { return [toIssue()]; },
    async getIssue() { return toIssue(); },
    async getIssueProvenance() { return { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } }; },
    async collaboratorPermission() { return "write" as const; },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
    async replaceConveyorLabels(_address: string, _number: number, labels: string[]) {
      if (fake.labelFailure) throw fake.labelFailure;
      fake.labelWrites.push([...labels]);
      const issue = store.getIssue("issue")!;
      store.upsertIssue({
        id: issue.id, repositoryId: issue.repositoryId, sourceNumber: issue.sourceNumber, sourceUrl: issue.sourceUrl, title: issue.title,
        body: issue.body, sourceState: issue.sourceState, labels, sourceUpdatedAt: new Date().toISOString(),
      });
    },
    async rateLimit() {
      fake.probes += 1;
      if (fake.probeFailure) throw fake.probeFailure;
      return { core: null, graphql: null };
    },
    async upsertStatusComment() { return 1; },
    async hasCommentWithMarker() { return false; },
    async addComment() { return 1; },
  };
  const service = new ConveyorService(config, store, github as never);
  store.upsertIssue({
    id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.test/1", title: "Feature", body: CRITERIA,
    sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: null });
  store.setQueueRank("issue", store.nextQueueRank());
  store.setStageState({ issueId: "issue", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
  store.activateEnrollment("issue");
  const setMode = (mode: string) => writeFile(path.join(root, "mode"), mode);
  const runs = async () => (await Bun.file(path.join(root, "runs")).text()).split("\n").filter(Boolean).length;
  return { service, store, fake, setMode, runs };
}

async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

describe("stage script temporary failure", () => {
  test("a script exiting 75 moves the item to waiting, not needs-intervention", async () => {
    const { service, store, fake, runs } = await setup();
    fake.labelFailure = null;
    try {
      await service.tick();
      // infrastructureAttempts is 1: an ordinary failure would stop after two runs.
      await until(async () => (await runs()) >= 3, "the script to run three times");
      expect(store.getIssue("issue")).toMatchObject({ projectedState: "active", projectedStage: "implementation" });
      expect(store.getIssue("issue")?.warning).toContain("temporary failure");
      expect(fake.labelWrites).toEqual([]);
    } finally {
      await service.close();
    }
  });

  test("a script returning transient: true in its JSON moves the item to waiting", async () => {
    const { service, store, fake, setMode, runs } = await setup();
    fake.labelFailure = null;
    await setMode("transient");
    try {
      await service.tick();
      await until(async () => (await runs()) >= 3, "the script to run three times");
      expect(store.getIssue("issue")).toMatchObject({ projectedState: "active", projectedStage: "implementation" });
      expect(store.getIssue("issue")?.warning).toContain("temporary failure");
      expect(fake.labelWrites).toEqual([]);
    } finally {
      await service.close();
    }
  });

  test("a failure result flagged transient also waits", async () => {
    const { service, store, fake, setMode, runs } = await setup();
    fake.labelFailure = null;
    await setMode("transientFailure");
    try {
      await service.tick();
      await until(async () => (await runs()) >= 3, "the script to run three times");
      expect(store.getIssue("issue")?.projectedState).toBe("active");
      expect(fake.labelWrites).toEqual([]);
    } finally {
      await service.close();
    }
  });

  test("a script exiting with another non-zero code still stops as before", async () => {
    const { service, store, fake, setMode } = await setup();
    fake.labelFailure = null;
    await setMode("exit1");
    try {
      await service.tick();
      await until(() => store.listConversationMessages("issue").some((entry) => entry.message.includes("failed attempts")), "the item to stop");
      expect(store.listConversationMessages("issue").some((entry) => entry.message.includes("temporary failure"))).toBe(false);
    } finally {
      await service.close();
    }
  });

  test("a waiting item whose script later exits 0 resumes and completes the stage", async () => {
    const { service, store, fake, setMode, runs } = await setup();
    fake.labelFailure = null;
    try {
      await service.tick();
      await until(async () => (await runs()) >= 2, "the script to run twice");
      await setMode("ok");
      await until(() => fake.labelWrites.length > 0, "the stage to complete");
      expect(fake.labelWrites[0]).toContain("conveyor:done");
    } finally {
      await service.close();
    }
  });

  test("past github.outageWaitLimit a temporarily failing script needs intervention", async () => {
    const { service, fake } = await setup("github: { outageWaitLimit: 150ms }\n");
    fake.labelFailure = null;
    try {
      await service.tick();
      await until(() => fake.labelWrites.some((labels) => labels.includes("conveyor:needs-intervention")), "needs-intervention");
    } finally {
      await service.close();
    }
  });
});
