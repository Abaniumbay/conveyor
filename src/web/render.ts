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
    return `<section class="stage" aria-labelledby="${headingId}"><header class="stage-heading"><h2 id="${headingId}">${escapeHtml(stage.name)}</h2><div class="stage-summary">${stage.cost ? `<span class="stage-cost">${escapeHtml(stage.cost)}</span>` : ""}<span class="count" aria-label="${stage.issues.length} issues">${stage.issues.length}</span></div></header>${issues}</section>`;
  }).join("");
  const backlog = model.backlog.length
    ? `<ol class="backlog-list">${model.backlog.map((issue, index) => {
        const controls = (["up", "down"] as const).map((direction) => {
          const disabled = direction === "up"
            ? index === 0
            : index === model.backlog.length - 1;
          return `<form method="post" action="/backlog/reorder"><input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}"><input type="hidden" name="issueId" value="${escapeHtml(issue.id)}"><input type="hidden" name="direction" value="${direction}"><button type="submit" aria-label="Move #${issue.number} ${direction}"${disabled ? " disabled" : ""}>${direction === "up" ? "↑" : "↓"}</button></form>`;
        }).join("");
        return `<li class="backlog-row">${issueCard(issue)}<div class="reorder" role="group" aria-label="Reorder issue #${issue.number}">${controls}</div></li>`;
      }).join("")}</ol>`
    : `<p class="empty">Backlog is clear</p>`;

  const questions = model.questions.length
    ? `<section class="questions" aria-labelledby="questions-heading"><header class="backlog-heading"><h2 id="questions-heading">Needs your input</h2><span class="count">${model.questions.length}</span></header><div class="question-grid">${model.questions.map((question, index) => {
        const field = question.allowFreeText
          ? `<label class="free-text">Your answer<input name="answer" list="question-options-${index}" required></label><datalist id="question-options-${index}">${question.options.map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`).join("")}</datalist>`
          : question.options.map((option, optionIndex) => `<label class="option"><input type="radio" name="answer" value="${escapeHtml(option.id)}"${optionIndex === 0 ? " required" : ""}> ${escapeHtml(option.label)}</label>`).join("");
        return `<article class="question"><p class="question-issue">Issue #${question.issueNumber}</p><h3>${escapeHtml(question.prompt)}</h3><p>${escapeHtml(question.reason)}</p><form method="post" action="/questions/${escapeHtml(encodeURIComponent(question.id))}/answer"><input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">${field}<button class="answer-button" type="submit">Answer</button></form></article>`;
      }).join("")}</div></section>`
    : "";
  const warnings = model.systemWarnings.length
    ? `<section class="system-warnings" role="alert"><h2>System attention</h2><ul>${model.systemWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></section>`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(model.title)} · Conveyor</title><style>${dashboardCss}</style></head><body><main class="dashboard"><header class="dashboard-header"><div><p class="eyebrow">Conveyor board</p><h1>${escapeHtml(model.title)}</h1><p class="project-meta">${escapeHtml(model.project)}</p></div><div class="header-actions"><p class="updated"><span>Updated</span> <time datetime="${escapeHtml(model.updatedAt)}">${escapeHtml(model.updatedAt)}</time></p><form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}"><button class="logout" type="submit">Sign out</button></form></div></header>${warnings}${questions}<section class="board" aria-label="Pipeline stages">${stages}</section><section class="backlog" aria-labelledby="backlog-heading"><header class="backlog-heading"><h2 id="backlog-heading">Backlog</h2><span class="count" aria-label="${model.backlog.length} issues">${model.backlog.length}</span></header>${backlog}</section></main></body></html>`;
}

export { dashboardCss } from "./styles";
export type { DashboardViewModel, IssueCardViewModel, QuestionViewModel, StageColumnViewModel } from "./types";
