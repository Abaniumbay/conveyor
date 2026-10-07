export interface StatusIssue {
  number: number;
  title: string;
  state: string;
}

export interface StatusAcceptanceCriterion {
  text: string;
  passed: boolean;
  evidence?: string;
}

export interface StatusIssueReference {
  number: number;
  title?: string;
}

export interface StatusDependency extends StatusIssueReference {
  state?: string;
}

export interface StatusRun {
  id?: string;
  state: string;
  /** Null means the measurement could not be obtained. */
  durationMs: number | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  costUsd: number | null;
}

export interface StatusPullRequest {
  number: number;
  state: string;
  url?: string;
}

export interface StatusDelivery {
  state: string;
  detail?: string;
}

export interface StatusTimestamps {
  createdAt?: string;
  updatedAt?: string;
  runStartedAt?: string;
  runFinishedAt?: string;
}

export interface StatusCommentInput {
  issue: StatusIssue;
  stage: string;
  state: string;
  status?: string;
  activity?: string;
  rationale?: string;
  blocker?: string;
  acceptanceCriteria?: readonly StatusAcceptanceCriterion[];
  parent?: StatusIssueReference;
  children?: readonly StatusIssueReference[];
  dependencies?: readonly StatusDependency[];
  latestRun?: StatusRun;
  questions?: readonly string[];
  warnings?: readonly string[];
  pullRequest?: StatusPullRequest;
  delivery?: StatusDelivery;
  timestamps?: StatusTimestamps;
}

function text(value: string): string {
  // Flatten untrusted content to one line, then escape Markdown and HTML syntax.
  const flattened = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flattened
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()|])/g, "\\$1");
}

function optionalLine(label: string, value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return `- ${label}: ${text(value)}`;
}

function issueNumber(number: number): string {
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new RangeError(`invalid GitHub issue number: ${number}`);
  }
  return `#${number}`;
}

function issueReference(reference: StatusIssueReference): string {
  const title = reference.title === undefined ? "" : ` — ${text(reference.title)}`;
  return `${issueNumber(reference.number)}${title}`;
}

function duration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return "unavailable";
  let seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function cost(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "unavailable";
  const formatted = value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  const stable = formatted.includes(".") ? formatted.padEnd(formatted.indexOf(".") + 3, "0") : `${formatted}.00`;
  return `$${stable} USD`;
}

function timestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "unavailable" : parsed.toISOString();
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

function section(title: string, lines: readonly (string | undefined)[]): string[] {
  const content = lines.filter((line): line is string => line !== undefined);
  return content.length === 0 ? [] : [`### ${title}`, ...content];
}

/** Render a deterministic, plain Markdown status comment for a GitHub issue. */
export function renderStatusComment(input: StatusCommentInput): string {
  const lines = [
    `## Conveyor status: ${issueNumber(input.issue.number)} — ${text(input.issue.title)}`,
    "",
    `- Issue: ${text(input.issue.state)} · Stage: ${text(input.stage)} · State: ${text(input.state)}`,
    optionalLine("Status", input.status),
    optionalLine("Activity", input.activity),
    optionalLine("Rationale", input.rationale),
    optionalLine("Blocker", input.blocker),
  ].filter((line): line is string => line !== undefined);

  const criteria = (input.acceptanceCriteria ?? []).map((criterion) => {
    const evidence = criterion.evidence?.trim() ? ` — Evidence: ${text(criterion.evidence)}` : "";
    return `- [${criterion.passed ? "x" : " "}] ${text(criterion.text)}${evidence}`;
  });
  lines.push("", ...section("Acceptance criteria", criteria));

  const relationships: string[] = [];
  if (input.parent) relationships.push(`- Parent: ${issueReference(input.parent)}`);
  if (input.children?.length) {
    relationships.push(`- Children: ${input.children.map(issueReference).join(", ")}`);
  }
  if (input.dependencies?.length) {
    relationships.push(`- Dependencies: ${input.dependencies.map((dependency) => {
      const state = dependency.state === undefined ? "" : ` (${text(dependency.state)})`;
      return `${issueNumber(dependency.number)}${state}`;
    }).join(", ")}`);
  }
  lines.push("", ...section("Relationships", relationships));

  if (input.latestRun) {
    const run = input.latestRun;
    const usage = run.usage === null
      ? "unavailable"
      : `${run.usage.inputTokens} input tokens, ${run.usage.outputTokens} output tokens`;
    const runLines = [
      `- State: ${text(run.state)} · Duration: ${duration(run.durationMs)}`,
      `- Usage: ${usage}`,
      ...(run.costUsd === null ? [] : [`- Cost: ${cost(run.costUsd)}`]),
      optionalLine("Run ID", run.id),
    ];
    lines.push("", ...section("Latest run", runLines));
  }

  lines.push("", ...section("Questions", (input.questions ?? []).map((value) => `- ${text(value)}`)));
  lines.push("", ...section("Warnings", (input.warnings ?? []).map((value) => `- ${text(value)}`)));

  const delivery: string[] = [];
  if (input.pullRequest) {
    const url = safeHttpUrl(input.pullRequest.url);
    delivery.push(`- Pull request: ${issueNumber(input.pullRequest.number)} (${text(input.pullRequest.state)})${url ? ` — ${url}` : ""}`);
  }
  if (input.delivery) {
    const detail = input.delivery.detail?.trim() ? ` — ${text(input.delivery.detail)}` : "";
    delivery.push(`- State: ${text(input.delivery.state)}${detail}`);
  }
  lines.push("", ...section("Delivery", delivery));

  if (input.timestamps) {
    const created = timestamp(input.timestamps.createdAt);
    const updated = timestamp(input.timestamps.updatedAt);
    const started = timestamp(input.timestamps.runStartedAt);
    const finished = timestamp(input.timestamps.runFinishedAt);
    const timestampLines = [
      created || updated ? `- ${[
        created ? `Created: ${created}` : undefined,
        updated ? `Updated: ${updated}` : undefined,
      ].filter(Boolean).join(" · ")}` : undefined,
      started || finished ? `- ${[
        started ? `Run started: ${started}` : undefined,
        finished ? `Run finished: ${finished}` : undefined,
      ].filter(Boolean).join(" · ")}` : undefined,
    ];
    lines.push("", ...section("Timestamps", timestampLines));
  }

  // Omit blank lines left behind by empty optional sections while keeping one separator.
  const compact = lines.filter((line, index) => line !== "" || (index > 0 && lines[index - 1] !== ""));
  while (compact.at(-1) === "") compact.pop();
  return `${compact.join("\n")}\n\nConveyor never closes issues.`;
}
