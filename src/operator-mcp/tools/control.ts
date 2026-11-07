// Operator tools that change an item: retry, steer, pause, resume and answer a question. Each issues
// its command through the command bus; none has a REST or control API route.

import { z } from "zod";

import { defineOperatorTool, type OperatorFacade } from "../tool";

const reference = z.string().trim().min(1).max(1_000).describe("The item, as `<repository>:<number>` (for example `my-repo:42`).");

/** The internal id of an item and whether an agent is running on it; a tool error names an unknown item. */
function itemOf(facade: OperatorFacade, item: string) {
  const found = facade.findItem(item);
  if (!found) throw new Error(`Unknown item: ${item}`);
  return found;
}

export const itemRetry = defineOperatorTool({
  name: "item_retry",
  description: "Retry a blocked or failed item's stopped stage, with an optional note for the agent.",
  inputSchema: z.object({ item: reference, note: z.string().max(4_000).optional() }).strict(),
  handler: async ({ input, facade }) => {
    const { issueId } = itemOf(facade, input.item);
    return (await facade.dispatch("item.retry", { issueId, note: input.note ?? "" })).result;
  },
});

export const itemSteer = defineOperatorTool({
  name: "item_steer",
  description: "Send a steering message to the agent currently running on an item. Fails, sending nothing, when no agent is running on it.",
  inputSchema: z.object({ item: reference, message: z.string().trim().min(1).max(4_000) }).strict(),
  handler: async ({ input, facade }) => {
    const { issueId, running } = itemOf(facade, input.item);
    if (!running) throw new Error(`No agent is running on ${input.item}; nothing was sent`);
    return (await facade.dispatch("item.postMessage", { issueId, message: input.message })).result;
  },
});

export const itemPause = defineOperatorTool({
  name: "item_pause",
  description: "Pause an item; its stage, worktree and history are kept.",
  inputSchema: z.object({ item: reference }).strict(),
  handler: async ({ input, facade }) => (await facade.dispatch("item.pause", { issueId: itemOf(facade, input.item).issueId })).result,
});

export const itemResume = defineOperatorTool({
  name: "item_resume",
  description: "Resume a paused item.",
  inputSchema: z.object({ item: reference }).strict(),
  handler: async ({ input, facade }) => (await facade.dispatch("item.resume", { issueId: itemOf(facade, input.item).issueId })).result,
});

export const questionAnswer = defineOperatorTool({
  name: "question_answer",
  description: "Answer an item's open question by its question id.",
  inputSchema: z.object({ questionId: z.string().min(1).max(1_000), answer: z.string().min(1).max(4_000) }).strict(),
  handler: async ({ input, facade }) => {
    await facade.dispatch("question.answer", { questionId: input.questionId, answer: input.answer });
    return { answered: input.questionId };
  },
});
