// The plugin contract (#670). A plugin implements one role (item source, code host, CI, agent harness) for one
// configuration `type` and hands the core only that role's port. Plugins of one provider share
// resources (an API client, its cache and call meter) through the context, never by importing each
// other. The composition root registers the plugins (src/plugins/index.ts) and builds them here.

import type { z } from "zod";

import type { CiProvider } from "../app/ci-provider";
import type { CodeHost } from "../codehost/types";
import { CodeHostRegistry } from "../codehost/registry";
import type { ConveyorConfig } from "../config/load";
import type { Observation } from "../events/catalogue";
import type { Harness } from "../harness/types";

/** What a plugin receives when it is built. */
export interface PluginContext {
  readonly config: ConveyorConfig;
  /** One instance per key for the whole service: what plugins of one provider share. */
  shared<T>(key: string, create: () => T): T;
}

/** A verified webhook delivery, read into what Conveyor understands. */
export interface WebhookDelivery {
  /** The provider's id for the delivery; a repeated delivery is recognised by it. */
  deliveryId: string;
  /** The provider's name for the kind of delivery. */
  eventType: string;
  /** The delivery as received, stored for redelivery checks and diagnostics. */
  payload: unknown;
  /** The repository address the delivery is about, or null when it names none. */
  repositoryAddress: string | null;
  /** What the delivery reports, as neutral observations; recorded only for a configured repository. */
  observations: Observation[];
  /** Runs after the delivery was recorded for a configured repository, before anything reacts to it. */
  recorded?: () => void;
}

export type WebhookReceipt =
  /** A delivery and the secret that verified it. */
  | { kind: "delivery"; secret: string; delivery: WebhookDelivery }
  /** A verified delivery that carries nothing to record (Conveyor's own writes coming back). */
  | { kind: "ignored" };

/** Reads an item source's webhook deliveries. */
export interface WebhookReceiver {
  /** Verifies the request with one of `secrets` and reads it; throws when none verifies it or it is malformed. */
  receive(body: Uint8Array, headers: Headers, secrets: readonly string[]): WebhookReceipt;
}

/** How one configured item source receives webhooks. */
export interface WebhookSettings {
  /** The route its deliveries arrive on. */
  path: string;
  /** The secret that signs its deliveries; empty when none is configured. */
  secret: string;
  /** Whether Conveyor registers the webhook at the provider itself. */
  managed: boolean;
}

/** What an item source plugin provides. Tracker ports (#673) join the webhook receiver here. */
export interface ItemSourceModule {
  webhook?: WebhookReceiver & {
    /** The webhook settings of the configured item source `sourceName`. */
    settings(sourceName: string): WebhookSettings;
  };
}

/** An item source for repositories whose `items` provider has this type. */
export interface ItemsPlugin {
  readonly role: "items";
  readonly type: string;
  /** Validates and completes a configured item source of this type (`providers.items.<name>`). */
  readonly configSchema: z.ZodType;
  create(context: PluginContext): ItemSourceModule;
}

/** A code host for repositories whose `code` (or, without one, `items`) provider has this type. */
export interface CodePlugin {
  readonly role: "code";
  readonly type: string;
  /** Validates and completes a configured code host of this type (`providers.code.<name>`). */
  readonly configSchema: z.ZodType;
  create(context: PluginContext, name: string): CodeHost;
}

export interface CiPluginOptions {
  repositoryId: string;
  /** The configured provider name, or the source-native default when the repository names none. */
  providerName: string;
  /** The named provider's configuration; undefined for the source-native default. */
  provider: { type: string; [key: string]: unknown } | undefined;
  /** Settings the stage gives the CI task (legacy stages configure triggers there). */
  stageInput: Record<string, unknown> | undefined;
}

/** A CI provider for repositories whose CI provider has this type. */
export interface CiPlugin {
  readonly role: "ci";
  readonly type: string;
  /** Validates and completes a configured CI provider of this type (`providers.ci.<name>`). */
  readonly configSchema: z.ZodType;
  create(context: PluginContext, options: CiPluginOptions): CiProvider;
}

/** An agent harness for runners of this type. */
export interface HarnessPlugin {
  readonly role: "harness";
  readonly type: string;
  create(context: PluginContext): Harness;
}

export type Plugin = ItemsPlugin | CodePlugin | CiPlugin | HarnessPlugin;

/** The CI type a repository uses when it names no CI provider. */
export const DEFAULT_CI_TYPE = "github-actions";

export function pluginContext(config: ConveyorConfig): PluginContext {
  const shared = new Map<string, unknown>();
  return {
    config,
    shared<T>(key: string, create: () => T): T {
      if (!shared.has(key)) shared.set(key, create());
      return shared.get(key) as T;
    },
  };
}

/** The registered plugins, looked up by role and configuration type. */
export class PluginRegistry {
  readonly #plugins = new Map<string, Plugin>();

  constructor(plugins: readonly Plugin[], readonly context: PluginContext) {
    for (const plugin of plugins) {
      const key = `${plugin.role}:${plugin.type}`;
      if (this.#plugins.has(key)) throw new Error(`two ${plugin.role} plugins have the type "${plugin.type}"`);
      this.#plugins.set(key, plugin);
    }
  }

  #find<R extends Plugin["role"]>(role: R, type: string): Extract<Plugin, { role: R }> | undefined {
    return this.#plugins.get(`${role}:${type}`) as Extract<Plugin, { role: R }> | undefined;
  }

  /** A CI provider for a repository; throws when no plugin handles the configured type. */
  ciProvider(type: string, options: CiPluginOptions): CiProvider {
    const plugin = this.#find("ci", type);
    if (!plugin) throw new Error(`unsupported CI provider type "${type}" (${options.providerName}): no plugin is registered for it`);
    return plugin.create(this.context, options);
  }

  /** The item source module of a provider type, or null when no plugin provides it. */
  itemSource(type: string): ItemSourceModule | null {
    const plugin = this.#find("items", type);
    return plugin ? this.context.shared(`items:${type}`, () => plugin.create(this.context)) : null;
  }

  /** Every harness by runner type. */
  harnesses(): Record<string, Harness> {
    const harnesses: Record<string, Harness> = {};
    for (const plugin of this.#plugins.values()) {
      if (plugin.role === "harness") harnesses[plugin.type] = plugin.create(this.context);
    }
    return harnesses;
  }

  /**
   * The named code hosts: every configured code host, and for each item source without a code host
   * of the same name, one of the source's own type when a code plugin provides it.
   */
  codeHosts(): CodeHostRegistry {
    const registry = new CodeHostRegistry();
    const config = this.context.config;
    for (const [name, definition] of Object.entries(config.codeHosts ?? {})) {
      const plugin = this.#find("code", definition.type);
      if (plugin) registry.register(name, plugin.create(this.context, name));
    }
    for (const [name, source] of Object.entries(config.sources ?? {})) {
      const plugin = this.#find("code", source.type);
      if (plugin && !registry.get(name)) registry.register(name, plugin.create(this.context, name));
    }
    return registry;
  }
}
