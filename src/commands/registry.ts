// Every action a person or the CLI can take, declared once. The dashboard and the control socket
// send commands; nothing outside the command bus calls a service mutation for them.

import { z } from "zod";

export type CommandRole = "user" | "superuser";

interface Definition<I extends z.ZodType> {
  role: CommandRole;
  description: string;
  input: I;
}

const define = <I extends z.ZodType>(role: CommandRole, description: string, input: I): Definition<I> => ({ role, description, input });

const id = z.string().min(1).max(1_000);
const text = (max: number) => z.string().max(max);
const passwordHash = z.string().min(1).max(1_000);
const preferences = z.object({ questions: z.boolean(), stopped: z.boolean(), done: z.boolean() }).strict();

export const COMMANDS = {
  // Items
  "item.retry": define("superuser", "Retry an item's stopped stage, with an optional note for the agent.", z.object({ issueId: id, note: text(4_000) }).strict()),
  "item.pause": define("superuser", "Pause an item by removing its enrollment label.", z.object({ issueId: id }).strict()),
  "item.resume": define("superuser", "Resume a paused item.", z.object({ issueId: id }).strict()),
  "item.postMessage": define("user", "Post a message to an item's conversation.", z.object({ issueId: id, message: z.string().trim().min(1).max(4_000) }).strict()),

  // Questions, gates and review
  "question.answer": define("superuser", "Answer an open question.", z.object({ questionId: id, answer: z.string().min(1).max(4_000) }).strict()),
  "gate.approve": define("superuser", "Approve a manual gate the item is waiting on.", z.object({ issueId: id, stageId: id, gateId: id }).strict()),
  "gate.setRequirement": define("superuser", "Make a manual gate required or optional for one item.", z.object({ issueId: id, stageId: id, gateId: id, required: z.boolean() }).strict()),
  "finding.dismiss": define("superuser", "Dismiss an open review finding with a reason.", z.object({ issueId: id, findingId: id, reason: z.string().trim().min(1).max(2_000) }).strict()),

  // Backlog
  "backlog.reorder": define("superuser", "Move a queued item one place up or down.", z.object({ issueId: id, direction: z.enum(["up", "down"]) }).strict()),
  "backlog.move": define("superuser", "Move a queued item before another one, or last.", z.object({ issueId: id, beforeIssueId: id.nullable() }).strict()),

  // Operator
  "steering.start": define("superuser", "Start an operator (steering) run with a prompt.", z.object({ prompt: z.string().max(12_000) }).strict()),

  // Accounts and profile
  "account.create": define("superuser", "Create a dashboard account.", z.object({ username: z.string().min(1).max(64), passwordHash }).strict()),
  "account.setPassword": define("user", "Set an account's password; a user may set only their own.", z.object({ accountId: id, passwordHash }).strict()),
  "account.delete": define("superuser", "Delete a dashboard account that is not a superuser.", z.object({ accountId: id }).strict()),
  "account.setAvatar": define("user", "Choose your avatar.", z.object({ accountId: id, avatar: z.string().min(1).max(64) }).strict()),
  "notifications.updateSettings": define("user", "Choose which push notifications you receive.", z.object({ accountId: id, preferences }).strict()),
  "notifications.subscribe": define("user", "Register a browser for push notifications.", z.object({
    accountId: id, endpoint: z.url().max(2_000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(200) }).strict(),
  }).strict()),
  "notifications.unsubscribe": define("user", "Remove a browser's push subscription.", z.object({ accountId: id, endpoint: z.string().max(2_000) }).strict()),

  // Service
  "admission.drain": define("superuser", "Stop admitting new work; running work continues.", z.object({ reason: text(500) }).strict()),
  "admission.resume": define("superuser", "Admit new work again.", z.object({}).strict()),
  "service.restart": define("superuser", "Restart a supervised Conveyor; `force` interrupts running work.", z.object({ force: z.boolean() }).strict()),
  "service.cleanup": define("superuser", "Apply retention now, or report what it would remove.", z.object({
    dryRun: z.boolean(), runHistoryMs: z.number().int().positive().nullable(), artifactsMs: z.number().int().positive().nullable(),
  }).strict()),
  "release.schedule": define("superuser", "Schedule an upgrade or rollback once running work drains.", z.object({
    kind: z.enum(["upgrade", "rollback"]), prefix: z.string().min(1).max(1_000), version: z.string().max(100).optional(),
    drainTimeoutMs: z.number().int().positive(), restoreBackup: z.boolean(),
  }).strict()),
  "release.cancel": define("superuser", "Cancel a scheduled upgrade or rollback.", z.object({}).strict()),
} as const satisfies Record<string, Definition<z.ZodType>>;

export type CommandName = keyof typeof COMMANDS;
export type CommandInput<N extends CommandName> = z.infer<(typeof COMMANDS)[N]["input"]>;

export function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(COMMANDS, value);
}
