// The item source as the service holds it (#673): the item ports the tasks use (src/source/types.ts)
// plus the small ports only the service needs to run a repository against its source. An item
// source plugin implements them (for GitHub, its client does); the service depends on these,
// never on the provider's client.

import type { ConveyorConfig } from "../config/load";
import type { ProviderCallMeter } from "./calls";
import type { ActorPermissions } from "./trust";
import type { IssueSourceAdapter, ItemTracker, SourceIssue } from "./types";

export interface SourceRateLimit {
  limit: number;
  remaining: number;
  resetAt: string;
}

/** Sets up a repository at the source and reports on the source itself. */
export interface ItemSourceAdmin {
  /** Creates the markers (labels) Conveyor uses that the repository does not have yet. */
  ensureLabels(address: string, labels: ReadonlyArray<{ name: string; color: string; description: string }>): Promise<void>;
  repositoryVisibility(address: string): Promise<"public" | "private">;
  /** The remaining request budget; reading it is also how the service probes that the source answers. */
  rateLimit(): Promise<{ core: SourceRateLimit | null }>;
}

/** One delivery attempt of a webhook, as the source lists them. */
export interface HookDeliveryAttempt {
  /** The attempt's id, to ask for a redelivery; kept as text because it may not fit a number. */
  id: string;
  /** The delivery's id; a redelivery keeps it. */
  guid: string;
  deliveredAt: string;
  statusCode: number;
  redelivery: boolean;
}

/** Conveyor's webhook on a repository: registration, pings and redelivery of missed deliveries. */
export interface WebhookAdmin {
  /** Makes sure the webhook exists and is active; returns its id. */
  ensureWebhook(input: { address: string; url: string; secret: string }): Promise<number>;
  pingHook(address: string, hookId: number): Promise<void>;
  listHookDeliveries(address: string, hookId: number): Promise<HookDeliveryAttempt[]>;
  redeliverHookDelivery(address: string, hookId: number, deliveryId: string): Promise<void>;
}

/** Conveyor's one status comment on an item. */
export interface StatusComments {
  /** Writes the status comment and returns its id; `knownCommentId` is the one written last time, when known. */
  upsertStatusComment(address: string, issueNumber: number, markdown: string, knownCommentId?: number): Promise<number>;
  /** Whether a comment carrying `marker` exists, so a retried comment is not posted twice. */
  hasCommentWithMarker?(address: string, issueNumber: number, marker: string): Promise<boolean>;
}

/** Items the service creates, closes or reads beyond what the tasks need. */
export interface ItemLifecycle {
  createIssue(input: { address: string; title: string; body: string; labels: readonly string[] }): Promise<SourceIssue>;
  closeIssue(address: string, issueNumber: number): Promise<SourceIssue>;
  /** The items blocking this one. */
  listDependencies(address: string, issueNumber: number): Promise<SourceIssue[]>;
}

/** One stored entry of a source's read cache: its kind, format version, data and when it was read or updated. */
export interface SourceMirrorEntry { kind: string; version: number; value: unknown; at: number }

/** Where a source's read cache is kept across restarts (the database, in the service). */
export interface SourceMirrorStorage {
  get(key: string): SourceMirrorEntry | null;
  set(key: string, entry: SourceMirrorEntry): void;
  delete(key: string): void;
  /** Every key that starts with `prefix`. */
  keys(prefix: string): string[];
}

/** A source's read cache, for a source that keeps one; a source without a cache has none of these. */
export interface SourceCache {
  /** Keeps the cache in `storage`, so it outlives a restart. */
  useMirror?(storage: SourceMirrorStorage, lifetimes?: ConveyorConfig["settings"]["githubCache"]): void;
  /** Drops what was read about a repository, so its next reads go to the source. */
  forgetRepository?(address: string): void;
  /** Drops what was read about an item and its listing entries. */
  forgetIssue?(address: string, number: number): void;
  /** Drops what was read about a change request. */
  forgetChange?(address: string, number: number): void;
}

/** True for an error that says the source refused access to what was asked (a missing permission). */
export function isSourceAccessDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { accessDenied?: unknown }).accessDenied === true;
}

/** Everything the service uses of an item source. */
export type ItemSourceClient = ItemTracker & IssueSourceAdapter & ItemLifecycle & ItemSourceAdmin & WebhookAdmin & StatusComments & SourceCache & ActorPermissions;

/** What the composition root hands the service for its items: the client and the meter of its requests. */
export interface ItemSourceConnection {
  client: ItemSourceClient;
  calls: ProviderCallMeter;
}
