// The browser's copy of the live dashboard model: one snapshot, then the patches the server streams.
// It never asks the server for the board again unless the stream says it missed too much.

import { applyDashboardPatch, dashboardPatchSchema, dashboardSnapshotSchema, olderDoneSchema, systemStatusSchema, type DashboardItem, type DashboardModel } from "../model";
import type { DashboardAccountViewModel, SystemStatusViewModel } from "../types";

export type ConnectionState = "connecting" | "live" | "offline" | "signed-out";

export interface LiveState {
  model: DashboardModel;
  /** The last patch the model includes. */
  seq: number;
  account: DashboardAccountViewModel;
  csrfToken: string;
  status: SystemStatusViewModel | null;
  connection: ConnectionState;
  /** Finished items loaded on request beyond the most recent ones; they no longer change. */
  olderDone: readonly DashboardItem[];
}

/** The subset of EventSource the store uses. */
export interface LiveEventSource {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface LiveStoreOptions {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  openStream: (url: string) => LiveEventSource;
  /** Called when the session is gone; the page goes to the sign-in form. */
  onSignedOut: () => void;
  now?: () => number;
}

const CLOSED = 2;
/** The server sends a heartbeat every four seconds; a stream silent for longer than this is dead. */
const STALE_STREAM_MS = 12_000;
/** Retries after a failed restart wait longer each time, up to this. */
const MAX_RETRY_MS = 30_000;

export class LiveStore {
  readonly #options: LiveStoreOptions;
  readonly #listeners = new Set<(state: LiveState) => void>();
  #state: LiveState | null = null;
  #stream: LiveEventSource | null = null;
  #reloading: Promise<void> | null = null;
  #lastActivity = 0;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LiveStoreOptions) {
    this.#options = options;
  }

  get state(): LiveState | null {
    return this.#state;
  }

  subscribe(listener: (state: LiveState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Loads the snapshot and starts following the stream. */
  async start(): Promise<void> {
    await this.#load();
    if (!this.#state) return;
    this.#connect();
  }

  /** Loads finished items until Done can show `limit` of them. */
  async loadDone(limit: number): Promise<void> {
    const response = await this.#options.fetch(`/api/v1/done?limit=${limit}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (response.status === 401) return this.#signedOut();
    if (!response.ok || !this.#state) return;
    const { items } = olderDoneSchema.parse(await response.json());
    this.#state = { ...this.#state, olderDone: items };
    this.#emit();
  }

  /**
   * Reopens the stream when it closed or went silent: a phone suspends a hidden page, and a proxy can
   * drop a connection without the browser noticing. The replay brings the model up to date.
   */
  check(): void {
    const state = this.#state;
    if (!state || state.connection === "signed-out" || this.#retry) return;
    const stream = this.#stream;
    if (stream && stream.readyState !== CLOSED && this.#now() - this.#lastActivity <= STALE_STREAM_MS) return;
    this.close();
    this.#connect();
  }

  close(): void {
    this.#stream?.close();
    this.#stream = null;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  async #load(): Promise<void> {
    const response = await this.#options.fetch("/api/v1/snapshot", { headers: { accept: "application/json" }, cache: "no-store" });
    if (response.status === 401) {
      this.#signedOut();
      return;
    }
    if (!response.ok) throw new Error(`the dashboard snapshot failed with ${response.status}`);
    const snapshot = dashboardSnapshotSchema.parse(await response.json());
    this.#state = {
      model: snapshot.model,
      seq: snapshot.seq,
      account: snapshot.account,
      csrfToken: snapshot.csrfToken,
      status: snapshot.status ?? this.#state?.status ?? null,
      connection: this.#state?.connection ?? "connecting",
      olderDone: this.#state?.olderDone ?? [],
    };
    this.#emit();
  }

  #connect(): void {
    const stream = this.#options.openStream(`/api/v1/stream?after=${this.#state?.seq ?? 0}`);
    this.#stream = stream;
    this.#lastActivity = this.#now();
    const alive = () => { if (this.#stream === stream) this.#lastActivity = this.#now(); };
    stream.onopen = () => {
      alive();
      this.#failures = 0;
      this.#setConnection("live");
    };
    stream.addEventListener("keep-alive", alive);
    stream.onerror = () => {
      this.#setConnection("offline");
      // EventSource retries by itself; a closed stream (for example a 401) needs a fresh start.
      if (stream.readyState === CLOSED) void this.#restart();
    };
    stream.addEventListener("patch", (event) => {
      alive();
      this.#patch(event.data);
    });
    stream.addEventListener("status", (event) => {
      alive();
      if (!this.#state) return;
      this.#state = { ...this.#state, status: systemStatusSchema.parse(JSON.parse(event.data)) };
      this.#emit();
    });
    stream.addEventListener("reset", () => { void this.#reload(); });
  }

  #patch(data: string): void {
    const state = this.#state;
    if (!state) return;
    const patch = dashboardPatchSchema.parse(JSON.parse(data));
    // Replays can overlap what the snapshot already holds.
    if (patch.seq <= state.seq) return;
    applyDashboardPatch(state.model, patch);
    this.#state = { ...state, seq: patch.seq };
    this.#emit();
  }

  async #reload(): Promise<void> {
    this.#reloading ??= this.#load().finally(() => { this.#reloading = null; });
    await this.#reloading;
  }

  async #restart(): Promise<void> {
    this.close();
    try {
      await this.#load();
    } catch {
      // The server is unreachable; try again, a little later each time.
      this.#failures += 1;
      this.#retry = setTimeout(() => {
        this.#retry = null;
        void this.#restart();
      }, Math.min(1_000 * 2 ** (this.#failures - 1), MAX_RETRY_MS));
      return;
    }
    if (this.#state && this.#state.connection !== "signed-out") this.#connect();
  }

  #signedOut(): void {
    this.close();
    if (this.#state) this.#setConnection("signed-out");
    this.#options.onSignedOut();
  }

  #setConnection(connection: ConnectionState): void {
    if (!this.#state || this.#state.connection === connection) return;
    this.#state = { ...this.#state, connection };
    this.#emit();
  }

  #emit(): void {
    const state = this.#state;
    if (!state) return;
    for (const listener of this.#listeners) listener(state);
  }
}
