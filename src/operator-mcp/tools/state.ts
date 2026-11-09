import { z } from "zod";

import { criteriaOf } from "../../tasks/item";
import { defineOperatorTool, type OperatorReadStore } from "../tool";

const itemInput = z.object({
  repository: z.string().min(1).describe("Repository id or address (owner/name)"),
  number: z.number().int().positive().describe("The item's issue number"),
}).strict();

function findRepository(store: OperatorReadStore, key: string) {
  const repository = store.listRepositories().find((candidate) => candidate.id === key || candidate.address === key);
  if (!repository) throw new Error(`Repository not found: ${key}`);
  return repository;
}

function findItem(store: OperatorReadStore, repositoryKey: string, number: number) {
  const repository = findRepository(store, repositoryKey);
  const issue = store.getIssueByNumber(repository.id, number);
  if (!issue) throw new Error(`Item not found: ${repository.id}#${number}`);
  return { repository, issue };
}

const numberOf = (store: OperatorReadStore, issueId: string) => store.getIssue(issueId)?.sourceNumber ?? null;

export const listRepositories = defineOperatorTool({
  name: "list_repositories",
  description: "List the repositories onboarded to Conveyor.",
  inputSchema: z.object({}).strict(),
  handler: ({ facade }) => facade.store.listRepositories(),
});

export const listItems = defineOperatorTool({
  name: "list_items",
  description: "List items with number, title, stage, state and the numbers of the items they depend on. Optionally filter by repository.",
  inputSchema: z.object({ repository: z.string().min(1).optional().describe("Repository id or address (owner/name)") }).strict(),
  handler: ({ input, facade }) => {
    const { store } = facade;
    const repositoryId = input.repository === undefined ? undefined : findRepository(store, input.repository).id;
    return store.listIssues(repositoryId).filter((issue) => issue.projectedState !== "unlisted").map((issue) => ({
      repository: issue.repositoryId,
      number: issue.sourceNumber,
      title: issue.title,
      stage: issue.projectedStage,
      state: issue.projectedState,
      dependencies: store.listDependencies(issue.id).map((id) => numberOf(store, id) ?? id),
    }));
  },
});

export const getItem = defineOperatorTool({
  name: "get_item",
  description: "Get one item's details: stage, state, labels, parent, children, dependencies and acceptance criteria.",
  inputSchema: itemInput,
  handler: ({ input, facade }) => {
    const { store } = facade;
    const { repository, issue } = findItem(store, input.repository, input.number);
    const evidence = new Map(store.criterionTestEvidence(issue.id).map((entry) => [entry.criterionId, entry]));
    return {
      repository: repository.id,
      number: issue.sourceNumber,
      title: issue.title,
      url: issue.sourceUrl,
      sourceState: issue.sourceState,
      stage: issue.projectedStage,
      state: issue.projectedState,
      warning: issue.warning,
      labels: issue.labels,
      parent: issue.parentId ? numberOf(store, issue.parentId) : null,
      children: store.listChildren(issue.id).map((child) => {
        const row = store.getIssue(child.issueId);
        return { number: row?.sourceNumber ?? null, title: row?.title ?? null, stage: row?.projectedStage ?? null, state: row?.projectedState ?? null };
      }),
      dependencies: store.listDependencies(issue.id).map((id) => numberOf(store, id) ?? id),
      criteria: criteriaOf(issue.body).map((criterion) => ({ ...criterion, tests: evidence.get(criterion.id)?.tests ?? [] })),
    };
  },
});

export const getConversation = defineOperatorTool({
  name: "get_conversation",
  description: "Get an item's shared conversation messages (the latest `limit`, default 100).",
  inputSchema: itemInput.extend({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  handler: ({ input, facade }) => {
    const { issue } = findItem(facade.store, input.repository, input.number);
    return facade.store.listConversationMessages(issue.id, input.limit ?? 100).map((message) => ({
      id: message.id, actor: message.actorName, actorType: message.actorType, stage: message.stageId, message: message.message, createdAt: message.createdAt,
    }));
  },
});

export const getChangeStatus = defineOperatorTool({
  name: "get_change_status",
  description: "Get an item's change request and pull request (number, url, state, merge time) and its recorded CI check status.",
  inputSchema: itemInput,
  handler: ({ input, facade }) => {
    const { store } = facade;
    const { issue } = findItem(store, input.repository, input.number);
    const pullRequest = store.getCurrentPullRequest(issue.id);
    const ci = store.listIndicators(issue.id).find((indicator) => indicator.id === "ci") ?? null;
    return {
      changeRequest: pullRequest && { number: pullRequest.number, url: pullRequest.url, state: pullRequest.state, mergedAt: pullRequest.mergedAt, updatedAt: pullRequest.updatedAt },
      pullRequest: pullRequest && { number: pullRequest.number, url: pullRequest.url, state: pullRequest.state, mergedAt: pullRequest.mergedAt },
      ci: ci && { state: ci.state, detail: ci.detail, progress: ci.progress, headSha: ci.headSha, observedAt: ci.observedAt, checks: ci.entries },
    };
  },
});

export const getQuestionsAndRuns = defineOperatorTool({
  name: "get_questions_and_runs",
  description: "Get an item's pending questions and its run history (newest first).",
  inputSchema: itemInput,
  handler: ({ input, facade }) => {
    const { store } = facade;
    const { issue } = findItem(store, input.repository, input.number);
    return {
      pendingQuestions: store.listOpenQuestions().filter((question) => question.issueId === issue.id).map((question) => ({
        id: question.id, prompt: question.prompt, reason: question.reason, options: question.options, createdAt: question.createdAt,
      })),
      runs: store.listIssueRuns(issue.id).map((run) => ({
        id: run.id, stage: run.stageId, attempt: run.attempt, kind: run.kind, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
      })),
    };
  },
});

export const stateTools = [listRepositories, listItems, getItem, getConversation, getChangeStatus, getQuestionsAndRuns];
