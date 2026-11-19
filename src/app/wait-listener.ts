// What the service gives an item source's event listener (src/source/events.ts): the repositories with
// a pending wait, and the wake of the waits an event concerns. The listener itself is the source's.

import type { ExecutionStore } from "../db/journal";
import type { WaitEventListenerContext } from "../source/events";
import type { WaitDispatcher } from "./wait-dispatcher";

/** The repository a CI or change wait topic names, lower-cased. */
function topicRepository(topic: string): string | null {
  const [kind, repository] = topic.split(":");
  return (kind === "ci" || kind === "change") && repository ? repository : null;
}

export function waitEventListenerContext(deps: {
  journal: Pick<ExecutionStore, "pendingWaitTopics">;
  /** The addresses of the configured repositories. */
  addresses: () => string[];
  dispatcher: Pick<WaitDispatcher, "wakeTopics">;
}): WaitEventListenerContext {
  return {
    pendingRepositories: () => {
      const configured = new Map(deps.addresses().map((address) => [address.toLowerCase(), address] as const));
      const pending = new Set<string>();
      for (const topic of deps.journal.pendingWaitTopics()) {
        const repository = topicRepository(topic);
        const address = repository ? configured.get(repository) : undefined;
        if (address) pending.add(address);
      }
      return [...pending];
    },
    wake: (topics, prepare) => {
      const waiting = new Set(deps.journal.pendingWaitTopics());
      const matched = topics.filter((topic) => waiting.has(topic));
      if (matched.length === 0) return;
      prepare?.();
      deps.dispatcher.wakeTopics(matched);
    },
  };
}
