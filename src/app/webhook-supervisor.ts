// Webhook supervision (#676): registers the webhooks Conveyor manages, tells from deliveries and
// pings whether they arrive, and asks the source to redeliver what was missed. Handling a delivery
// stays with the service; this module only learns that one arrived.

import type { ConveyorConfig } from "../config/load";
import { REDELIVERY_WINDOW_MS } from "../config/schema";
import type { PluginRegistry, WebhookSettings } from "../core/plugins";
import { RepositoryPausedError } from "../core/repository-pause";
import type { DeliveryLogStore, EventStore, ItemStore } from "../db/ports";
import { log } from "../log/logger";
import { isSourceAccessDenied, type HookDeliveryAttempt, type WebhookAdmin } from "../source/client";

/** How far back missed webhook deliveries are redelivered, and at most how many per pass. */
const REDELIVERY_LIMIT = 50;
/** How often Conveyor looks at whether deliveries arrive. */
const WEBHOOK_CHECK_MS = 5 * 60_000;
/** A repository without any delivery for this long gets a ping, to tell a quiet repository from a broken webhook. */
const WEBHOOK_QUIET_MS = 60 * 60_000;
/** A ping that has not arrived after this long means deliveries do not arrive. */
const WEBHOOK_PING_TIMEOUT_MS = 5 * 60_000;

/** What the supervisor reads of the configuration: each repository's item source and address, the source types and the public URL. */
export interface WebhookSupervisorConfig {
  repositories: Readonly<Record<string, Pick<ConveyorConfig["repositories"][string], "source" | "address">>>;
  sources?: Readonly<Record<string, { type: string }>>;
  web?: { publicUrl?: string | undefined } | undefined;
}

export interface WebhookSupervisorDeps {
  config: WebhookSupervisorConfig;
  /** Where each item source type's plugin reads its webhook settings. */
  plugins: Pick<PluginRegistry, "itemSource">;
  store: Pick<ItemStore, "repositoryPause"> & Pick<DeliveryLogStore, "hasSourceEvent"> & EventStore;
  /** The item source, for reads that change nothing. */
  source: Pick<WebhookAdmin, "listHookDeliveries">;
  /** The item source fenced at the repository's pause, for requests that change something. */
  fencedSource: (repositoryId: string) => Pick<WebhookAdmin, "ensureWebhook" | "pingHook" | "redeliverHookDelivery">;
  /** Traces the health timer firing. */
  timerFired: () => void;
}

