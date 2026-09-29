import type { DashboardViewModel, IssueCardViewModel } from "./types";
import { dashboardCss } from "./styles";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function issueLink(issue: IssueCardViewModel): string {
  const title = escapeHtml(issue.title);
  const url = issue.url;
  if (!url) return title;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return title;
    return `<a href="${escapeHtml(parsed.href)}" target="_blank" rel="noopener noreferrer">${title}<span class="sr-only"> (opens issue #${issue.number} in a new tab)</span></a>`;
  } catch {
    return title;
  }
}

function issueCard(issue: IssueCardViewModel, nested = false): string {
  const labels = issue.labels.length
    ? `<div class="labels" aria-label="Labels">${issue.labels.map((label) => `<span class="label">${escapeHtml(label)}</span>`).join("")}</div>`
    : "";
  const indicators = [
    issue.blocked ? `<span class="indicator indicator-blocked">Blocked</span>` : "",
    issue.inconsistent ? `<span class="indicator indicator-inconsistent">Inconsistent</span>` : "",
    issue.closable ? `<span class="indicator indicator-closable">Closable</span>` : "",
  ].filter(Boolean).join("");
  const criteria = issue.acceptanceCriteria.length
    ? `<section class="criteria" aria-label="Acceptance criteria"><h4>Acceptance criteria</h4><ul class="criteria-list">${issue.acceptanceCriteria.map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join("")}</ul></section>`
    : "";
  const details = [
    issue.activity ? `<p class="detail"><strong>Activity:</strong> ${escapeHtml(issue.activity)}</p>` : "",
    issue.reason ? `<p class="detail"><strong>Reason:</strong> ${escapeHtml(issue.reason)}</p>` : "",
    issue.cost ? `<p class="detail"><strong>Cost:</strong> ${escapeHtml(issue.cost)}</p>` : "",
    issue.duration ? `<p class="detail"><strong>Duration:</strong> ${escapeHtml(issue.duration)}</p>` : "",
  ].filter(Boolean).join("");
  const children = issue.children.length
    ? `<ul class="child-list" aria-label="Child issues for #${issue.number}"><li class="child-label">Child issues</li>${issue.children.map((child) => `<li>${issueCard(child, true)}</li>`).join("")}</ul>`
    : "";

  return `<article class="issue${nested ? " issue-child" : ""}" data-issue-id="${escapeHtml(issue.id)}"><h3 class="issue-title"><span class="issue-number">#${issue.number}</span><span>${issueLink(issue)}</span></h3><span class="issue-state">${escapeHtml(issue.state)}</span>${labels}${indicators ? `<div class="indicators" aria-label="Issue status">${indicators}</div>` : ""}${criteria}${details}${children}</article>`;
}

/** Render a complete, self-contained dashboard document from plain data. */
export function renderDashboard(model: DashboardViewModel): string {
  const stages = model.stages.map((stage, index) => {
    const headingId = `stage-heading-${index + 1}`;
    const issues = stage.issues.length
      ? `<ul class="issue-list">${stage.issues.map((issue) => `<li>${issueCard(issue)}</li>`).join("")}</ul>`
      : `<p class="empty">No issues in this stage</p>`;
    return `<section class="stage" aria-labelledby="${headingId}"><header class="stage-heading"><h2 id="${headingId}">${escapeHtml(stage.name)}</h2><span class="count" aria-label="${stage.issues.length} issues">${stage.issues.length}</span></header>${issues}</section>`;
  }).join("");
  const backlog = model.backlog.length
    ? `<ol class="backlog-list">${model.backlog.map((issue, index) => `<li class="backlog-row">${issueCard(issue)}<div class="reorder" role="group" aria-label="Reorder issue #${issue.number}"><button type="button" aria-label="Move #${issue.number} up"${index === 0 ? " disabled" : ""}>↑</button><button type="button" aria-label="Move #${issue.number} down"${index === model.backlog.length - 1 ? " disabled" : ""}>↓</button></div></li>`).join("")}</ol>`
    : `<p class="empty">Backlog is clear</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(model.title)} · Conveyor</title><style>${dashboardCss}</style></head><body><main class="dashboard"><header class="dashboard-header"><div><p class="eyebrow">Conveyor board</p><h1>${escapeHtml(model.title)}</h1><p class="project-meta">${escapeHtml(model.project)}</p></div><p class="updated"><span>Updated</span> <time datetime="${escapeHtml(model.updatedAt)}">${escapeHtml(model.updatedAt)}</time></p></header><section class="board" aria-label="Pipeline stages">${stages}</section><section class="backlog" aria-labelledby="backlog-heading"><header class="backlog-heading"><h2 id="backlog-heading">Backlog</h2><span class="count" aria-label="${model.backlog.length} issues">${model.backlog.length}</span></header>${backlog}</section></main></body></html>`;
}

export { dashboardCss } from "./styles";
export type { DashboardViewModel, IssueCardViewModel, StageColumnViewModel } from "./types";
