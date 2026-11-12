import { describe, expect, test } from "bun:test";

import type { CiProvider } from "../../src/app/ci-provider";
import type { DashboardSources } from "../../src/app/dashboard-sources";
import type { CodeHost } from "../../src/codehost/types";
import type { ConveyorConfig } from "../../src/config/load";
import { EventBus } from "../../src/events/bus";
import { pluginContext, PluginRegistry, type CiPluginOptions, type Plugin, type PresentationModule, type PresentationPlugin } from "../../src/core/plugins";
import type { Harness } from "../../src/harness/types";
import { codexProfile } from "../../src/plugins/codex/profile";
import type { DashboardReads } from "../../src/web/server";
import { z } from "zod";

/** A provider schema that accepts any entry: these tests are not about provider configuration. */
const anyProvider = z.object({ type: z.string() }).passthrough();

const config = (sections: Partial<Pick<ConveyorConfig, "codeHosts" | "sources">> = {}) =>
  ({ codeHosts: {}, sources: {}, ...sections }) as unknown as ConveyorConfig;

const host = (name: string) => ({ name }) as unknown as CodeHost;
const harness = (id: string): Harness => ({ id, capabilities: { sessionResume: false }, profile: codexProfile, run: async () => { throw new Error("unused"); } });
/** A harness plugin of `type` whose runner schema accepts any entry. */
const harnessPlugin = (type: string, id: string): Plugin =>
  ({ role: "harness", type, configSchema: z.object({ type: z.string(), command: z.string() }).passthrough(), profile: codexProfile, create: () => harness(id) });

describe("PluginRegistry", () => {
  test("builds a CI provider from the plugin of the configured type", () => {
    const seen: CiPluginOptions[] = [];
    const provider = {} as CiProvider;
    const registry = new PluginRegistry([{ role: "ci", configSchema: anyProvider, type: "fake-ci", create: (_context, options) => { seen.push(options); return provider; } }], pluginContext(config()));
    const options = { repositoryId: "app", providerName: "main", provider: { type: "fake-ci" }, stageInput: undefined };
    expect(registry.ciProvider("fake-ci", options)).toBe(provider);
    expect(seen).toEqual([options]);
  });

  test("names the type and provider when no CI plugin handles it", () => {
    const registry = new PluginRegistry([], pluginContext(config()));
    expect(() => registry.ciProvider("jenkins", { repositoryId: "app", providerName: "build", provider: { type: "jenkins" }, stageInput: undefined }))
      .toThrow('unsupported CI provider type "jenkins" (build): no plugin is registered for it');
  });

  test("rejects two plugins of the same role and type", () => {
    const plugins: Plugin[] = [
      harnessPlugin("codex", "a"),
      harnessPlugin("codex", "b"),
    ];
    expect(() => new PluginRegistry(plugins, pluginContext(config()))).toThrow('two harness plugins have the type "codex"');
  });

  test("returns every harness by runner type", () => {
    const registry = new PluginRegistry([
      harnessPlugin("codex", "codex"),
      harnessPlugin("pi", "pi"),
      { role: "ci", configSchema: anyProvider, type: "fake-ci", create: () => ({}) as CiProvider },
    ], pluginContext(config()));
    expect(Object.keys(registry.harnesses()).sort()).toEqual(["codex", "pi"]);
  });

  test("registers each configured code host by its type", () => {
    const registry = new PluginRegistry([{ role: "code", configSchema: anyProvider, type: "gitlab", create: (_context, name) => host(name) }], pluginContext(config({
      codeHosts: { review: { type: "gitlab" } } as never,
    })));
    expect(registry.codeHosts().get("review")).toEqual(host("review"));
  });

  test("gives an item source without a code host of its name one of the source's own type", () => {
    const registry = new PluginRegistry([{ role: "code", configSchema: anyProvider, type: "github", create: (_context, name) => host(name) }], pluginContext(config({
      sources: { github: { type: "github" } } as never,
    })));
    expect(registry.codeHosts().get("github")).toEqual(host("github"));
  });

  test("leaves a code host out when no plugin provides its type", () => {
    const registry = new PluginRegistry([], pluginContext(config({ codeHosts: { review: { type: "gitlab" } } as never })));
    expect(registry.codeHosts().get("review")).toBeUndefined();
  });

  test("shares one instance per key between the plugins of a context", () => {
    const context = pluginContext(config());
    let created = 0;
    const first = context.shared("client", () => ({ id: ++created }));
    const second = context.shared("client", () => ({ id: ++created }));
    expect(second).toBe(first);
    expect(created).toBe(1);
  });

  test("builds one item source module per type and none for an unknown type", () => {
    let built = 0;
    const registry = new PluginRegistry([{ role: "items", configSchema: anyProvider, type: "jira", create: () => { built += 1; return {}; } }], pluginContext(config()));
    expect(registry.itemSource("jira")).toBe(registry.itemSource("jira"));
    expect(built).toBe(1);
    expect(registry.itemSource("github")).toBeNull();
  });

  test("builds a presentation of its type from the options it is given, and none for an unknown type", () => {
    const options = { events: new EventBus(), sources: {} as DashboardSources };
    const received: unknown[] = [];
    const module: PresentationModule = { reads: {} as DashboardReads };
    const plugin: PresentationPlugin = { role: "presentation", type: "dashboard", create: (_context, given) => { received.push(given); return module; } };
    const registry = new PluginRegistry([plugin], pluginContext(config()));
    expect(registry.presentation("dashboard", options)).toBe(module);
    expect(received).toEqual([options]);
    expect(registry.presentation("tui", options)).toBeNull();
  });
});
