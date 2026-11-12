// GitHub's webhook deliveries, read into neutral observations. Verifying the signature, reading the
// headers and recognising Conveyor's own writes coming back are GitHub's business, so they live here.

import type { PluginContext, WebhookReceipt, WebhookReceiver } from "../../../core/plugins";
import { isStatusComment, verifyGitHubSignature } from "../shared/adapter";
import { githubClient } from "../shared/client";
import { normalizeGitHubEvent } from "../shared/events";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function githubWebhookReceiver(context: PluginContext): WebhookReceiver {
  return {
    receive(body: Uint8Array, headers: Headers, secrets: readonly string[]): WebhookReceipt {
      const signature = headers.get("x-hub-signature-256");
      const secret = secrets.find((candidate) => verifyGitHubSignature(body, signature, candidate));
      if (!secret) throw new Error("invalid GitHub webhook signature");
      const deliveryId = headers.get("x-github-delivery");
      const eventType = headers.get("x-github-event");
      if (!deliveryId || !eventType) throw new Error("missing GitHub webhook headers");
      const payload = JSON.parse(new TextDecoder().decode(body)) as unknown;
      // Conveyor's own status-comment writes come back as deliveries; they carry nothing to read, and
      // reacting to them made every write trigger more writes.
      if (eventType === "issue_comment" && isStatusComment(object(object(payload).comment).body)) return { kind: "ignored" };
      const named = object(object(payload).repository).full_name;
      const repositoryAddress = typeof named === "string" ? named : null;
      // The delivered issue is identified by the address as configured, whatever its case in the payload.
      const configured = repositoryAddress === null
        ? undefined
        : Object.values(context.config.repositories).find((repository) => repository.address.toLowerCase() === repositoryAddress.toLowerCase());
      const observation = normalizeGitHubEvent(eventType, payload, {
        ...(configured ? { address: configured.address } : {}),
        enrollmentLabel: context.config.labels.enrollment,
      });
      return {
        kind: "delivery",
        secret,
        delivery: {
          deliveryId, eventType, payload, repositoryAddress,
          observations: observation ? [observation] : [],
          // The copy of GitHub now says what the delivery says, before anything reacts to it.
          recorded: () => githubClient(context).adapter.applyDelivery?.(eventType, payload),
        },
      };
    },
  };
}
