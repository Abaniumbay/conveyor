import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyRetention } from "../../src/app/retention";
import { runCli } from "../../src/cli/main";
import { ConveyorStore } from "../../src/db/store";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const DAY = 86_400_000;
const NOW = new Date("2026-10-06T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

/** A store with runs of a closed, a done, an open and no item, old and new, each with events and an artifact directory. */
async function world() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-retention-"));
  directories.push(root);
  const database = path.join(root, "state/conveyor.sqlite");
  const store = await ConveyorStore.open(database);
  const artifacts = path.join(root, "artifacts");
  store.upsertRepository({ id: "app", configName: "app", source: "github", address: "o/app", folder: root, configHash: "h" });
  const issue = (id: string, number: number, state: "open" | "closed", projected: string) => {
    store.upsertIssue({ id, repositoryId: "app", sourceNumber: number, sourceUrl: `u/${number}`, title: id, body: "", sourceState: state, sourceStateReason: null, labels: [], sourceUpdatedAt: daysAgo(100) });
    store.setIssueProjection(id, { stage: "review", state: projected, warning: null });
  };
  issue("closed", 1, "closed", "done");
  issue("done", 2, "open", "done");
  issue("parked", 3, "open", "needs-input");
  const run = async (id: string, issueId: string | null, finishedDaysAgo: number | null) => {
    const status = finishedDaysAgo === null ? "running" : id === "parked-old" ? "failed" : id === "steering-old" ? "interrupted" : "completed";
    store.createRun({ id, issueId, stageId: "review", attempt: 1, kind: "producer", status, configHash: "h", startedAt: daysAgo((finishedDaysAgo ?? 0) + 1) });
    if (finishedDaysAgo !== null) store.sqlite().query("UPDATE runs SET finished_at = ? WHERE id = ?").run(daysAgo(finishedDaysAgo), id);
    store.appendRunEvent(id, "agent", { text: `transcript of ${id}` });
    store.appendRunEvent(id, "tool", { name: "x" });
    await mkdir(path.join(artifacts, id, "home"), { recursive: true });
    await writeFile(path.join(artifacts, id, "home/session.jsonl"), "x".repeat(1000));
  };
  await run("closed-old", "closed", 60);
  await run("closed-new", "closed", 2);
  await run("done-old", "done", 60);
  await run("parked-old", "parked", 60);
  await run("running", "parked", null);
  await run("steering-old", null, 60);
  return { root, database, store, artifacts };
}

describe("retention", () => {
  test("prunes retired history by age while reclaiming every terminal run home", async () => {
    const { store, artifacts } = await world();
    const dry = await applyRetention({ store, artifacts, policy: { runHistoryMs: 30 * DAY, artifactsMs: 30 * DAY }, now: NOW, dryRun: true });
    expect(dry).toEqual({ dryRun: true, runHistory: { runs: 3, events: 6 }, artifacts: { directories: 3, bytes: 0 }, homes: { directories: 5, bytes: 5000, failures: [] } });
    expect(store.listRunEvents("closed-old")).toHaveLength(2);

    const report = await applyRetention({ store, artifacts, policy: { runHistoryMs: 30 * DAY, artifactsMs: 30 * DAY }, now: NOW });
    expect(report.runHistory).toEqual({ runs: 3, events: 6 });
    expect(report.homes).toEqual({ directories: 5, bytes: 5000, failures: [] });
    expect(report.artifacts).toEqual(dry.artifacts);
    for (const pruned of ["closed-old", "done-old", "steering-old"]) {
      expect(store.listRunEvents(pruned)).toEqual([]);
      expect(store.getRun(pruned)).not.toBeNull();
    }
    for (const kept of ["closed-new", "parked-old", "running"]) expect(store.listRunEvents(kept)).toHaveLength(2);
    expect((await readdir(artifacts)).sort()).toEqual(["closed-new", "parked-old", "running"]);
    store.close();
  });

  test("an unlimited retention policy keeps history but reclaims terminal homes", async () => {
    const { store, artifacts } = await world();
    expect(await applyRetention({ store, artifacts, policy: { runHistoryMs: null, artifactsMs: null }, now: NOW })).toEqual({ dryRun: false, runHistory: { runs: 0, events: 0 }, artifacts: { directories: 0, bytes: 0 }, homes: { directories: 5, bytes: 5000, failures: [] } });
    const report = await applyRetention({ store, artifacts, policy: { runHistoryMs: null, artifactsMs: DAY }, now: NOW });
    expect(report.artifacts.directories).toBe(4);
    expect(store.listRunEvents("closed-new")).toHaveLength(2);
    store.close();
  });

  test("conveyor cleanup works with the service stopped, through the same operation", async () => {
    const { root, store } = await world();
    store.close();
    const home = path.join(root, "home");
    await mkdir(path.join(home, "config"), { recursive: true });
    await writeFile(path.join(home, "config/conveyor.yaml"), [
      "settings:", `  database: ${path.join(root, "state/conveyor.sqlite")}`, `  artifacts: ${path.join(root, "artifacts")}`,
      "  retention: { runHistory: 30d }", "providers: !include builtin:providers.yaml", "",
    ].join("\n"));
    const out: string[] = [];
    const code = await runCli(["cleanup", "--home", home, "--dry-run"], { out: (text) => out.push(text), err: () => {}, environment: {}, interactive: false });
    expect(code).toBe(0);
    expect(out.join("\n")).toBe("Would delete 6 run event(s) of 3 finished run(s).\nWould delete 0 artifact directories (0 B).\nWould delete 5 run homes (4.9 KB).");
    const json: string[] = [];
    await runCli(["cleanup", "--home", home, "--artifacts", "30d", "--json"], { out: (text) => json.push(text), err: () => {}, environment: {}, interactive: false });
    expect(JSON.parse(json.join(""))).toMatchObject({ dryRun: false, runHistory: { events: 6 }, artifacts: { directories: 3 }, homes: { directories: 5, bytes: 5000, failures: [] } });
  });

  test("reclaims only terminal run homes without following links and continues after a deletion failure", async () => {
    const { store, artifacts, root } = await world();
    const external = path.join(root, "shared-cache");
    await mkdir(external);
    await writeFile(path.join(external, "keep"), "cache");
    await rm(path.join(artifacts, "closed-new", "home"), { recursive: true });
    await symlink(external, path.join(artifacts, "closed-new", "home"));
    const linkedBytes = (await lstat(path.join(artifacts, "closed-new", "home"))).size;
    store.createRun({ id: "linked-directory", issueId: "closed", stageId: "review", attempt: 2, kind: "producer", status: "completed", configHash: "h", startedAt: daysAgo(2) });
    store.sqlite().query("UPDATE runs SET finished_at = ? WHERE id = ?").run(daysAgo(1), "linked-directory");
    const linkedDirectory = path.join(root, "linked-run-directory");
    await mkdir(path.join(linkedDirectory, "home"), { recursive: true });
    await writeFile(path.join(linkedDirectory, "home", "keep"), "outside");
    await symlink(linkedDirectory, path.join(artifacts, "linked-directory"));
    const locked = path.join(artifacts, "done-old");
    await chmod(locked, 0o500);
    try {
      const report = await applyRetention({ store, artifacts, policy: { runHistoryMs: null, artifactsMs: null }, now: NOW });
      expect(report.homes.directories).toBe(4);
      expect(report.homes.bytes).toBe(3000 + linkedBytes);
      expect(report.homes.failures).toHaveLength(2);
      expect(await readFile(path.join(external, "keep"), "utf8")).toBe("cache");
      expect(await readFile(path.join(linkedDirectory, "home", "keep"), "utf8")).toBe("outside");
      expect(await readdir(path.join(artifacts, "running", "home"))).not.toEqual([]);
      expect(store.getRun("parked-old")).not.toBeNull();
      expect(store.listRunEvents("parked-old")).toHaveLength(2);
    } finally {
      await chmod(locked, 0o700);
    }
    store.close();
  });
});