/** Knows which webhooks Conveyor manages and whether their deliveries arrive. */
export class WebhookSupervisor {
  readonly #deps: WebhookSupervisorDeps;
  /** Per repository: whether its webhook delivers, as last checked or shown by a delivery. */
  readonly #health = new Map<string, boolean>();
  /** When each repository last received a delivery, and when Conveyor last pinged its webhook. */
  readonly #deliveredAt = new Map<string, number>();
  readonly #pingedAt = new Map<string, number>();
  readonly #hookIds = new Map<string, number>();
  /** Repositories whose deliveries Conveyor may not list; warned about once. */
  readonly #redeliveryDenied = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WebhookSupervisorDeps) {
    this.#deps = deps;
  }

  /** Per repository: whether its webhook delivers, for the repository summaries. */
  get health(): ReadonlyMap<string, boolean> {
    return this.#health;
  }

  /** The URL a repository's item source delivers webhook events to, when Conveyor manages its webhook. */
  url(repositoryId: string): string | null {
    const { config } = this.#deps;
    const repository = config.repositories[repositoryId];
    const settings = repository ? this.settings(repository.source) : null;
    if (!settings?.managed || !config.web?.publicUrl) return null;
    return new URL(settings.path, config.web.publicUrl).href;
  }

  /** The webhook settings of an item source, as its plugin reads them; null when its plugin takes no webhooks. */
  settings(sourceName: string): WebhookSettings | null {
    const type = this.#deps.config.sources?.[sourceName]?.type;
    return type ? this.#deps.plugins.itemSource(type)?.webhook?.settings(sourceName) ?? null : null;
  }

  /** Makes sure the repository's managed webhook exists and remembers its id; nothing for an unmanaged one. */
  async register(repositoryId: string): Promise<void> {
    const repository = this.#deps.config.repositories[repositoryId];
    if (!repository) return;
    const webhook = this.settings(repository.source);
    const url = this.url(repositoryId);
    if (!webhook || !url) return;
    if (!webhook.secret) throw new Error(`a webhook secret is required for webhooks: set webhookSecret on the items provider ${repository.source}`);
    this.#hookIds.set(repositoryId, await this.#deps.fencedSource(repositoryId).ensureWebhook({ address: repository.address, url, secret: webhook.secret }));
  }

  /** Whether the repository's deliveries are known to arrive; false only after a ping went undelivered. */
  healthy(repositoryId: string): boolean {
    return this.#health.get(repositoryId) !== false;
  }

  /**
   * Asks the source to redeliver what it could not deliver while Conveyor was starting or stopped,
   * pings each webhook so its arrival shows deliveries work, and from then on supervises them.
   */
  start(): void {
    for (const repositoryId of Object.keys(this.#deps.config.repositories)) {
      if (this.url(repositoryId)) void this.redeliverMissed(repositoryId).then(() => this.ping(repositoryId));
    }
    this.#timer = setInterval(() => { this.#deps.timerFired(); void this.supervise(); }, WEBHOOK_CHECK_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Asks GitHub to send the repository's webhook a ping; its arrival shows deliveries work. A failed
   * request (an outage, the rate limit) changes nothing: health is decided by deliveries alone.
   */
  async ping(repositoryId: string): Promise<boolean> {
    if (this.#deps.store.repositoryPause(repositoryId)) return false;
    const address = this.#deps.config.repositories[repositoryId]?.address;
    const hookId = this.#hookIds.get(repositoryId);
    if (!this.url(repositoryId) || !address || hookId === undefined) return false;
    try {
      await this.#deps.fencedSource(repositoryId).pingHook(address, hookId);
      this.#pingedAt.set(repositoryId, Date.now());
      return true;
    } catch (error) {
      if (error instanceof RepositoryPausedError) return false;
      log.warn("Could not ask GitHub to ping the webhook", { repository: repositoryId }, error);
      return false;
    }
  }

  /**
   * Webhook health from deliveries: a repository quiet for an hour gets a ping, and only a ping that
   * does not arrive marks it unhealthy, for an admin to investigate. Nothing else changes with it.
   */
  async supervise(now = Date.now()): Promise<void> {
    for (const repositoryId of Object.keys(this.#deps.config.repositories)) {
      if (!this.url(repositoryId)) continue;
      const delivered = this.#deliveredAt.get(repositoryId) ?? 0;
      const pinged = this.#pingedAt.get(repositoryId);
      const awaitingPing = pinged !== undefined && delivered < pinged;
      if (awaitingPing && now - pinged >= WEBHOOK_PING_TIMEOUT_MS) this.#setHealth(repositoryId, false);
      if (now - Math.max(delivered, pinged ?? 0) >= WEBHOOK_QUIET_MS) await this.ping(repositoryId);
    }
  }

  /** A delivery arrived: the webhook works. One after an outage also asks for what was missed. */
  delivered(repositoryId: string): void {
    this.#deliveredAt.set(repositoryId, Date.now());
    const recovered = this.#health.get(repositoryId) === false;
    this.#setHealth(repositoryId, true);
    if (recovered) void this.redeliverMissed(repositoryId);
  }

  /**
   * Asks GitHub to send again the recent deliveries Conveyor never received: those of the last day
   * that no attempt delivered and that are not stored. At most REDELIVERY_LIMIT per pass. Without the
   * permission to list deliveries it warns once and leaves them to the safety-net reconcile.
   */
  async redeliverMissed(repositoryId: string): Promise<number> {
    const { store } = this.#deps;
    if (store.repositoryPause(repositoryId)) return 0;
    const address = this.#deps.config.repositories[repositoryId]?.address;
    const hookId = this.#hookIds.get(repositoryId);
    if (!address || hookId === undefined || this.#redeliveryDenied.has(repositoryId)) return 0;
    let deliveries: HookDeliveryAttempt[];
    try {
      deliveries = await this.#deps.source.listHookDeliveries(address, hookId);
    } catch (error) {
      if (isSourceAccessDenied(error)) {
        this.#redeliveryDenied.add(repositoryId);
        log.warn("Cannot list webhook deliveries; missed deliveries are not redelivered", { repository: repositoryId }, error);
      } else {
        log.warn("Could not list webhook deliveries", { repository: repositoryId }, error);
      }
      return 0;
    }
    const cutoff = Date.now() - REDELIVERY_WINDOW_MS;
    const attempts = new Map<string, typeof deliveries>();
    for (const delivery of deliveries) attempts.set(delivery.guid, [...(attempts.get(delivery.guid) ?? []), delivery]);
    const missed = [...attempts.entries()].flatMap(([guid, tries]) => {
      const delivered = tries.some((attempt) => attempt.statusCode >= 200 && attempt.statusCode < 300);
      const latest = tries.reduce((newest, attempt) => (Date.parse(attempt.deliveredAt) > Date.parse(newest.deliveredAt) ? attempt : newest));
      return delivered || Date.parse(latest.deliveredAt) < cutoff || store.hasSourceEvent("github", guid) ? [] : [latest];
    }).slice(0, REDELIVERY_LIMIT);
    let redelivered = 0;
    for (const delivery of missed) {
      try {
        await this.#deps.fencedSource(repositoryId).redeliverHookDelivery(address, hookId, delivery.id);
        redelivered += 1;
      } catch (error) {
        if (error instanceof RepositoryPausedError) break;
        log.warn("Could not ask GitHub to redeliver a webhook delivery", { repository: repositoryId, delivery: delivery.guid }, error);
      }
    }
    if (redelivered > 0) log.info("Asked GitHub to redeliver missed webhook deliveries", { repository: repositoryId, deliveries: redelivered });
    return redelivered;
  }

  #setHealth(repositoryId: string, healthy: boolean): void {
    if (this.#health.get(repositoryId) === healthy) return;
    this.#health.set(repositoryId, healthy);
    this.#deps.store.events().append("webhook.healthChanged", { healthy }, { repositoryId });
    if (healthy) log.info("Webhook deliveries arrive", { repository: repositoryId });
    else log.warn("Webhook deliveries stop arriving: a ping was not delivered; check the repository's webhook", { repository: repositoryId });
  }
}
