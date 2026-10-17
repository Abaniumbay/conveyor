// High-volume changes (agent transcript lines) are recorded as one coarse event per key and window:
// the first change of a quiet key is recorded at once, later ones once the window ends, so the last
// change is never left without an event.

export class EventThrottle {
  readonly #last = new Map<string, number>();
  readonly #trailing = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly windowMs: number,
    private readonly record: (key: string) => void,
  ) {}

  /** Notes a change of `key`; records it now, or once its window ends. */
  note(key: string, now = Date.now()): void {
    const last = this.#last.get(key);
    if (last === undefined || now - last >= this.windowMs) {
      this.#flush(key, now);
      return;
    }
    if (this.#trailing.has(key)) return;
    const timer = setTimeout(() => {
      this.#trailing.delete(key);
      this.#flush(key, Date.now());
    }, last + this.windowMs - now);
    // A pending trailing event never keeps the process alive.
    (timer as { unref?: () => void }).unref?.();
    this.#trailing.set(key, timer);
  }

  /** Drops the pending trailing record of `key`, for example when what it tracks has ended. */
  forget(key: string): void {
    const timer = this.#trailing.get(key);
    if (timer) clearTimeout(timer);
    this.#trailing.delete(key);
    this.#last.delete(key);
  }

  #flush(key: string, now: number): void {
    this.#last.set(key, now);
    try {
      this.record(key);
    } catch {
      // Recording can fail only once the database is closing; the change itself is stored.
    }
  }
}
