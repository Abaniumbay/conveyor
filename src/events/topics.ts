// What a waiting task waits for, as plain strings: a commit's CI, a pull request, an issue. The
// repository is the lower-cased GitHub address, as webhook events name it.

export const WAIT_KINDS = ["ci", "change", "dependencies", "default"] as const;
/** Which fallback deadline (settings.events.fallback) a wait uses when its event does not come. */
export type WaitKind = (typeof WAIT_KINDS)[number];

export interface WaitFor {
  topics: string[];
  kind: WaitKind;
}

export const ciTopic = (repository: string, sha: string): string => `ci:${repository.toLowerCase()}:${sha}`;
export const changeTopic = (repository: string, number: number): string => `change:${repository.toLowerCase()}:${number}`;
export const issueTopic = (repository: string, number: number): string => `issue:${repository.toLowerCase()}:${number}`;
