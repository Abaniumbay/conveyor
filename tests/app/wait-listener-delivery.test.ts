import { afterEach, expect, test } from "bun:test";
import { chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GitHubAdapter } from "../../src/plugins/github/shared/adapter";
import { GitHubActionsCiProvider } from "../../src/plugins/github/ci/actions";
import { githubEventListener } from "../../src/plugins/github/shared/event-listener";
import { GitHubReadCache } from "../../src/plugins/github/shared/read-cache";
import { deliveryWorld, type DeliveryWorld } from "../support/delivery-world";
import { GitHubSimulator } from "../support/github-simulator";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

let world: DeliveryWorld | null = null;
let dir: string | null = null;
afterEach(async () => {
  await world?.service.close().catch(() => undefined);
  await world?.close();
  world = null;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const ADDRESS = "owner/conveyor";
let github: GitHubSimulator;
let adapter: GitHubAdapter;
/** What the simulated GitHub reports for any head's checks; it reaches the simulator when the provider reads. */
let reported: "running" | "passed" = "running";
const checks = (_w: DeliveryWorld, state: "running" | "passed") => { reported = state; };
const reads = () => github.requests.filter((request) => /\/check-runs/.test(request.path)).length;

/** A world whose `gh` prints the file `emit` once it exists and keeps running, as `gh event listen --follow` does. */
async function worldWithListener(): Promise<DeliveryWorld> {
  dir = await shortTemporaryDirectory("wait-listener-delivery-");
  const gh = path.join(dir, "gh");
  await writeFile(gh, `#!/bin/sh\nwhile [ ! -f "${dir}/emit" ]; do sleep 0.02; done\ncat "${dir}/emit"\nexec sleep 60\n`);
  await chmod(gh, 0o755);
  // The CI provider is the real GitHub one, reading through the read cache that production puts in front of GitHub.
  github = new GitHubSimulator();
  adapter = new GitHubAdapter(new GitHubReadCache(github), "conveyor");
  world = await deliveryWorld({
    waitEvents: githubEventListener(adapter, { command: gh }),
    ciList: (change, commit) => {
      github.setCheckRuns(ADDRESS, commit, [reported === "running" ? { name: "Tests", status: "in_progress" } : { name: "Tests", status: "completed", conclusion: "success" }]);
      return new GitHubActionsCiProvider(adapter).list(change, commit);
    },
  });
  return world;
}

/** Runs the item until its CI gate is parked, waiting for the head's CI. */
async function parkAtCi(w: DeliveryWorld): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await w.drive(1).catch(() => undefined);
    if (w.store.executions().getCursor("issue")?.state === "pending" && w.store.executions().subscriptions("issue").some((s) => s.topic.startsWith("ci:"))) return;
  }
  throw new Error(`never parked at CI: ${JSON.stringify(w.store.getStageState("issue"))}`);
}

/** GitHub reports a completed check suite for the head, claiming `conclusion`; resolves when the item became due. */
async function emitCompletion(w: DeliveryWorld, conclusion: string): Promise<void> {
  const line = JSON.stringify({
    type: "com.github.pull_request.check_suite.status.changed.v1",
    data: { api_url: "https://api.github.com/repos/owner/conveyor/pulls/5", head_sha: w.host.headSha, conclusion },
  });
  await writeFile(path.join(dir!, "emit.tmp"), `${line}\n`);
  await Bun.$`mv ${path.join(dir!, "emit.tmp")} ${path.join(dir!, "emit")}`;
  await becomesDue(w);
}

async function becomesDue(w: DeliveryWorld): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.parse(w.store.executions().getCursor("issue")!.wakeAt!) > Date.now() && Date.now() < deadline) await Bun.sleep(20);
  expect(Date.parse(w.store.executions().getCursor("issue")!.wakeAt!)).toBeLessThanOrEqual(Date.now());
}

const outcome = (w: DeliveryWorld) => {
  const cursor = w.store.executions().getCursor("issue");
  return { stage: w.store.getStageState("issue")?.stageId, cursor: cursor ? { stage: cursor.stage, task: cursor.taskInstanceId, state: cursor.state } : null };
};

test("AC-8.1 a woken CI wait re-reads the source and stays pending while it is still running", async () => {
  const w = await worldWithListener();
  checks(w, "running");
  await parkAtCi(w);
  const before = reads();
  w.service.start();

  await emitCompletion(w, "success");
  await w.drive(1).catch(() => undefined);

  expect(reads()).toBeGreaterThan(before);
  expect(w.store.executions().getCursor("issue")?.state).toBe("pending");
  expect(Date.parse(w.store.executions().getCursor("issue")!.wakeAt!)).toBeGreaterThan(Date.now());
  expect(w.store.executions().subscriptions("issue").some((s) => s.topic.startsWith("ci:"))).toBe(true);
});

test("AC-8.2 a woken CI wait ends as a poll would when the source shows success, whatever the payload claims", async () => {
  const woken = await worldWithListener();
  checks(woken, "running");
  await parkAtCi(woken);
  checks(woken, "passed");
  woken.service.start();
  await emitCompletion(woken, "failure");
  await woken.drive(1).catch(() => undefined);
  const viaEvent = outcome(woken);
  expect(viaEvent.cursor?.state).not.toBe("pending");
  await woken.service.close();
  await woken.close();
  await rm(dir!, { recursive: true, force: true });
  world = null;

  // Control: the same item, polled at its wake_at with no event, once the cached running checks have expired.
  const polled = await worldWithListener();
  checks(polled, "running");
  await parkAtCi(polled);
  checks(polled, "passed");
  adapter.forgetRepository(ADDRESS);
  polled.store.sqlite().query("UPDATE stage_cursors SET wake_at = ? WHERE issue_id = 'issue'").run(new Date(Date.now() - 1_000).toISOString());
  await polled.drive(1).catch(() => undefined);
  expect(outcome(polled)).toEqual(viaEvent);
});
