import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { notificationClient } from "../../src/web/notifications-client";

function harness(options: { publicKey: string | null; permission?: string; requestResult?: string; subscribeError?: Error }) {
  const status = { textContent: "" };
  const fields = [
    { name: "questions", checked: true },
    { name: "stopped", checked: false },
    { name: "done", checked: false },
  ];
  let submit: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  let permissionRequests = 0;
  const requests: Array<{ url: string; method: string }> = [];
  const form = {
    dataset: { csrf: "csrf-token" },
    querySelectorAll: () => fields,
    addEventListener: (type: string, handler: typeof submit) => { if (type === "submit") submit = handler; },
  };
  const notificationApi = {
    permission: options.permission ?? "default",
    requestPermission: async () => { permissionRequests++; return options.requestResult ?? "granted"; },
  };
  const context = {
    document: { getElementById: (id: string) => id === "notification-settings" ? form : status },
    window: { PushManager: class {}, Notification: notificationApi },
    location: { protocol: "https:", hostname: "example.test" },
    Notification: notificationApi,
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    navigator: {
      serviceWorker: {
        register: async () => ({ pushManager: {
          getSubscription: async () => null,
          subscribe: async () => { throw options.subscribeError ?? new Error("subscription refused"); },
        } }),
      },
    },
    fetch: async (url: string, init: { method?: string } = {}) => {
      const method = init.method ?? "GET";
      requests.push({ url, method });
      return {
        ok: true,
        json: async () => ({ publicKey: options.publicKey, preferences: { questions: false, stopped: false, done: false } }),
      };
    },
  };
  runInNewContext(notificationClient, context);
  return {
    fields,
    requests,
    status,
    permissionRequests: () => permissionRequests,
    submit: async () => { await submit?.({ preventDefault() {} }); },
  };
}

describe("notification settings client", () => {
  test("does not ask for permission on page load and reports missing server push configuration", async () => {
    const page = harness({ publicKey: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.permissionRequests()).toBe(0);
    expect(page.status.textContent).toContain("server has no push keys configured");
    page.fields[0]!.checked = true;
    await page.submit();
    expect(page.permissionRequests()).toBe(0);
    expect(page.requests.some((request) => request.url === "/api/notifications/settings" && request.method === "POST")).toBe(false);
    expect(page.status.textContent).toContain("Push is inactive in this browser");
  });

  test("reports denied permission and subscription failures without saving preferences", async () => {
    const denied = harness({ publicKey: "public-key", permission: "denied" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    denied.fields[0]!.checked = true;
    await denied.submit();
    expect(denied.permissionRequests()).toBe(0);
    expect(denied.status.textContent).toContain("Notifications are blocked in browser settings");
    expect(denied.fields[0]?.checked).toBe(false);
    expect(denied.requests.some((request) => request.method === "POST")).toBe(false);

    const failedSubscription = harness({ publicKey: "public-key", requestResult: "granted", subscribeError: new Error("subscription refused") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    failedSubscription.fields[0]!.checked = true;
    await failedSubscription.submit();
    expect(failedSubscription.permissionRequests()).toBe(1);
    expect(failedSubscription.status.textContent).toContain("subscription refused");
    expect(failedSubscription.status.textContent).toContain("Push is inactive in this browser");
    expect(failedSubscription.fields[0]?.checked).toBe(false);
    expect(failedSubscription.requests.some((request) => request.method === "POST")).toBe(false);
  });
});
