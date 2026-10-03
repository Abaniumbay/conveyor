import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { deliverPushEvents } from "../../src/web/push";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("push delivery", () => {
  test("sends private-content-free alerts to other browsers when one subscription expires, once per event", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-push-delivery-"));
    temporaryDirectories.push(directory);
    const store = await ConveyorStore.open(path.join(directory, "conveyor.sqlite"));
    const account = store.createDashboardUser("reader", "hash");
    store.putPushSubscription(account.id, "https://push.example/expired", { p256dh: "key1", auth: "secret1" });
    store.putPushSubscription(account.id, "https://push.example/active", { p256dh: "key2", auth: "secret2" });
    store.setPushPreferences(account.id, { questions: false, stopped: false, done: true });
    store.recordPushEvent({ id: "event-1", category: "done", target: "issue-secret" });

    const delivered: Array<{ endpoint: string; payload: string }> = [];
    const sender = async (subscription: { endpoint: string }, payload: string) => {
      if (subscription.endpoint.endsWith("expired")) throw Object.assign(new Error("expired"), { statusCode: 410 });
      delivered.push({ endpoint: subscription.endpoint, payload });
    };
    const resolveTarget = (issueId: string) => issueId === "issue-secret" ? "/issues/repo/7" : null;
    const configuration = { publicKey: "public", privateKey: "private", subject: "mailto:ops@example.test" };

    await deliverPushEvents(store, resolveTarget, configuration, sender);
    await deliverPushEvents(store, resolveTarget, configuration, sender);

    expect(store.listPushSubscriptions(account.id).map(({ endpoint }) => endpoint)).toEqual(["https://push.example/active"]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload).toBe(JSON.stringify({ category: "done", url: "/issues/repo/7" }));
    expect(delivered[0]?.payload).not.toContain("secret");
    store.close();
  });
});
