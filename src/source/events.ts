// The event listener port (#778): an item source that can tell, without a public URL, that a pull
// request or its checks changed. The service gives it the repositories that have a pending wait and
// a way to wake those waits; the source's implementation (for GitHub, `gh event listen`) does the rest.

export interface WaitEventListenerContext {
  /** The addresses of the repositories that have a pending CI or change wait right now. */
  pendingRepositories: () => string[];
  /**
   * Makes the pending waits on `topics` due. `prepare` runs first and only when a pending wait matches,
   * so an event nobody waits for changes nothing; it is where a source drops what it cached.
   */
  wake: (topics: readonly string[], prepare?: () => void) => void;
}

export interface WaitEventListener {
  /** Lets sync() start listening: the service calls it once it starts. */
  start(): void;
  /** Listens to the repositories with a pending wait and to no others. Never throws. */
  sync(): void;
  /** Stops listening for good. */
  close(): void;
}

export type WaitEventListenerFactory = (context: WaitEventListenerContext) => WaitEventListener;
