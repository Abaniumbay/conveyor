import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCli } from "../../src/cli/main";
import { ConveyorStore } from "../../src/db/store";
import { withEventContext } from "../../src/events/context";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A stopped Conveyor home whose database holds a few events of two items. */
async function home() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-events-cli-"));
  directories.push(root);
  const database = path.join(root, "state/conveyor.sqlite");
  const store = await ConveyorStore.open(database);
  store.upsertRepository({ id: "app", configName: "app", source: "github", address: "owner/app", folder: root, configHash: "h" });
  const issue = (number: number) => store.upsertIssue({
    id: `github:owner/app#${number}`, repositoryId: "app", sourceNumber: number, sourceUrl: `https://example.com/${number}`, title: "T", body: "",
    sourceState: "open", labels: [], sourceUpdatedAt: "2026-10-17T00:00:00Z",
  });
  issue(1);
  withEventContext({ actor: { kind: "user", id: "admin-1" }, correlationId: "click-1" }, () => issue(2));
  store.setQueueRank("github:owner/app#1", 10);
  // An old event, beyond --since 1h.
  store.sqlite().query("UPDATE events SET occurred_at = '2026-01-01T00:00:00.000Z' WHERE seq = (SELECT MIN(seq) FROM events)").run();
  store.close();
  const conveyorHome = path.join(root, "home");
  await mkdir(path.join(conveyorHome, "config"), { recursive: true });
  await writeFile(path.join(conveyorHome, "config/conveyor.yaml"), [
    "settings:", `  database: ${database}`, `  artifacts: ${path.join(root, "artifacts")}`, "providers: !include builtin:providers.yaml", "",
  ].join("\n"));
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([...argv, "--home", conveyorHome], { out: (text) => out.push(text), err: (text) => err.push(text), environment: {}, interactive: false });
    return { code, lines: out.join("\n").split("\n").filter(Boolean), err: err.join("\n") };
  };
  return { cli };
}

const types = (lines: string[]) => lines.map((line) => line.split(" ")[2]);

describe("conveyor events", () => {
  test("prints the log, one event per line with its item and actor", async () => {
    const { cli } = await home();
    const { code, lines } = await cli("events");
    expect(code).toBe(0);
    expect(types(lines)).toEqual(["repository.onboarded", "item.discovered", "item.discovered", "item.queueChanged"]);
    expect(lines[2]).toMatch(/ item\.discovered app:2 user:admin-1 correlation=click-1 \{"number":2\}$/);
  });

  test("--issue keeps one item's events", async () => {
    const { cli } = await home();
    expect(types((await cli("events", "--issue", "app:1")).lines)).toEqual(["item.discovered", "item.queueChanged"]);
  });

  test("--type keeps one type or a group", async () => {
    const { cli } = await home();
    expect(types((await cli("events", "--type", "item.")).lines)).toEqual(["item.discovered", "item.discovered", "item.queueChanged"]);
  });

  test("--correlation keeps the events of one command", async () => {
    const { cli } = await home();
    expect(types((await cli("events", "--correlation", "click-1")).lines)).toEqual(["item.discovered"]);
  });

  test("--since leaves out older events", async () => {
    const { cli } = await home();
    expect(types((await cli("events", "--since", "1h")).lines)).toEqual(["item.discovered", "item.discovered", "item.queueChanged"]);
  });

  test("--lines keeps the newest events", async () => {
    const { cli } = await home();
    expect(types((await cli("events", "--lines", "1")).lines)).toEqual(["item.queueChanged"]);
  });

  test("--json prints each event as JSON", async () => {
    const { cli } = await home();
    const events = (await cli("events", "--json")).lines.map((line) => JSON.parse(line) as { type: string; seq: number });
    expect(events.map((event) => event.type)).toEqual(["repository.onboarded", "item.discovered", "item.discovered", "item.queueChanged"]);
  });

  test("an unknown item is an error", async () => {
    const { cli } = await home();
    expect((await cli("events", "--issue", "app:99")).code).not.toBe(0);
  });
});
