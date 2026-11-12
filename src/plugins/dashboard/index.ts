// The dashboard as a plugin (#675): fed by committed events and by reads, never part of the core.
// It builds the dashboard's view models from DashboardSources, keeps the live model current from
// the event bus, and serves the dashboard's reads to the web routes.

import type { PresentationModule, PresentationOptions, PresentationPlugin } from "../../core/plugins";
import { normalizeDashboard } from "../../web/model";
import { changesDashboard, DashboardFeed } from "./feed";
import { DASHBOARD_SNAPSHOT_SELECTION, DashboardViews } from "./views";

/** The built dashboard: its view models, its live feed and the reads the web routes serve. */
export interface DashboardModule extends PresentationModule {
  readonly views: DashboardViews;
  readonly feed: DashboardFeed;
}

/** Builds the dashboard and subscribes its live feed to the changes that can alter what it shows. */
export function createDashboard({ events, sources }: PresentationOptions): DashboardModule {
  const views = new DashboardViews(sources);
  // The live dashboard model, rebuilt once per burst of changes for every open dashboard.
  const feed = new DashboardFeed({
    build: () => normalizeDashboard(views.dashboard("", { ...DASHBOARD_SNAPSHOT_SELECTION }), {
      conversations: sources.store.latestConversationMessageIds(),
    }),
    status: () => views.systemStatus(),
  });
  // Anything the board shows may have changed; the feed rebuilds once the burst settles.
  const unsubscribe = events.subscribe("*", "dashboard feed", (event) => {
    if (changesDashboard(event.type)) feed.invalidate();
  });
  const stopLiveState = sources.onLiveStateChange(() => feed.invalidate());
  sources.onClose(() => {
    unsubscribe();
    stopLiveState();
    feed.close();
  });
  return {
    views,
    feed,
    reads: {
      getIssueDetails: (issueId) => views.issueDetails("", issueId),
      getDashboardSnapshot: () => feed.snapshot(),
      subscribeDashboardFeed: (listener, after) => feed.subscribe(listener, after),
      getDashboardFeedStatus: () => feed.status,
      getRecentActivity: (selection) => views.recentActivityPage(selection),
      getSteeringView: (runId) => views.steeringView(runId),
      getDashboardDone: ({ limit, q, repositoryIds }) => Object.values(normalizeDashboard(views.dashboard("", { ...DASHBOARD_SNAPSHOT_SELECTION, doneLimit: limit, q, repositoryIds: [...repositoryIds] })).items)
        .filter((item) => item.placement === "done")
        .sort((left, right) => left.order - right.order),
      getSteeringRun: (runId) => views.getSteeringRun(runId),
      getSteeringEvents: (runId, after) => views.getSteeringEvents(runId, after),
      getIssueActivity: (issueId, before) => views.issueActivity(issueId, before),
      getIssueRunEvents: (issueId, runId, before) => views.issueRunEvents(issueId, runId, before),
      getIssueConversation: (issueId) => views.issueConversation(issueId),
      getIssueJourney: (issueId) => views.issueJourney(issueId),
    },
  };
}

/** The web dashboard. */
export const dashboardPlugin: PresentationPlugin = {
  role: "presentation",
  type: "dashboard",
  create: (_context, options) => createDashboard(options),
};
