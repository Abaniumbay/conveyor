/** Provider-neutral events delivered to the engine after provider validation. */
export type ProviderEvent =
  | { type: "issue.changed"; repositoryId: string; issueRef: string }
  | { type: "change.updated"; repositoryId: string; changeRef: string; headSha: string }
  | { type: "ci.updated"; repositoryId: string; commitSha: string }
  | { type: "ci.completed"; repositoryId: string; commitSha: string };

export interface WebhookProvider {
  readonly webhookPath: string;
  receive(rawBody: Uint8Array, headers: Headers): Promise<ProviderEvent[]>;
}

interface CiGateWait {
  repositoryId: string;
  changeRef: string;
  commitSha: string;
  parked: boolean;
  wakePending: boolean;
}

/** Tracks active and parked CI gates so bursts coalesce to one retry per issue. */
export class CiGateWaitRegistry {
  readonly #waits = new Map<string, CiGateWait>();

  track(issueId: string, repositoryId: string, changeRef: string, commitSha: string): void {
    this.#waits.set(issueId, { repositoryId, changeRef, commitSha, parked: false, wakePending: false });
  }

  park(issueId: string): boolean {
    const wait = this.#waits.get(issueId);
    if (!wait) return false;
    if (wait.wakePending) {
      wait.wakePending = false;
    }
    wait.parked = true;
    return true;
  }

  beginEvaluation(issueId: string): void {
    const wait = this.#waits.get(issueId);
    if (!wait) return;
    wait.parked = false;
    wait.wakePending = false;
  }

  clear(issueId: string): void {
    this.#waits.delete(issueId);
  }

  wakeCommit(repositoryId: string, commitSha: string): string[] {
    return this.wake((wait) => wait.repositoryId === repositoryId && wait.commitSha === commitSha);
  }

  wakeChange(repositoryId: string, changeRef: string): string[] {
    return this.wake((wait) => wait.repositoryId === repositoryId && wait.changeRef === changeRef);
  }

  private wake(matches: (wait: CiGateWait) => boolean): string[] {
    const affected: string[] = [];
    for (const [issueId, wait] of this.#waits) {
      if (!matches(wait)) continue;
      wait.wakePending = true;
      if (!wait.parked) continue;
      wait.parked = false;
      affected.push(issueId);
    }
    return affected;
  }
}
