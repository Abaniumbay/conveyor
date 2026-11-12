// What the web routes read and send besides the dashboard's reads (#675): accounts, push
// notifications, commands, the item source's webhook, the agents' MCP endpoint and the report and
// agent pages. The routes never see the whole service or the whole store, only WebSources, which
// ConveyorService provides (`webSources()`); the composition root (`serve`) builds the routes'
// dependencies from it with `webDependencies` and adds the dashboard plugin's reads.

import type { CommandBus } from "../commands/bus";
import type { ConveyorConfig } from "../config/load";
import type { AccountStore, EventStore, ItemStore, ReportStore } from "../db/ports";
import { withEventContext } from "../events/context";
import { deliverPushEvents, type PushConfiguration } from "../web/push";
import type { DashboardReads, WebAuthApi, WebHandlerDependencies } from "../web/server";
import { buildAgentProfiles } from "./agent-profiles";
import { buildReport } from "./reports";

/** The store reads and writes the web routes make: accounts and push, item routes, session events and reports. */
export type WebStore = Pick<ItemStore, "getIssue" | "listIssues"> & AccountStore & EventStore & ReportStore;

/** Everything the web routes take from the service besides the dashboard's reads: changes go through `commands`. */
export interface WebSources {
  readonly config: ConveyorConfig;
  readonly store: WebStore;
  readonly commands: Pick<CommandBus, "dispatch">;
  /** Reconciled at least once, not stopping, and every repository onboarded and reconciling. */
  isReady(): boolean;
  /** The path of the first item source that receives webhooks, or null when none does. */
  webhookPath(): string | null;
  /** Verifies and applies one webhook delivery. */
  handleWebhook(rawBody: Uint8Array, headers: Headers): Promise<void>;
  /** Serves one request of an agent's run-scoped MCP grant. */
  handleMcp(payload: unknown, token: string, callId?: string): Promise<unknown>;
}

/** The web routes' dependencies built from `sources`; the dashboard's reads come from the dashboard plugin. */
export function webDependencies(
  sources: WebSources,
  auth: WebAuthApi,
  username: string,
  push: PushConfiguration | null = null,
): Omit<WebHandlerDependencies, keyof DashboardReads> {
  const { config, store } = sources;
  return {
    auth,
    username,
    listAccounts: () => store.dashboardAccounts().map(({ id, username, role, avatar }) => ({ id, username, role, avatar })),
    getAccount: (id) => store.dashboardAccountById(id),
    getPushPreferences: (id) => store.getPushPreferences(id),
    pushPublicKey: push?.publicKey ?? null,
    dispatchPushEvents: () => deliverPushEvents(store, async (issueId) => {
      const target = store.getIssue(issueId);
      return target && target.projectedState !== "unlisted"
        ? `/issues/${encodeURIComponent(target.repositoryId)}/${target.sourceNumber}`
        : null;
    }, push),
    dispatch: (name, input, actor) => sources.commands.dispatch(name, input, actor),
    recordSession: (change, accountId) => withEventContext({ actor: { kind: "user", id: accountId } }, () =>
      store.events().append(change === "signedIn" ? "session.signedIn" : "session.signedOut", { accountId })),
    isReady: () => sources.isReady(),
    // The dashboard serves one webhook route: the first item source that receives webhooks names it.
    webhookPath: sources.webhookPath() ?? "/hooks/github",
    handleWebhook: (body, headers) => sources.handleWebhook(body, headers),
    handleMcp: (body, token, callId) => sources.handleMcp(body, token, callId),
    getIssueRoute: (reference) => {
      const issue = "id" in reference
        ? store.getIssue(reference.id)
        : store.listIssues(reference.repository).find((candidate) => candidate.sourceNumber === reference.number) ?? null;
      if (!issue) return null;
      return { id: issue.id, repository: issue.repositoryId, number: issue.sourceNumber };
    },
    getAgentProfiles: () => buildAgentProfiles(config),
    getReport: ({ period, repository }) => (repository !== null && !config.repositories[repository]
      ? null
      : buildReport({ store, config, period, repository })),
    getAgentProfile: async (agentId) =>
      (await buildAgentProfiles(config)).find((profile) => profile.id === agentId) ?? null,
  };
}
