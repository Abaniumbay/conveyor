// Wakes pending CI and change waits from `gh event listen` instead of waiting for their poll. One
// `gh event listen` process runs per repository while a wait on it is pending. An event only makes the
// matching waits due (see WaitDispatcher): the task reads the source again, so the payload never decides
// anything. A missing, old or unauthenticated gh, or a listener that exits, changes nothing about the
// waits: they keep polling at their interval, and the listener restarts with a backoff.
//
// What is relied on of the GitHub CLI (`gh event listen`, preview, v2.105.0): it prints one CloudEvent
// JSON object per line. `type` is `com.github.pull_request.<event>.v1`, for example
// `com.github.pull_request.review.submitted.v1`, `.state.changed.v1` and
// `.check_suite.status.changed.v1`; `data.api_url` names the resource that changed
// (`https://api.github.com/repos/Owner/App/pulls/5`); a check suite event has `data.conclusion` (null
// until the suite completed) and `data.head_sha`. The documentation names no repository-wide
// subscription and no event types for a new head or a merge conflict: those two names below, and the
// `data.head_sha` field, are assumptions that the manual check (AC-9) confirms.

import { changeTopic, ciTopic } from "../events/topics";
import { log } from "../log/logger";
import type { ExecutionStore } from "../db/journal";
import type { WaitDispatcher } from "./wait-dispatcher";

/** The event types the listener subscribes to. */
export const LISTEN_EVENTS = [
  "com.github.pull_request.review.submitted.v1",
  "com.github.pull_request.state.changed.v1",
  "com.github.pull_request.head.changed.v1",
  "com.github.pull_request.merge_conflict.changed.v1",
  "com.github.pull_request.check_suite.status.changed.v1",
] as const;

export interface ListenerBackoff {
  /** The delay after the first failure; it doubles with each consecutive one. */
  baseMs: number;
  capMs: number;
  /** A listener that ran this long counts as healthy: the next failure starts from the base again. */
  stableMs: number;
}

const DEFAULT_BACKOFF: ListenerBackoff = { baseMs: 1_000, capMs: 5 * 60_000, stableMs: 60_000 };
const LINE_LOG_LIMIT = 200;
const STDERR_LIMIT = 2_000;

export interface WaitListenerDependencies {
  journal: Pick<ExecutionStore, "pendingWaitTopics">;
  /** The GitHub addresses (`Owner/App`) of the configured repositories. */
  addresses: () => string[];
  dispatcher: Pick<WaitDispatcher, "wakeTopics">;
  /** The GitHub CLI; defaults to `gh`. */
  command?: string;
  backoff?: Partial<ListenerBackoff>;
}

interface Listening {
  address: string;
  child: ReturnType<typeof Bun.spawn> | null;
  startedAt: number;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const API_RESOURCE = /\/repos\/([^/]+\/[^/]+)\/(?:pulls|issues)\/(\d+)(?:\/|$)/;
const API_REPOSITORY = /\/repos\/([^/]+\/[^/]+)(?:\/|$)/;

/** The wait topics a line of `gh event listen` concerns, with the repository it names; none for a line that wakes nothing. */
export function listenerEventTopics(value: unknown): { repository: string; topics: string[] } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const event = value as { type?: unknown; data?: unknown };
  if (typeof event.type !== "string" || !event.type.startsWith("com.github.pull_request.")) return null;
  if (typeof event.data !== "object" || event.data === null) return null;
  const data = event.data as { api_url?: unknown; conclusion?: unknown; head_sha?: unknown };
  if (typeof data.api_url !== "string") return null;
  const resource = API_RESOURCE.exec(data.api_url);
  const repository = (resource ?? API_REPOSITORY.exec(data.api_url))?.[1]?.toLowerCase();
  if (!repository) return null;
  if (event.type.includes(".check_suite.")) {
    // Only a finished suite changes what a CI wait decides.
    if (typeof data.conclusion !== "string" || data.conclusion === "" || typeof data.head_sha !== "string" || data.head_sha === "") return { repository, topics: [] };
    return { repository, topics: [ciTopic(repository, data.head_sha)] };
  }
  return { repository, topics: resource ? [changeTopic(repository, Number(resource[2]))] : [] };
}

/** The repository a CI or change wait topic names, lower-cased. */
function topicRepository(topic: string): string | null {
  const [kind, repository] = topic.split(":");
  return (kind === "ci" || kind === "change") && repository ? repository : null;
}

export class WaitListener {
  readonly #deps: WaitListenerDependencies;
  readonly #backoff: ListenerBackoff;
  readonly #listening = new Map<string, Listening>();
  #started = false;
  #closed = false;

  constructor(deps: WaitListenerDependencies) {
    this.#deps = deps;
    this.#backoff = { ...DEFAULT_BACKOFF, ...deps.backoff };
  }

