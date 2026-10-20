import renderToString from "preact-render-to-string";

import { dashboardAppShell } from "../../src/web/app-shell";
import { DashboardBody, prepareDashboardRender } from "../../src/web/render";
import type { DashboardViewModel } from "../../src/web/types";

/**
 * The page the browser shows for a view model: the application's shell (its styles and scripts)
 * with the dashboard the application draws into it, for assertions on the rendered page.
 */
export function renderDashboard(model: DashboardViewModel): string {
  prepareDashboardRender(model);
  const body = renderToString(<DashboardBody model={model} />);
  const shell = dashboardAppShell("test");
  const start = shell.indexOf('<div id="app">');
  const end = shell.lastIndexOf("</body>");
  return `${shell.slice(0, start)}<div id="app">${body}</div>${shell.slice(end)}`;
}
