// The `conversation` task group: read access to the shared conversation for agents.

import { z } from "zod";

import { defineGroup, pass, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";

const getInput = z.object({ limit: z.number().optional() });

const get: TaskDefinition<unknown, z.output<typeof getInput>, TaskDeps> = {
  name: "conversation.get",
  kind: "tool",
  description: "Read the shared conversation of the current item (the latest 100 messages at most).",
  reads: [],
  writes: [],
  invalidates: [],
  input: getInput,
  run({ deps, input }) {
    return pass({
      issueId: deps.issueId,
      messages: deps.store.listConversationMessages(deps.issueId, Math.min(input?.limit ?? 100, 100)),
    });
  },
};

export const conversationGroup = defineGroup("conversation", [get]);
