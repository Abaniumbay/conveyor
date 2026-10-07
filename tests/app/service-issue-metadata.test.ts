import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(refinement = "refinement: { fields: [Effort, Priority] }") {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-issue-metadata-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const folder = path.join(root, "repo");
  await mkdir(folder);
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings: { database: ${root}/db.sqlite, logs: ${root}/logs, workspaces: ${root}/workspaces, artifacts: ${root}/artifacts }
web: {}
sources: { github: { type: github } }
runners: { codex: { type: codex } }
agents: { worker: { runner: codex, instructions: ./instructions.md } }
checks: {}
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: implementation
        concurrency: 1
        actions: []
        exit-gate:
          - { id: ciGate, task: ci.passed }
repositories:
  repo: { source: github, address: owner/repo, folder: ${folder}, pipeline: default, ${refinement} }
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  store.recordConfigSnapshot(config.hash, config);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder, configHash: config.hash });
  const source = { type: "Bug" as string | null | undefined, fields: { Effort: "Low", "Target date": "2026-11-01" } as Record<string, string>, fieldReads: 0, fail: false, updatedAt: "2026-01-01T00:00:00Z" };
  const github = {
    async listIssues() {
      return [{
        id: "github:owner/repo#1", number: 1, url: "u", title: "F", body: "", state: "open", labels: ["conveyor", "conveyor:implementation"],
        updatedAt: source.updatedAt, ...(source.type === undefined ? {} : { type: source.type }),
      }];
    },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
    async getIssueFieldValues() { source.fieldReads += 1; if (source.fail) throw new Error("no access"); return source.fields; },
    async upsertStatusComment() { return 1; },
    async replaceConveyorLabels() {},
  };
  const service = new ConveyorService(config, store, github as never);
  const card = () => service.dashboard("csrf").stages.flatMap((stage) => stage.issues).find((issue) => issue.number === 1);
  return { root, config, store, service, source, card };
}

test("the dashboard shows the issue type and only the repository-configured field values", async () => {
  const { service, card, store } = await setup();
  await service.reconcileAll();
  expect(card()).toMatchObject({ issueType: "Bug", issueFields: [{ name: "Effort", value: "Low" }] });
  store.close();
});

test("type and values survive reconciliation without new data, and a restart", async () => {
  const { service, card, store, source, config, root } = await setup();
  await service.reconcileAll();
  source.type = undefined;           // a source that reports no type information
  source.fail = true;                // and field reads that fail
  source.updatedAt = "2026-01-02T00:00:00Z";
  await service.reconcileAll();
  expect(card()).toMatchObject({ issueType: "Bug", issueFields: [{ name: "Effort", value: "Low" }] });
  store.close();
  const reopened = await ConveyorStore.open(path.join(root, "db.sqlite"));
  expect(reopened.getIssue("github:owner/repo#1")!.metadata).toMatchObject({ type: "Bug", fields: { Effort: "Low" } });
  const again = new ConveyorService(config, reopened, { listIssues: async () => [], listSubIssues: async () => [], listDependencies: async () => [] } as never);
  expect(again.dashboard("csrf").stages.flatMap((stage) => stage.issues).find((issue) => issue.number === 1)).toMatchObject({ issueType: "Bug", issueFields: [{ name: "Effort", value: "Low" }] });
  reopened.close();
});

test("field values are read again only when the issue changed, and a changed value replaces the old one", async () => {
  const { service, card, store, source } = await setup();
  await service.reconcileAll();
  await service.reconcileAll();
  expect(source.fieldReads).toBe(1);
  source.fields = { Effort: "High" };
  source.updatedAt = "2026-01-03T00:00:00Z";
  await service.reconcileAll();
  expect(source.fieldReads).toBe(2);
  expect(card()?.issueFields).toEqual([{ name: "Effort", value: "High" }]);
  store.close();
});

test("an absent type, no configured fields, or no metadata do not break the details", async () => {
  const { service, card, store, source } = await setup("");
  source.type = null;
  await service.reconcileAll();
  expect(card()).toMatchObject({ issueType: null, issueFields: [] });
  expect(source.fieldReads).toBe(0);
  store.close();
});