describe("conveyor diagnostics export", () => {
  test("writes a redacted bundle with a manifest of what it holds and what it leaves out", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-diagnostics-"));
    directories.push(root);
    const home = path.join(root, "home");
    await mkdir(path.join(home, "config"), { recursive: true });
    await mkdir(path.join(home, "logs"), { recursive: true });
    await writeFile(path.join(home, "config/secrets.yaml"), "hook: hook-secret-from-file\n");
    await writeFile(path.join(home, "config/conveyor.yaml"), [
      "web:", `  sessionSecret: ${"p".repeat(40)}`,
      "providers:", "  items:", "    github: { type: github, webhookSecret: !secret hook, labels: { enrollment: conveyor, stageTemplate: \"conveyor:{stage}\", states: { done: conveyor:done }, metadata: { closable: conveyor:closable, orderTemplate: \"conveyor:order:{number}\" } } }", "",
    ].join("\n"));
    await writeFile(path.join(home, "logs/conveyor.log"), `${JSON.stringify({ time: "t", level: "error", message: "push failed with hook-secret-from-file and ghp_abcdefghijklmnopqrstuvwxyz0123456789", item: "app:1" })}\n`);
    const output = path.join(root, "bundle.tar.gz");
    const out: string[] = [];
    const code = await runCli(["diagnostics", "export", "--home", home, "--output", output], { out: (text) => out.push(text), err: () => {}, environment: {}, interactive: false });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Review it before sharing; it may contain:");
    expect(out.join("\n")).toContain("private issue content");

    const extracted = path.join(root, "x");
    await mkdir(extracted);
    Bun.spawnSync(["tar", "-C", extracted, "-xzf", output]);
    const [bundle] = await readdir(extracted);
    const files = (await readdir(path.join(extracted, bundle!), { recursive: true })).filter((file) => file.includes("."));
    expect(files.sort()).toEqual(["README.txt", "config.yaml", "doctor.json", "logs/conveyor.log", "manifest.json", "status.json", "version.json"]);
    for (const file of files) {
      const text = await readFile(path.join(extracted, bundle!, file), "utf8");
      expect(text).not.toContain("hook-secret-from-file");
      expect(text).not.toContain("p".repeat(40));
      expect(text).not.toContain("ghp_abcdefghij");
    }
    const manifest = JSON.parse(await readFile(path.join(extracted, bundle!, "manifest.json"), "utf8")) as { files: Array<{ file: string; mayContain: string[] }>; excluded: string[] };
    expect(manifest.excluded.join(" ")).toContain("the database");
    expect(manifest.files.find((entry) => entry.file === "config.yaml")?.mayContain.join(" ")).toContain("repository details");
    expect(await readFile(path.join(extracted, bundle!, "config.yaml"), "utf8")).toContain("webhookSecret: <redacted>");
  }, 20_000);
});
