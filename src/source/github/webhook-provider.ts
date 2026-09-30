import type { ProviderEvent, WebhookProvider } from "../../app/provider-event";
import type { ConveyorStore } from "../../db/store";
import { verifyGitHubSignature } from "./adapter";

export interface GitHubWebhookRepository {
  id: string;
  address: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function fullSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function identifier(value: unknown): string | null {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function issueReference(payload: Record<string, unknown>): string | null {
  const issue = record(payload.issue);
  const parent = record(payload.parent_issue);
  const child = record(payload.child_issue);
  return identifier(issue?.number) ?? identifier(parent?.number) ?? identifier(child?.number) ?? identifier(payload.issue_number);
}

/** GitHub authentication, delivery deduplication and payload mapping boundary. */
export class GitHubWebhookProvider implements WebhookProvider {
  constructor(
    private readonly store: Pick<ConveyorStore, "recordSourceEvent">,
    private readonly repositories: readonly GitHubWebhookRepository[],
    private readonly secret: () => string = () => process.env.CONVEYOR_GITHUB_WEBHOOK_SECRET ?? "",
    readonly webhookPath = "/hooks/github",
  ) {}

  async receive(rawBody: Uint8Array, headers: Headers): Promise<ProviderEvent[]> {
    if (!verifyGitHubSignature(rawBody, headers.get("x-hub-signature-256"), this.secret())) {
      throw new Error("invalid GitHub webhook signature");
    }
    const deliveryId = headers.get("x-github-delivery");
    const eventType = headers.get("x-github-event");
    if (!deliveryId || !eventType) throw new Error("missing GitHub webhook headers");
    const payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    if (!this.store.recordSourceEvent({ source: "github", deliveryId, eventType, payload })) return [];

    const root = record(payload);
    const repository = record(root?.repository);
    const repositoryAddress = repository?.full_name;
    if (!root || typeof repositoryAddress !== "string") return [];
    const configured = this.repositories.find(({ address }) => address.toLowerCase() === repositoryAddress.toLowerCase());
    if (!configured) return [];
    return this.mapEvent(configured.id, eventType, root);
  }

  private mapEvent(repositoryId: string, eventType: string, payload: Record<string, unknown>): ProviderEvent[] {
    if (["issues", "issue_comment", "issue_dependencies", "sub_issues"].includes(eventType)) {
      const issueRef = issueReference(payload);
      return issueRef ? [{ type: "issue.changed", repositoryId, issueRef }] : [];
    }
    if (eventType === "pull_request" && payload.action === "synchronize") {
      const pullRequest = record(payload.pull_request);
      const head = record(pullRequest?.head);
      const changeRef = identifier(pullRequest?.number);
      return changeRef && fullSha(head?.sha)
        ? [{ type: "change.updated", repositoryId, changeRef, headSha: head.sha }]
        : [];
    }
    if (eventType === "workflow_run") {
      const run = record(payload.workflow_run);
      if (!run || !fullSha(run.head_sha)) return [];
      return [{
        type: run.status === "completed" && payload.action === "completed" ? "ci.completed" : "ci.updated",
        repositoryId,
        commitSha: run.head_sha,
      }];
    }
    if (eventType === "check_suite") {
      const suite = record(payload.check_suite);
      if (!suite || !fullSha(suite.head_sha)) return [];
      return [{
        type: suite.status === "completed" && payload.action === "completed" ? "ci.completed" : "ci.updated",
        repositoryId,
        commitSha: suite.head_sha,
      }];
    }
    return [];
  }
}
