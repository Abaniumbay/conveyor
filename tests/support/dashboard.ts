// The dashboard plugin over a test's service, built the way `conveyor serve` builds it: from the
// service's DashboardSources and event bus. One module per service, so its live feed subscribes once.

import type { ConveyorService } from "../../src/app/service";
import { webDependencies } from "../../src/app/web-sources";
import { createDashboard, type DashboardModule } from "../../src/plugins/dashboard";
import type { DashboardViews } from "../../src/plugins/dashboard/views";
import type { PushConfiguration } from "../../src/web/push";
import type { WebAuthApi, WebHandlerDependencies } from "../../src/web/server";

const modules = new WeakMap<ConveyorService, DashboardModule>();

/** The dashboard module of `service`, built on first use. */
export function dashboardOf(service: ConveyorService): DashboardModule {
  let module = modules.get(service);
  if (!module) {
    module = createDashboard({ events: service.events, sources: service.dashboardSources() });
    modules.set(service, module);
  }
  return module;
}

/** The view models of `service`'s dashboard. */
export function dashboardViews(service: ConveyorService): DashboardViews {
  return dashboardOf(service).views;
}

/** The web routes' dependencies: built from the service's WebSources, with the dashboard's reads, as `conveyor serve` combines them. */
export function webDependenciesOf(
  service: ConveyorService,
  auth: WebAuthApi,
  username: string,
  push: PushConfiguration | null = null,
): WebHandlerDependencies {
  return { ...webDependencies(service.webSources(), auth, username, push), ...dashboardOf(service).reads };
}
