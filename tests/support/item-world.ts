// A small world for the service's item modules (rollups, retries, admission, purges): a parsed
// configuration, a temporary store and a fake item source whose labels and states tests change.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConveyorConfig } from "../../src/config/load";
import { configSchema } from "../../src/config/schema";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";
import type { SourceIssue } from "../../src/source/types";

export const STOP_LABELS = {
  done: "conveyor:done",
  blocked: "conveyor:blocked",
  error: "conveyor:error",
  "needs-intervention": "conveyor:needs-intervention",
} as const;

/** The world's configuration; `extra` adds or replaces top-level sections (agents, runners, web). */
export function itemConfig(root: string, extra: Record<string, unknown> = {}): ConveyorConfig {
  const parsed = configSchema.parse({
    settings: {
      database: path.join(root, "conveyor.sqlite"),
      logs: path.join(root, "logs"),
      artifacts: path.join(root, "artifacts"),
      workspaces: path.join(root, "workspaces"),
      runners: 1,
    },
    labels: {
      enrollment: "conveyor",
      stageTemplate: "conveyor:{stage}",
      states: STOP_LABELS,
      metadata: { closable: "conveyor:closable", noSplit: "conveyor:no-split", paused: "conveyor:paused", orderTemplate: "conveyor:order:{number}" },
    },
    pipelines: {
      default: {
        successStatuses: ["done"],
        failureStatuses: ["error"],
        stages: [
          { id: "implementation", run: { agent: "worker" }, concurrency: 1 },
          { id: "review", run: { agent: "worker" }, concurrency: 1 },
        ],
      },
    },
    repositories: {
      repo: { source: "github", address: "owner/my-app", folder: root, pipeline: "default" },
    },
    agents: {},
    ...extra,
  });
  return { ...parsed, hash: "config-hash", root, plans: [] };
}

/** A fake item source: issues by number, and every write it was asked for. */
export class FakeItems {
  readonly issues = new Map<number, SourceIssue>();
  readonly children = new Map<number, number[]>();
  readonly blockers = new Map<number, number[]>();
  readonly relabels: Array<{ number: number; labels: string[]; preserve: readonly string[] | undefined }> = [];
  readonly closes: number[] = [];
  readonly reads = { subIssues: 0, dependencies: 0 };
  readonly forgotten: number[] = [];
  /** Throws from the next label write. */
  failRelabel: Error | null = null;
  /** Throws from the next close, after applying it when `closeBeforeFailure` is set. */
  failClose: Error | null = null;
  closeBeforeFailure = false;
  #updates = 0;

  add(number: number, labels: string[], state: "open" | "closed" = "open"): SourceIssue {
    const issue: SourceIssue = {
      id: `issue-${number}`, number, url: `https://example.com/owner/my-app/issues/${number}`, title: `Issue ${number}`, body: "",
      state, stateReason: state === "closed" ? "completed" : null, labels, updatedAt: "2026-10-17T00:00:00Z",
    };
    this.issues.set(number, issue);
    return issue;
  }

  #find(number: number): SourceIssue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`Missing source issue ${number}`);
    return issue;
  }

  #touch(issue: SourceIssue): void {
    this.#updates += 1;
    issue.updatedAt = new Date(Date.parse("2026-10-17T00:00:00Z") + this.#updates * 60_000).toISOString();
  }

  readonly client = {
    getIssue: async (_address: string, number: number): Promise<SourceIssue> => ({ ...this.#find(number), labels: [...this.#find(number).labels] }),
    listSubIssues: async (_address: string, number: number): Promise<SourceIssue[]> => {
      this.reads.subIssues += 1;
      return (this.children.get(number) ?? []).map((child) => ({ ...this.#find(child) }));
    },
    listDependencies: async (_address: string, number: number): Promise<SourceIssue[]> => {
      this.reads.dependencies += 1;
      return (this.blockers.get(number) ?? []).map((blocker) => ({ ...this.#find(blocker) }));
    },
    replaceConveyorLabels: async (_address: string, number: number, labels: readonly string[], preserve?: readonly string[]): Promise<void> => {
      this.relabels.push({ number, labels: [...labels], preserve });
      if (this.failRelabel) {
        const error = this.failRelabel;
        this.failRelabel = null;
        throw error;
      }
      const issue = this.#find(number);
      const kept = issue.labels.filter((label) => !label.startsWith("conveyor") || (preserve ?? []).includes(label));
      issue.labels = [...new Set([...kept, ...labels])];
      this.#touch(issue);
    },
    closeIssue: async (_address: string, number: number): Promise<SourceIssue> => {
      this.closes.push(number);
      const issue = this.#find(number);
      if (this.failClose) {
        const error = this.failClose;
        this.failClose = null;
        if (this.closeBeforeFailure) {
          issue.state = "closed";
          issue.stateReason = "completed";
        }
        throw error;
      }
      issue.state = "closed";
      issue.stateReason = "completed";
      this.#touch(issue);
      return { ...issue };
    },
    forgetIssue: (_address: string, number: number): void => { this.forgotten.push(number); },
  };
}

export interface ItemWorld {
  root: string;
  config: ConveyorConfig;
  store: ConveyorStore;
  items: FakeItems;
  /** Stores the source issue as an item of `repo` with this projection. */
  seed(number: number, projection: { stage: string | null; state: string }): string;
  /** Stands in for reconciling one item: copies its source labels into the store and projects them. */
  refresh(number: number): Promise<void>;
  close(): Promise<void>;
}

export async function itemWorld(extra: (root: string) => Record<string, unknown> = () => ({})): Promise<ItemWorld> {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-item-world-"));
  log.configure({ sinks: [] });
  const config = itemConfig(root, extra(root));
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: config.hash });
  const items = new FakeItems();
  return {
    root, config, store, items,
    seed(number, projection) {
      const source = items.issues.get(number);
      if (!source) throw new Error(`Add source issue ${number} first`);
      const id = `issue-${number}`;
      store.upsertIssue({
        id, repositoryId: "repo", sourceNumber: number, sourceUrl: source.url, title: source.title, body: source.body,
        sourceState: source.state, labels: source.labels, sourceUpdatedAt: source.updatedAt,
      });
      store.setIssueProjection(id, { stage: projection.stage, state: projection.state, warning: null });
      return id;
    },
    async refresh(number) {
      const source = items.issues.get(number);
      if (!source) return;
      const id = `issue-${number}`;
      store.upsertIssue({
        id, repositoryId: "repo", sourceNumber: number, sourceUrl: source.url, title: source.title, body: source.body,
        sourceState: source.state, labels: source.labels, sourceUpdatedAt: source.updatedAt,
      });
      const stage = ["implementation", "review"].find((candidate) => source.labels.includes(`conveyor:${candidate}`)) ?? null;
      const stopped = Object.entries(STOP_LABELS).find(([, label]) => source.labels.includes(label))?.[0];
      const state = stopped ?? (source.labels.includes("conveyor:paused") ? "paused" : "active");
      store.setIssueProjection(id, { stage, state, warning: null });
    },
    async close() {
      store.close();
      log.configure({ sinks: [new ConsoleSink()] });
      await rm(root, { recursive: true, force: true });
    },
  };
}
