// The plugin contract (#670). A plugin implements one role (code host, CI, agent harness) for one
// configuration `type` and hands the core only that role's port. Plugins of one provider share
// resources (an API client, its cache and call meter) through the context, never by importing each
// other. The composition root registers the plugins (src/plugins/index.ts) and builds them here.

import type { CiProvider } from "../app/ci-provider";
import type { CodeHost } from "../codehost/types";
import { CodeHostRegistry } from "../codehost/registry";
import type { ConveyorConfig } from "../config/load";
import type { Harness } from "../harness/types";

/** What a plugin receives when it is built. */
export interface PluginContext {
  readonly config: ConveyorConfig;
  /** One instance per key for the whole service: what plugins of one provider share. */
  shared<T>(key: string, create: () => T): T;
}

/** A code host for repositories whose `code` (or, without one, `items`) provider has this type. */
export interface CodePlugin {
  readonly role: "code";
  readonly type: string;
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
  create(context: PluginContext, options: CiPluginOptions): CiProvider;
}

/** An agent harness for runners of this type. */
export interface HarnessPlugin {
  readonly role: "harness";
  readonly type: string;
  create(context: PluginContext): Harness;
}

export type Plugin = CodePlugin | CiPlugin | HarnessPlugin;

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
