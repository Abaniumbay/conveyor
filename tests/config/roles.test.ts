import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfigError, loadConfig } from "../../src/config/load";
import { normalizeRoleNames } from "../../src/config/roles";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const SETTINGS = `
settings:
  database: /tmp/conveyor.sqlite
  logs: /tmp/logs
  workspaces: /tmp/workspaces
  artifacts: /tmp/artifacts
`;

const PIPELINE = `
pipelines:
  default:
    stages:
      - id: review
        concurrency: 1
        actions: []
        exit-gate:
          - { task: change.mergeable }
`;

const LABELS = `
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: conveyor:done }
  metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" }
`;

const OLD = `${SETTINGS}${PIPELINE}
labels:${LABELS}
sources:
  github: { type: github }
codeHosts:
  github: { type: github }
ci:
  actions: { type: github-actions }
runners:
  codex: { type: codex }
agents:
  kaveh:
    runner: codex
    instructions: /tmp/kaveh.md
    workspaceAccess: read-only
    tasks: [item.get]
repositories:
  sample:
    source: github
    codeHost: github
    ci: { provider: actions, mode: required }
    address: owner/sample
    folder: /tmp/sample
    pipeline: default
`;

const CANONICAL = `${SETTINGS}${PIPELINE}
providers:
  items:
    github:
      type: github
      labels: &labels
        enrollment: conveyor
        stageTemplate: "conveyor:{stage}"
        states: { done: conveyor:done }
        metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" }
    github-poll:
      type: github
      labels: *labels
  code:
    github: { type: github }
  ci:
    actions: { type: github-actions }
harnesses:
  codex: { type: codex }
agents:
  kaveh:
    harness: codex
    instructions: /tmp/kaveh.md
    access: read-only
    tasks: [item.get]
repositories:
  sample:
    items: github
    code: github
    ci: { provider: actions, mode: required }
    address: owner/sample
    folder: /tmp/sample
    pipeline: default
`;

async function load(body: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-roles-"));
  directories.push(directory);
  await writeFile(path.join(directory, "config.yml"), body);
  return loadConfig(directory);
}

describe("normalizeRoleNames", () => {
  test("maps canonical names to the internal model and does not mutate its input", () => {
    const input = {
      providers: { items: { a: { type: "github", labels: { x: 1 } } }, code: { c: { type: "github" } }, ci: { i: {} } },
      harnesses: { h: {} },
      agents: { g: { harness: "h", access: "read-only" } },
      repositories: { r: { items: "a", code: "c" } },
    };
    const snapshot = structuredClone(input);
    expect(normalizeRoleNames(input)).toEqual({
      sources: { a: { type: "github" } },
      codeHosts: { c: { type: "github" } },
      ci: { i: {} },
      labels: { x: 1 },
      runners: { h: {} },
      agents: { g: { runner: "h", workspaceAccess: "read-only" } },
      repositories: { r: { source: "a", codeHost: "c" } },
    });
    expect(input).toEqual(snapshot);
  });

  test("leaves a legacy document unchanged", () => {
    const document = { sources: { a: { type: "github" } }, runners: { h: {} }, agents: { g: { runner: "h" } } };
    expect(normalizeRoleNames(document)).toEqual(document);
  });

  test("rejects item providers whose labels differ", () => {
    expect(() =>
      normalizeRoleNames({ providers: { items: { a: { labels: { x: 1 } }, b: { labels: { x: 2 } } } } }),
    ).toThrow(/providers\.items\.b\.labels.*providers\.items\.a\.labels/);
  });

  test.each([
    [{ providers: { items: { a: {} } }, sources: { a: {} } }, /providers\.items.*sources|sources.*providers\.items/],
    [{ providers: { code: { a: {} } }, codeHosts: { a: {} } }, /providers\.code.*codeHosts/],
    [{ providers: { ci: { a: {} } }, ci: { a: {} } }, /providers\.ci.*"ci"/],
    [{ harnesses: { a: {} }, runners: { a: {} } }, /harnesses.*runners/],
    [{ providers: { items: { a: { labels: {} } } }, labels: {} }, /providers\.items\.a\.labels.*labels/],
    [{ agents: { g: { harness: "h", runner: "h" } } }, /agents\.g.*harness.*runner/],
    [{ agents: { g: { access: "read-only", workspaceAccess: "read-only" } } }, /agents\.g.*access.*workspaceAccess/],
    [{ repositories: { r: { items: "a", source: "a" } } }, /repositories\.r.*items.*source/],
    [{ repositories: { r: { code: "a", codeHost: "a" } } }, /repositories\.r.*code.*codeHost/],
  ])("rejects using both names for one thing: %j", (document, pattern) => {
    expect(() => normalizeRoleNames(document)).toThrow(ConfigError);
    expect(() => normalizeRoleNames(document)).toThrow(pattern);
  });

  test("rejects unknown provider roles", () => {
    expect(() => normalizeRoleNames({ providers: { storage: {} } })).toThrow(/providers\.storage/);
  });
});

describe("loadConfig with canonical names", () => {
  test("loads the canonical shape into the internal model", async () => {
    const config = await load(CANONICAL);
    expect(Object.keys(config.sources)).toEqual(["github", "github-poll"]);
    expect(config.codeHosts.github).toEqual({ type: "github" });
    expect(config.runners.codex?.type).toBe("codex");
    expect(config.agents.kaveh).toMatchObject({ runner: "codex", workspaceAccess: "read-only" });
    expect(config.repositories.sample).toMatchObject({ source: "github", codeHost: "github" });
    expect(config.labels.states.done).toBe("conveyor:done");
  });

  test("hashes equivalent old and canonical documents identically", async () => {
    const withTwoSources = OLD.replace("  github: { type: github }\ncodeHosts", "  github: { type: github }\n  github-poll: { type: github }\ncodeHosts");
    expect((await load(withTwoSources)).hash).toBe((await load(CANONICAL)).hash);
  });

  test("reports a document that mixes old and canonical names", async () => {
    await expect(load(OLD.replace("runners:", "harnesses: { codex: { type: codex } }\nrunners:"))).rejects.toThrow(
      /harnesses.*runners/,
    );
  });
});
