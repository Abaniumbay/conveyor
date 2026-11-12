import type { IssueFieldDefinition, ResolvedFieldValue } from "./item-metadata";
import type { ManagedSectionName } from "./managed-sections";

export interface SourceIssue {
  id: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason?: string | null;
  labels: string[];
  /** The issue type GitHub reports, when the owner defines types; null when none is set. */
  type?: string | null;
  updatedAt: string;
}

/** The actor GitHub attributes to a source event. A missing actor is deliberately untrusted. */
export interface SourceEventActor {
  login: string | null;
}

/** Provenance for the source events that can admit or replace agent-visible issue text. */
export interface SourceIssueProvenance {
  /** The effective current enrollment-label event, or null when the label is not currently applied. */
  enrollment: SourceEventActor | null;
  /** The last actor GitHub recorded for a title edit, if GitHub recorded one. */
  title: SourceEventActor | null;
  /** The last actor GitHub recorded for a body edit, if GitHub recorded one. */
  body: SourceEventActor | null;
}

export interface PullRequestReference {
  number: number;
  url: string;
  state: string;
}

/** True for an error that says the source no longer has the issue (deleted, or transferred away). */
export function isIssueGone(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { issueGone?: unknown }).issueGone === true;
}

export interface IssueSourceAdapter {
  /** Every issue of the repository, or with `since` only those updated at or after that time. */
  listIssues(address: string, options?: { since?: string }): Promise<SourceIssue[]>;
  getIssue(address: string, issueNumber: number): Promise<SourceIssue>;
  /** Read the event actors needed to decide whether enrollment and text are trusted. */
  getIssueProvenance(address: string, issueNumber: number, enrollmentLabel: string): Promise<SourceIssueProvenance>;
}

// The item source's ports (#673): small interfaces, each what one kind of consumer needs. An item
// source plugin implements them (for GitHub, its client does structurally); tasks and the core
// depend on these, never on the provider's client.

/** Reads items as the source holds them now. */
export interface ItemReader {
  getIssue(address: string, issueNumber: number): Promise<SourceIssue>;
  /** The item's children, as the source relates them. */
  listSubIssues(address: string, issueNumber: number): Promise<SourceIssue[]>;
}

/** Posts comments on an item; returns the comment's id. */
export interface ItemComments {
  addComment(address: string, issueNumber: number, markdown: string): Promise<number>;
}

/** Conveyor's managed sections of an item's text (src/source/managed-sections.ts). */
export interface ItemSections {
  /** Replaces one section of `baseBody` (the accepted text), refusing when the text moved past `expectedRevision`. */
  updateManagedSection(input: {
    address: string;
    issueNumber: number;
    section: ManagedSectionName;
    markdown: string;
    expectedRevision: string;
    baseBody: string;
  }): Promise<SourceIssue>;
  /** The revision of an item text's managed sections, to detect concurrent edits. */
  managedRevision(body: string): string;
}

/** Parent, children and blockers. */
export interface ItemRelations {
  setParent(input: { address: string; childNumber: number; parentNumber: number }): Promise<void>;
  setDependencies(input: { address: string; issueNumber: number; blockerNumbers: readonly number[] }): Promise<void>;
  createChildIssue(input: {
    address: string;
    parentNumber: number;
    title: string;
    body: string;
    labels: readonly string[];
    type?: string;
    fields?: readonly ResolvedFieldValue[];
  }): Promise<SourceIssue>;
}

/** The markers that carry Conveyor's workflow state and the item's system areas (labels on GitHub). */
export interface ItemMarkers {
  /** Sets Conveyor's own markers on an item, keeping `preserveLabels` and every marker Conveyor does not manage. */
  replaceConveyorLabels(address: string, issueNumber: number, conveyorLabels: readonly string[], preserveLabels?: readonly string[]): Promise<void>;
  /** Sets which of the repository's managed system-area markers an item carries. */
  replaceManagedProjectLabels(address: string, issueNumber: number, managedProjectLabels: readonly string[], selectedLabels: readonly string[]): Promise<void>;
}

/** An item's title. */
export interface ItemTitles {
  setTitle(address: string, issueNumber: number, title: string): Promise<void>;
}

/** Item types and fields, where the source defines them; null when it defines none. */
export interface ItemMetadata {
  listIssueTypes(owner: string): Promise<string[] | null>;
  listIssueFields(owner: string): Promise<IssueFieldDefinition[] | null>;
  getIssueFieldValues(address: string, issueNumber: number): Promise<Record<string, string>>;
  setIssueType(address: string, issueNumber: number, type: string): Promise<void>;
  setIssueFieldValues(address: string, issueNumber: number, values: readonly ResolvedFieldValue[]): Promise<void>;
}

/** Everything the item tasks use of an item source. */
export type ItemTracker = ItemReader & ItemComments & ItemSections & ItemRelations & ItemMarkers & ItemTitles & ItemMetadata;
