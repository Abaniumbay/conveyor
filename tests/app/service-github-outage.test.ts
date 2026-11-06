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
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-outage-"));
  directories.push(root);
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await writeFile(path.join(root, "worker.md"), "Work.");
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
        actions: []
        exit-gate: [{ task: item.criteriaDefined }]
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
  return { service, store, fake };
}

async function until(condition: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

describe("GitHub outage wait", () => {
  test("a transient GitHub failure waits instead of blocking, beyond the attempts", async () => {
    const { service, store, fake } = await setup();
    try {
      await service.tick();
      // infrastructureAttempts is 1: an ordinary failure would stop after two tries.
      await until(() => fake.probes >= 3, "three outage probes");
      expect(fake.labelWrites).toEqual([]);
      expect(store.getIssue("issue")).toMatchObject({ projectedState: "active", projectedStage: "implementation" });
      expect(store.getIssue("issue")?.warning).toContain("GitHub unavailable since");
      expect(service.githubOutage()?.waitingItems).toEqual(["issue"]);
    } finally {
      await service.close();
    }
  });

  test("the waiting item resumes at the same stage once GitHub answers, with no manual retry", async () => {
    const { service, store, fake } = await setup();
    try {
      await service.tick();
      await until(() => fake.probes >= 1, "a probe");
      expect(service.githubOutage()).not.toBeNull();
      fake.probeFailure = null;
      fake.labelFailure = null;
      await until(() => fake.labelWrites.length > 0, "the stage to run again");
      expect(fake.labelWrites[0]).toContain("conveyor:done");
      expect(store.getIssue("issue")?.projectedStage).toBe("implementation");
      await until(() => service.githubOutage() === null, "the outage record to clear");
    } finally {
      await service.close();
    }
  });

  test("after recovery the outage record is clear, and a later non-GitHub failure is not probed as an outage", async () => {
    const { service, store, fake } = await setup();
    try {
      await service.tick();
      await until(() => fake.probes >= 1, "a probe");
      expect(service.githubOutage()).not.toBeNull();
      // GitHub answers, but the resumed stage then fails with an unrelated error.
      fake.probeFailure = null;
      fake.labelFailure = new Error("runner crashed");
      await until(() => service.githubOutage() === null, "the outage record to clear");
      const probesAtRecovery = fake.probes;
      await until(() => store.listConversationMessages("issue").some((entry) => entry.message.includes("failed attempts")), "the item to stop");
      expect(fake.probes).toBe(probesAtRecovery);
      expect(service.githubOutage()).toBeNull();
    } finally {
      await service.close();
    }
  });

  test("a permanent GitHub failure still stops the item as before", async () => {
    const { service, store, fake } = await setup();
    fake.labelFailure = new Error("gh: HTTP 404 Not Found (repos/owner/repo)");
    try {
      await service.tick();
      await until(() => store.listConversationMessages("issue").some((entry) => entry.message.includes("failed attempts")), "the item to stop");
      expect(service.githubOutage()).toBeNull();
      expect(fake.probes).toBe(0);
    } finally {
      await service.close();
    }
  });

  test("past github.outageWaitLimit the item needs intervention, and the reason names GitHub and the first failure time", async () => {
    const { service, store, fake } = await setup("github: { outageWaitLimit: 150ms }\n");
    try {
      const before = Date.now();
      await service.tick();
      await until(() => fake.probes >= 1, "a probe");
      // The label write fails with the outage too, so the stop can only land once GitHub answers.
      fake.labelFailure = null;
      await until(() => fake.labelWrites.some((labels) => labels.includes("conveyor:needs-intervention")), "needs-intervention");
      const note = store.listConversationMessages("issue").map((entry) => entry.message).find((message) => message.includes("github.outageWaitLimit"))!;
      expect(note).toContain("GitHub");
      const since = /since (\S+?);/.exec(note)![1]!;
      expect(Date.parse(since)).toBeGreaterThanOrEqual(before - 1);
      expect(Date.parse(since)).toBeLessThanOrEqual(Date.now());
      expect(service.githubOutage()).toBeNull();
    } finally {
      await service.close();
    }
  });

  test("a failed timeout stop keeps the item waiting instead of stranding it", async () => {
    const { service, store, fake } = await setup("github: { outageWaitLimit: 100ms }\n");
    try {
      await service.tick();
      await Bun.sleep(400);
      // Still no GitHub: the stop could not be written, yet the item keeps waiting and probing.
      expect(fake.labelWrites).toEqual([]);
      expect(service.githubOutage()?.waitingItems).toEqual(["issue"]);
      const probes = fake.probes;
      await Bun.sleep(150);
      expect(fake.probes).toBeGreaterThan(probes);
      fake.labelFailure = null;
      await until(() => fake.labelWrites.some((labels) => labels.includes("conveyor:needs-intervention")), "the stop to land after recovery");
      expect(store.getIssue("issue")?.projectedStage).toBe("implementation");
    } finally {
      await service.close();
    }
  });

  test("a paused item is not touched by its pending outage probe", async () => {
    const { service, store, fake } = await setup();
    try {
      await service.tick();
      await until(() => fake.probes >= 1, "a probe");
      store.setIssueProjection("issue", { stage: "implementation", state: "paused", warning: null });
      const probes = fake.probes;
      await Bun.sleep(200);
      expect(store.getIssue("issue")?.projectedState).toBe("paused");
      expect(fake.probes).toBeLessThanOrEqual(probes + 1);
      expect(service.githubOutage()).toBeNull();
    } finally {
      await service.close();
    }
  });
});
