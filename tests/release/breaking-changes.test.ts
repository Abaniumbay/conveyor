import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { checkBreakingChanges } from "../../scripts/check-breaking-changes";
import { renderPublicSurface, type SurfaceSources } from "../../scripts/generate-public-surface";
import type { Command } from "../../src/cli/command";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const command = (name: string, options: string[] = []): Command => ({
  name, summary: name, options: Object.fromEntries(options.map((option) => [option, { type: "boolean", description: option }])), run: async () => {},
});

function sources(change: (sources: SurfaceSources) => void = () => {}): SurfaceSources {
  const base: SurfaceSources = {
    commands: [command("status", ["watch"]), command("item retry")],
    globalOptions: { home: {} },
    events: { "item.offboarded": { payload: z.object({ status: z.string() }).strict() } },
    tasks: [{ name: "change.setMetadata", input: z.object({ headSha: z.string(), title: z.string() }).strict() }],
    config: z.object({ settings: z.object({ retention: z.object({ runHistory: z.string() }).strict() }).strict() }).strict(),
    stage: z.object({ id: z.string() }).strict(),
    builtinFiles: ["stages.yaml", "providers.yaml"],
    labels: ["conveyor", "conveyor:done"],
  };
  change(base);
  return base;
}

/** A repository whose main has the base surface, and a branch whose head has `head` and the given fragments. */
async function pullRequest(head: SurfaceSources, fragments: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-breaking-"));
  directories.push(root);
  git(root, "init", "--quiet", "--initial-branch", "main");
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "public-surface.txt"), renderPublicSurface(sources()));
  git(root, "add", ".");
  git(root, "commit", "--quiet", "--message", "base");
  git(root, "switch", "--quiet", "--create", "feature");
  await writeFile(path.join(root, "docs", "public-surface.txt"), renderPublicSurface(head));
  await mkdir(path.join(root, "changes"), { recursive: true });
  for (const [name, content] of Object.entries(fragments)) await writeFile(path.join(root, "changes", name), content);
  git(root, "add", ".");
  git(root, "commit", "--quiet", "--allow-empty", "--message", "head");
  return root;
}

const BREAKING = "---\nsection: Removed\nbreaking: true\n---\nThe option is gone.\n";
const NOT_BREAKING = "---\nsection: Changed\n---\nSomething changed.\n";

describe("a removed public name needs a breaking fragment", () => {
  test("a removed CLI option without a breaking fragment fails, naming the option", async () => {
    const root = await pullRequest(sources((s) => { s.commands = [command("status"), command("item retry")]; }), { "1-x.md": NOT_BREAKING });
    const result = await checkBreakingChanges(root, "main");
    expect(result.passed).toBe(false);
    expect(result.removed).toEqual(["cli-option conveyor status --watch"]);
    expect(result.message).toContain("  - cli-option conveyor status --watch");
  });

  test("the same removal with a breaking fragment passes", async () => {
    const root = await pullRequest(sources((s) => { s.commands = [command("status"), command("item retry")]; }), { "1-x.md": BREAKING });
    const result = await checkBreakingChanges(root, "main");
    expect(result.passed).toBe(true);
    expect(result.breakingFragments).toEqual(["changes/1-x.md"]);
  });

  test("a removed CLI command fails", async () => {
    const root = await pullRequest(sources((s) => { s.commands = [command("status", ["watch"])]; }));
    expect((await checkBreakingChanges(root, "main")).removed).toEqual(["cli conveyor item retry"]);
  });

  test("a removed event fails", async () => {
    const root = await pullRequest(sources((s) => { s.events = {}; }));
    const result = await checkBreakingChanges(root, "main");
    expect(result.passed).toBe(false);
    expect(result.removed).toEqual(["event item.offboarded", "event-field item.offboarded status"]);
  });

  test("a removed event payload field fails", async () => {
    const root = await pullRequest(sources((s) => { s.events = { "item.offboarded": { payload: z.object({}).strict() } }; }));
    expect((await checkBreakingChanges(root, "main")).removed).toEqual(["event-field item.offboarded status"]);
  });

  test("a removed task fails", async () => {
    const root = await pullRequest(sources((s) => { s.tasks = []; }));
    expect((await checkBreakingChanges(root, "main")).removed).toContain("task change.setMetadata");
  });

  test("a removed tool input fails", async () => {
    const root = await pullRequest(sources((s) => { s.tasks = [{ name: "change.setMetadata", input: z.object({ headSha: z.string() }).strict() }]; }));
    expect((await checkBreakingChanges(root, "main")).removed).toEqual(["task-input change.setMetadata title"]);
  });

  test("a removed configuration key fails", async () => {
    const root = await pullRequest(sources((s) => { s.config = z.object({ settings: z.object({ retention: z.object({}).strict() }).strict() }).strict(); }));
    expect((await checkBreakingChanges(root, "main")).removed).toEqual(["config settings.retention.runHistory"]);
  });

  test("a renamed configuration key counts as a removal", async () => {
    const root = await pullRequest(sources((s) => { s.config = z.object({ settings: z.object({ retention: z.object({ runEvents: z.string() }).strict() }).strict() }).strict(); }));
    const result = await checkBreakingChanges(root, "main");
    expect(result.passed).toBe(false);
    expect(result.removed).toEqual(["config settings.retention.runHistory"]);
  });

  test("a removed builtin file fails", async () => {
    const root = await pullRequest(sources((s) => { s.builtinFiles = ["providers.yaml"]; }));
    expect((await checkBreakingChanges(root, "main")).removed).toEqual(["builtin stages.yaml"]);
  });

  test("a removed system label fails", async () => {
    const root = await pullRequest(sources((s) => { s.labels = ["conveyor"]; }));
    expect((await checkBreakingChanges(root, "main")).removed).toEqual(["label conveyor:done"]);
  });

  test("additions alone pass without a breaking fragment", async () => {
    const root = await pullRequest(sources((s) => {
      s.commands = [command("status", ["watch", "since"]), command("item retry"), command("item pause")];
      s.events = { ...s.events, "item.paused": { payload: z.object({}).strict() } };
      s.builtinFiles = [...s.builtinFiles, "labels.yaml"];
      s.labels = [...s.labels, "conveyor:paused"];
    }));
    const result = await checkBreakingChanges(root, "main");
    expect(result.passed).toBe(true);
    expect(result.removed).toEqual([]);
  });

  test("a base without the surface file passes", async () => {
    const root = await pullRequest(sources());
    git(root, "switch", "--quiet", "main");
    git(root, "rm", "--quiet", "docs/public-surface.txt");
    git(root, "commit", "--quiet", "--message", "no surface");
    git(root, "switch", "--quiet", "--create", "other");
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "public-surface.txt"), renderPublicSurface(sources((s) => { s.labels = []; })));
    expect((await checkBreakingChanges(root, "main")).passed).toBe(true);
  });
});
