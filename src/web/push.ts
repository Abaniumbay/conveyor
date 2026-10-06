import webpush from "web-push";
import type { ConveyorStore, PushEvent, PushSubscription } from "../db/store";

export interface PushConfiguration {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export type PushSender = (subscription: webpush.PushSubscription, payload: string) => Promise<unknown>;

/** The configured VAPID keys (`web.push`), else the CONVEYOR_VAPID_* variables; null when incomplete or invalid. */
export function pushConfiguration(
  configured?: PushConfiguration,
  environment: NodeJS.ProcessEnv = process.env,
): PushConfiguration | null {
  const publicKey = configured?.publicKey ?? environment.CONVEYOR_VAPID_PUBLIC_KEY ?? "";
  const privateKey = configured?.privateKey ?? environment.CONVEYOR_VAPID_PRIVATE_KEY ?? "";
  const subject = configured?.subject ?? environment.CONVEYOR_VAPID_SUBJECT ?? "";
  if (!publicKey || !privateKey || !subject || !/^https:\/\//.test(subject) && !/^mailto:/.test(subject)) return null;
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    return { publicKey, privateKey, subject };
  } catch {
    return null;
  }
}

export async function deliverPushEvents(
  store: ConveyorStore,
  resolveTarget: (issueId: string) => Promise<string | null> | string | null,
  configuration: PushConfiguration | null,
  send: PushSender = (subscription, payload) => webpush.sendNotification(subscription, payload),
): Promise<void> {
  if (!configuration) return;
  for (const event of store.pendingPushEvents()) {
    const target = await resolveTarget(event.target);
    if (!target) continue;
    for (const subscription of store.pushEventSubscriptions(event.id)) {
      if (!store.claimPushDelivery(event.id, subscription.id)) continue;
      try {
        await send(toWebPushSubscription(subscription), JSON.stringify({
          category: event.category,
          url: target,
        }));
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) store.deletePushSubscription(subscription.accountId, subscription.endpoint);
      }
    }
  }
}

function toWebPushSubscription(subscription: PushSubscription): webpush.PushSubscription {
  return { endpoint: subscription.endpoint, keys: subscription.keys };
}
