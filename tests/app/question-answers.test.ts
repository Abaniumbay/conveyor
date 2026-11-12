import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { metadataLabels, QuestionAnswers } from "../../src/app/question-answers";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";

const directories: string[] = [];
const stores: ConveyorStore[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const LABELS: ConveyorConfig["labels"] = {
  enrollment: "conveyor",
  stageTemplate: "conveyor:{stage}",
  states: { "needs-input": "conveyor:needs-input" },
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}", noSplit: "conveyor:no-split", paused: "conveyor:paused" },
};

async function answers(options: { markerExists?: boolean; commentFails?: () => boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-question-answers-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  stores.push(store);
  store.upsertRepository({ id: "app", configName: "app", source: "github", address: "owner/app", folder: root, configHash: "h" });
  store.upsertIssue({
    id: "issue", repositoryId: "app", sourceNumber: 1, sourceUrl: "https://example.com/1", title: "Add search", body: "",
    sourceState: "open", labels: ["conveyor", "conveyor:needs-input", "conveyor:closable"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.setIssueProjection("issue", { stage: "build", state: "needs-input", warning: null });
  const question = store.openQuestion({ issueId: "issue", runId: null, prompt: "Which database?", reason: "The issue names none.", options: [], allowFreeText: true });
  const calls = {
    relabels: [] as Array<{ labels: readonly string[]; preserve: readonly string[] | undefined }>,
    comments: [] as string[],
    reconciled: [] as Array<[string, number]>,
    statusComments: [] as string[],
    scheduled: 0,
    woken: [] as string[],
  };
  const qa = new QuestionAnswers({
    config: { labels: LABELS, repositories: { app: { source: "github", address: "owner/app" } } },
    store,
    source: () => ({
      async replaceConveyorLabels(_address, _number, labels, preserve) { calls.relabels.push({ labels, preserve }); },
      async addComment(_address, _number, markdown) {
        if (options.commentFails?.()) throw new Error("GitHub is unavailable");
        calls.comments.push(markdown);
        return 1;
      },
      async hasCommentWithMarker() { return options.markerExists ?? false; },
    }),
    wakeParkedAgent: (asked) => { calls.woken.push(asked.id); return false; },
    schedule: () => { calls.scheduled += 1; },
    reconcile: async (repositoryId, sourceNumber) => { calls.reconciled.push([repositoryId, sourceNumber]); },
    updateStatusComment: async (issueId) => { calls.statusComments.push(issueId); },
    shuttingDown: () => false,
    itemFields: (issueId) => ({ item: issueId }),
  });
  qa.retryDelayMs = 0;
  return { qa, store, question, calls };
}

describe("question answers", () => {
  test("an owner's answer clears needs-input, resumes the item, mirrors the answer once and requeues it", async () => {
    const { qa, store, question, calls } = await answers();
    await qa.answer(question.id, "PostgreSQL", "owner");
    expect(store.getQuestion(question.id)?.status).toBe("answered");
    expect(store.getIssue("issue")?.projectedState).toBe("active");
    expect(calls.woken).toEqual([question.id]);
    expect(calls.relabels.map((relabel) => relabel.labels)).toEqual([
      ["conveyor", "conveyor:build", "conveyor:closable"],
      ["conveyor", "conveyor:build", "conveyor:closable"],
    ]);
    expect(calls.relabels[0]!.preserve).toEqual(["conveyor:no-split", "conveyor:paused"]);

    await qa.followUpsSettled();
    expect(qa.busy).toBe(false);
    expect(calls.comments).toEqual([`<!-- conveyor:answer:${question.id} -->\n**Conveyor answer:** PostgreSQL`]);
    expect(calls.reconciled).toEqual([["app", 1]]);
    expect(calls.statusComments).toEqual(["issue"]);
    expect(store.events().read({ type: "item.requeued" }).map((event) => event.payload)).toEqual([{ reason: "answer" }]);
  });

  test("an answer the source already shows is not posted again", async () => {
    const { qa, question, calls } = await answers({ markerExists: true });
    await qa.answer(question.id, "PostgreSQL", "owner");
    await qa.followUpsSettled();
    expect(calls.comments).toEqual([]);
  });

  test("an answered question takes no second answer", async () => {
    const { qa, question } = await answers();
    await qa.answer(question.id, "PostgreSQL", "owner");
    await expect(qa.answer(question.id, "PostgreSQL", "owner")).rejects.toThrow("This question has already been answered.");
  });

  test("a scheduled answer is accepted only once its mirror succeeded, and is finished after recovery", async () => {
    let sourceDown = true;
    const { qa, store, question, calls } = await answers({ commentFails: () => sourceDown });
    await expect(qa.answer(question.id, "PostgreSQL", "scheduled-operator:run-1", "The design note names it."))
      .rejects.toThrow("Scheduled answer is pending source mirror");
    expect(store.getQuestion(question.id)?.status).toBe("open");
    expect(calls.relabels).toEqual([]);

    sourceDown = false;
    qa.recoverPendingScheduled();
    expect(qa.busy).toBe(true);
    await qa.followUpsSettled();
    expect(store.getQuestion(question.id)?.status).toBe("answered");
    expect(calls.comments).toEqual([`<!-- conveyor:answer:${question.id} -->\n**Scheduled Operator answer:** PostgreSQL`]);
  });
});

describe("metadata labels", () => {
  test("keeps the closable, no-split and order labels and drops the rest", () => {
    expect(metadataLabels(["conveyor", "conveyor:build", "conveyor:closable", "conveyor:no-split", "conveyor:order:3", "bug"], { labels: LABELS }))
      .toEqual(["conveyor:closable", "conveyor:no-split", "conveyor:order:3"]);
  });
});