  /** The repositories (lower-cased) a listener is kept for, running or waiting to restart. */
  get active(): string[] {
    return [...this.#listening.keys()].sort();
  }

  /** Lets sync() start listeners: the service calls it once it starts. */
  start(): void {
    this.#started = true;
    this.sync();
  }

  /** Starts a listener for each repository with a pending wait and stops the ones without. Never throws. */
  sync(): void {
    if (!this.#started || this.#closed) return;
    try {
      const wanted = this.#wanted();
      for (const [key, listening] of this.#listening) {
        if (!wanted.has(key)) this.#stop(key, listening);
      }
      for (const [key, address] of wanted) {
        if (!this.#listening.has(key)) this.#start(key, address);
      }
    } catch (error) {
      log.warn("Could not update the pull request event listeners", {}, error);
    }
  }

  /** Stops every listener; none starts again. */
  close(): void {
    this.#closed = true;
    for (const [key, listening] of this.#listening) this.#stop(key, listening);
  }

  #wanted(): Map<string, string> {
    const configured = new Map(this.#deps.addresses().map((address) => [address.toLowerCase(), address] as const));
    const wanted = new Map<string, string>();
    for (const topic of this.#deps.journal.pendingWaitTopics()) {
      const repository = topicRepository(topic);
      const address = repository ? configured.get(repository) : undefined;
      if (repository && address) wanted.set(repository, address);
    }
    return wanted;
  }

  #stop(key: string, listening: Listening): void {
    // Removed first: its exit is deliberate, not a failure to report or to restart.
    this.#listening.delete(key);
    if (listening.timer) clearTimeout(listening.timer);
    listening.timer = null;
    const child = listening.child;
    listening.child = null;
    try {
      child?.kill();
    } catch {
      // Already gone.
    }
  }

  #start(key: string, address: string): void {
    const listening: Listening = { address, child: null, startedAt: Date.now(), failures: 0, timer: null };
    this.#listening.set(key, listening);
    this.#spawn(key, listening);
  }

  #spawn(key: string, listening: Listening): void {
    listening.startedAt = Date.now();
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(
        [this.#deps.command ?? "gh", "event", "listen", "--follow", "--resource", `https://github.com/${listening.address}`, "--event", LISTEN_EVENTS.join(",")],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      );
    } catch (error) {
      this.#failed(key, listening, null, error instanceof Error ? error.message : String(error));
      return;
    }
    listening.child = child;
    void this.#watch(key, listening, child);
  }

  async #watch(key: string, listening: Listening, child: ReturnType<typeof Bun.spawn>): Promise<void> {
    try {
      const [, stderr, exitCode] = await Promise.all([
        this.#read(key, child.stdout as ReadableStream<Uint8Array>),
        new Response(child.stderr as ReadableStream<Uint8Array>).text().catch(() => ""),
        child.exited,
      ]);
      if (this.#listening.get(key) !== listening || listening.child !== child) return;
      listening.child = null;
      this.#failed(key, listening, exitCode, stderr.trim().slice(0, STDERR_LIMIT));
    } catch (error) {
      if (this.#listening.get(key) !== listening || listening.child !== child) return;
      listening.child = null;
      this.#failed(key, listening, null, error instanceof Error ? error.message : String(error));
    }
  }

  /** Reads lines until the stream ends; a partial last line is handled like any other line, and fails to parse. */
  async #read(key: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        this.#line(key, buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    this.#line(key, buffered);
  }

  #line(key: string, line: string): void {
    const text = line.trim();
    if (text === "") return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      log.warn("gh event listen printed a line that is not JSON; skipped", { repository: key, line: text.slice(0, LINE_LOG_LIMIT) });
      return;
    }
    try {
      const event = listenerEventTopics(value);
      // An event of another repository than the one this process listens for is not ours to act on.
      if (event && event.repository === key && event.topics.length > 0) this.#deps.dispatcher.wakeTopics(event.topics);
    } catch (error) {
      log.warn("Could not handle a gh event listen event", { repository: key }, error);
    }
  }

  /** One warning per failure; the waits keep polling and the listener starts again after a backoff. */
  #failed(key: string, listening: Listening, exitCode: number | null, cause: string): void {
    log.warn("gh event listen stopped; waits keep polling", { repository: key, exitCode, cause });
    if (Date.now() - listening.startedAt >= this.#backoff.stableMs) listening.failures = 0;
    const delay = Math.min(this.#backoff.capMs, this.#backoff.baseMs * 2 ** listening.failures);
    listening.failures += 1;
    listening.timer = setTimeout(() => {
      listening.timer = null;
      if (this.#closed || this.#listening.get(key) !== listening) return;
      // The wait that asked for it may have ended while the timer ran.
      try {
        if (!this.#wanted().has(key)) {
          this.#stop(key, listening);
          return;
        }
      } catch {
        return this.#stop(key, listening);
      }
      this.#spawn(key, listening);
    }, delay);
  }
}
