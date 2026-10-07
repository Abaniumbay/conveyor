import { createHmac, timingSafeEqual } from "node:crypto";

import type { PullRequestReference, SourceIssue } from "../types";
import {
  parseManagedSections,
  upsertManagedSection,
  type ManagedSectionName,
} from "./managed-sections";

export interface GitHubTransportRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  paginate?: boolean;
  /** Return stdout as text instead of parsing JSON (e.g. job logs). */
  raw?: boolean;
}

export interface GitHubTransport {
  request<T>(request: GitHubTransportRequest): Promise<T>;
}

export class GitHubTransportError extends Error {
  override readonly name = "GitHubTransportError";

  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export class GhCliTransport implements GitHubTransport {
  constructor(private readonly command = "gh") {}

  async request<T>(request: GitHubTransportRequest): Promise<T> {
    const args = [this.command, "api", request.path, "--method", request.method];
    if (request.paginate) args.push("--paginate", "--slurp");
    // CI job logs carry ANSI colour codes, which gh refuses to print otherwise.
    if (request.raw) args.push("--allow-escape-sequences");
    if (request.body !== undefined) args.push("--input", "-");

    const child = Bun.spawn(args, {
      stdin: request.body === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    if (request.body !== undefined && child.stdin !== undefined) {
      child.stdin.write(JSON.stringify(request.body));
      child.stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      throw new GitHubTransportError(
        `GitHub API ${request.method} ${request.path} failed: ${stderr.trim() || `exit ${exitCode}`}`,
        exitCode,
        stderr,
      );
    }
    if (request.raw) return stdout as T;
    if (stdout.trim().length === 0) return null as T;
    const decoded = JSON.parse(stdout) as unknown;
    if (request.paginate && Array.isArray(decoded)) {
      return decoded.flat() as T;
    }
    return decoded as T;
  }
}

interface GitHubLabel {
  name: string;
}

interface GitHubIssue {
  id: number;
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  labels: Array<GitHubLabel | string>;
  updated_at: string;
  pull_request?: unknown;
}

function sourceIssue(address: string, issue: GitHubIssue): SourceIssue {
  return {
    id: `github:${address}#${issue.number}`,
    number: issue.number,
    url: issue.html_url,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    stateReason: issue.state_reason ?? null,
    labels: issue.labels.map(labelName).sort((left, right) => left.localeCompare(right)),
    updatedAt: issue.updated_at,
  };
}

interface GitHubComment {
  id: number;
  body: string | null;
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  body?: string | null;
  merge_commit_sha?: string | null;
  draft?: boolean;
  mergeable_state?: string;
  head?: { ref: string; sha: string };
  base?: { ref: string };
}

export interface GitHubCheckRun {
  app?: { slug?: string } | null;
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface GitHubDeliveryState {
  pullRequest: PullRequestReference & {
    merged: boolean;
    mergedAt: string | null;
    mergeCommitSha: string | null;
    draft: boolean;
    mergeState: string | null;
    headBranch: string;
    headSha: string;
    baseBranch: string;
    body?: string;
  };
  checks: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    url: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
}

interface GitHubHook {
  id: number;
  active: boolean;
  events?: string[];
  config: { url?: string };
}

const WEBHOOK_EVENTS = [
  "issues",
  "issue_comment",
  "pull_request",
  "workflow_run",
  "check_suite",
  "deployment_status",
  "sub_issues",
  "issue_dependencies",
];

export interface GitHubReviewThread {
  id: string;
  isResolved: boolean;
  comments: { nodes: Array<{
    id: string;
    databaseId: number;
    author: { login: string } | null;
    body: string;
    url: string;
    path: string | null;
    line: number | null;
    createdAt: string;
    pullRequestReview: { databaseId: number } | null;
  }> };
}

export interface GitHubReview {
  id: number;
  state: string;
  user: { login: string } | null;
  body: string | null;
  html_url: string;
  submitted_at?: string;
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { id databaseId author { login } body url path line createdAt pullRequestReview { databaseId } }
          }
        }
      }
    }
  }
}`;

const STATUS_MARKER = "<!-- conveyor:status -->";

function labelName(label: GitHubLabel | string): string {
  return typeof label === "string" ? label : label.name;
}

export class GitHubAdapter {
  constructor(
    private readonly transport: GitHubTransport,
    private readonly labelPrefix: string,
  ) {}

  async listConveyorIssues(address: string): Promise<SourceIssue[]> {
    return (await this.listIssues(address)).filter((issue) =>
      issue.labels.some((label) => this.isConveyorLabel(label)),
    );
  }

  async listIssues(address: string): Promise<SourceIssue[]> {
    const issues = await this.transport.request<GitHubIssue[]>({
      method: "GET",
      path: `repos/${address}/issues?state=all&per_page=100&sort=created&direction=asc`,
      paginate: true,
    });
    return issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => ({ issue, labels: issue.labels.map(labelName) }))
      .map(({ issue, labels }) => ({
        id: `github:${address}#${issue.number}`,
        number: issue.number,
        url: issue.html_url,
        title: issue.title,
        body: issue.body ?? "",
        state: issue.state,
        stateReason: issue.state_reason ?? null,
        labels: [...labels].sort((left, right) => left.localeCompare(right)),
        updatedAt: issue.updated_at,
      }));
  }

  async ensureLabels(
    address: string,
    labels: ReadonlyArray<{ name: string; color: string; description: string }>,
  ): Promise<void> {
    const existing = await this.transport.request<GitHubLabel[]>({
      method: "GET",
      path: `repos/${address}/labels?per_page=100`,
      paginate: true,
    });
    const names = new Set(existing.map((label) => label.name.toLocaleLowerCase()));
    for (const label of labels) {
      if (names.has(label.name.toLocaleLowerCase())) continue;
      await this.transport.request<GitHubLabel>({
        method: "POST",
        path: `repos/${address}/labels`,
        body: label,
      });
      names.add(label.name.toLocaleLowerCase());
    }
  }

  async ensureWebhook(input: {
    address: string;
    url: string;
    secret: string;
  }): Promise<void> {
    const hooks = await this.transport.request<GitHubHook[]>({
      method: "GET",
      path: `repos/${input.address}/hooks?per_page=100`,
      paginate: true,
    });
    const existing = hooks.find((hook) => hook.config.url === input.url);
    const missingEvents = existing ? WEBHOOK_EVENTS.filter((event) => !(existing.events ?? []).includes(event)) : [];
    if (existing?.active && missingEvents.length === 0) return;
    if (existing) {
      await this.transport.request<GitHubHook>({
        method: "PATCH",
        path: `repos/${input.address}/hooks/${existing.id}`,
        body: { active: true, events: [...new Set([...(existing.events ?? []), ...WEBHOOK_EVENTS])] },
      });
      return;
    }
    await this.transport.request<GitHubHook>({
      method: "POST",
      path: `repos/${input.address}/hooks`,
      body: {
        name: "web",
        active: true,
        events: WEBHOOK_EVENTS,
        config: {
          url: input.url,
          content_type: "json",
          insecure_ssl: "0",
          secret: input.secret,
        },
      },
    });
  }

  async getIssue(address: string, issueNumber: number): Promise<SourceIssue> {
    const issue = await this.transport.request<GitHubIssue>({
      method: "GET",
      path: `repos/${address}/issues/${issueNumber}`,
    });
    return sourceIssue(address, issue);
  }

  async createChildIssue(input: {
    address: string;
    parentNumber: number;
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<SourceIssue> {
    const parent = await this.transport.request<GitHubIssue>({
      method: "GET",
      path: `repos/${input.address}/issues/${input.parentNumber}`,
    });
    const child = await this.transport.request<GitHubIssue>({
      method: "POST",
      path: `repos/${input.address}/issues`,
      body: {
        title: input.title,
        body: input.body,
        labels: [...new Set(input.labels)],
        parent_issue_id: parent.id,
      },
    });
    return sourceIssue(input.address, child);
  }

  async setTitle(address: string, issueNumber: number, title: string): Promise<void> {
    await this.transport.request<unknown>({
      method: "PATCH",
      path: `repos/${address}/issues/${issueNumber}`,
      body: { title },
    });
  }

  async setParent(input: {
    address: string;
    childNumber: number;
    parentNumber: number;
  }): Promise<void> {
    const child = await this.transport.request<GitHubIssue>({
      method: "GET",
      path: `repos/${input.address}/issues/${input.childNumber}`,
    });
    await this.transport.request<unknown>({
      method: "POST",
      path: `repos/${input.address}/issues/${input.parentNumber}/sub_issues`,
      body: { sub_issue_id: child.id, replace_parent: true },
    });
  }

  async setDependencies(input: {
    address: string;
    issueNumber: number;
    blockerNumbers: readonly number[];
  }): Promise<void> {
    const base = `repos/${input.address}/issues/${input.issueNumber}/dependencies/blocked_by`;
    const current = await this.listBlockedBy(input.address, input.issueNumber);
    const wanted = new Set(input.blockerNumbers);
    const present = new Set(current.map((issue) => issue.number));
    for (const issue of current) {
      if (wanted.has(issue.number)) continue;
      await this.transport.request<unknown>({ method: "DELETE", path: `${base}/${issue.id}` });
    }
    for (const blockerNumber of wanted) {
      if (present.has(blockerNumber)) continue;
      const blocker = await this.transport.request<GitHubIssue>({
        method: "GET",
        path: `repos/${input.address}/issues/${blockerNumber}`,
      });
      try {
        await this.transport.request<unknown>({
          method: "POST",
          path: base,
          body: { issue_id: blocker.id },
        });
      } catch (error) {
        // A concurrent writer already created the link.
        if (error instanceof GitHubTransportError && /\(HTTP 422\)/.test(error.stderr)) continue;
        throw error;
      }
    }
  }

  async listSubIssues(address: string, issueNumber: number): Promise<SourceIssue[]> {
    const issues = await this.transport.request<GitHubIssue[]>({
      method: "GET",
      path: `repos/${address}/issues/${issueNumber}/sub_issues?per_page=100`,
      paginate: true,
    });
    return issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => sourceIssue(address, issue));
  }

  async listDependencies(address: string, issueNumber: number): Promise<SourceIssue[]> {
    const issues = await this.listBlockedBy(address, issueNumber);
    return issues.map((issue) => sourceIssue(address, issue));
  }

  private async listBlockedBy(address: string, issueNumber: number): Promise<GitHubIssue[]> {
    const issues = await this.transport.request<GitHubIssue[]>({
      method: "GET",
      path: `repos/${address}/issues/${issueNumber}/dependencies/blocked_by?per_page=100`,
      paginate: true,
    });
    return issues.filter((issue) => issue.pull_request === undefined);
  }

  async replaceConveyorLabels(
    address: string,
    issueNumber: number,
    conveyorLabels: readonly string[],
  ): Promise<void> {
    const issue = await this.transport.request<Pick<GitHubIssue, "labels">>({
      method: "GET",
      path: `repos/${address}/issues/${issueNumber}`,
    });
    const projectLabels = issue.labels
      .map(labelName)
      .filter((label) => !this.isConveyorLabel(label));
    const labels = [...new Set([...projectLabels, ...conveyorLabels])].sort((left, right) =>
      left.localeCompare(right),
    );
    await this.transport.request<unknown>({
      method: "PUT",
      path: `repos/${address}/issues/${issueNumber}/labels`,
      body: { labels },
    });
  }

  async replaceManagedProjectLabels(
    address: string,
    issueNumber: number,
    managedProjectLabels: readonly string[],
    selectedLabels: readonly string[],
  ): Promise<void> {
    const issue = await this.transport.request<Pick<GitHubIssue, "labels">>({
      method: "GET",
      path: `repos/${address}/issues/${issueNumber}`,
    });
    const managed = new Set(managedProjectLabels);
    const preserved = issue.labels
      .map(labelName)
      .filter((label) => !managed.has(label));
    const labels = [...new Set([...preserved, ...selectedLabels])].sort((left, right) =>
      left.localeCompare(right),
    );
    await this.transport.request<unknown>({
      method: "PUT",
      path: `repos/${address}/issues/${issueNumber}/labels`,
      body: { labels },
    });
  }

  async upsertStatusComment(
    address: string,
    issueNumber: number,
    markdown: string,
  ): Promise<number> {
    const comments = await this.transport.request<GitHubComment[]>({
      method: "GET",
      path: `repos/${address}/issues/${issueNumber}/comments?per_page=100`,
      paginate: true,
    });
    const body = `${STATUS_MARKER}\n${markdown.trim()}`;
    const existing = comments.find((comment) => comment.body?.includes(STATUS_MARKER));
    const comment = existing
      ? await this.transport.request<GitHubComment>({
          method: "PATCH",
          path: `repos/${address}/issues/comments/${existing.id}`,
          body: { body },
        })
      : await this.transport.request<GitHubComment>({
          method: "POST",
          path: `repos/${address}/issues/${issueNumber}/comments`,
          body: { body },
        });
    return comment.id;
  }

  async addComment(
    address: string,
    issueNumber: number,
    markdown: string,
  ): Promise<number> {
    const comment = await this.transport.request<GitHubComment>({
      method: "POST",
      path: `repos/${address}/issues/${issueNumber}/comments`,
      body: { body: markdown },
    });
    return comment.id;
  }

  /** Creates an issue/pull request comment and returns where it lives. */
  async createComment(address: string, issueNumber: number, markdown: string): Promise<{ id: number; url: string }> {
    const comment = await this.transport.request<GitHubComment & { html_url: string }>({
      method: "POST",
      path: `repos/${address}/issues/${issueNumber}/comments`,
      body: { body: markdown },
    });
    return { id: comment.id, url: comment.html_url };
  }

  async updateComment(address: string, commentId: number, markdown: string): Promise<void> {
    await this.transport.request<unknown>({ method: "PATCH", path: `repos/${address}/issues/comments/${commentId}`, body: { body: markdown } });
  }

  /** An inline review comment on the pull request diff (right side) at `commitId`. */
  async createReviewComment(address: string, pullRequestNumber: number, input: {
    body: string; commitId: string; path: string; line: number;
  }): Promise<{ id: number; url: string }> {
    const comment = await this.transport.request<{ id: number; html_url: string }>({
      method: "POST",
      path: `repos/${address}/pulls/${pullRequestNumber}/comments`,
      body: { body: input.body, commit_id: input.commitId, path: input.path, line: input.line, side: "RIGHT" },
    });
    return { id: comment.id, url: comment.html_url };
  }

  /** Deletes a branch ref; false when it does not exist. */
  async deleteBranchRef(address: string, branch: string): Promise<boolean> {
    try {
      await this.transport.request<unknown>({ method: "DELETE", path: `repos/${address}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}` });
      return true;
    } catch (error) {
      // GitHub answers 422 "Reference does not exist" (or 404) for a branch that is already gone.
      if (error instanceof GitHubTransportError && /HTTP 404|HTTP 422/.test(error.stderr)) return false;
      throw error;
    }
  }

  /** Whether an open pull request has this branch of the repository as its head. */
  async hasOpenPullRequestFor(address: string, branch: string): Promise<boolean> {
    const [owner] = address.split("/");
    const open = await this.transport.request<unknown[]>({
      method: "GET",
      path: `repos/${address}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    });
    return open.length > 0;
  }

  async replyToReviewComment(address: string, pullRequestNumber: number, commentId: number, markdown: string): Promise<void> {
    await this.transport.request<unknown>({
      method: "POST",
      path: `repos/${address}/pulls/${pullRequestNumber}/comments/${commentId}/replies`,
      body: { body: markdown },
    });
  }

  /** A reaction on an inline review comment (REST id). */
  async reactToReviewComment(address: string, commentId: number, content: "+1" | "-1"): Promise<void> {
    await this.transport.request<unknown>({ method: "POST", path: `repos/${address}/pulls/comments/${commentId}/reactions`, body: { content } });
  }

  /** A reaction on a pull request (issue) comment (REST id). */
  async reactToIssueComment(address: string, commentId: number, content: "+1" | "-1"): Promise<void> {
    await this.transport.request<unknown>({ method: "POST", path: `repos/${address}/issues/comments/${commentId}/reactions`, body: { content } });
  }

  /** Replies in a review thread (GraphQL node id). */
  async replyToReviewThread(threadId: string, markdown: string): Promise<void> {
    await this.#graphql(
      `mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id } } }`,
      { thread: threadId, body: markdown },
    );
  }

  /** Marks a review thread resolved (GraphQL node id). */
  async resolveReviewThread(threadId: string): Promise<void> {
    await this.#graphql(`mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { isResolved } } }`, { thread: threadId });
  }

  /** Adds a reaction to the first comment of a review thread. */
  async reactToReviewThread(threadId: string, content: "+1" | "-1"): Promise<void> {
    const found = await this.#graphql<{ node?: { comments?: { nodes?: Array<{ id: string }> } } | null }>(
      `query($thread: ID!) { node(id: $thread) { ... on PullRequestReviewThread { comments(first: 1) { nodes { id } } } } }`,
      { thread: threadId },
    );
    const subject = found.node?.comments?.nodes?.[0]?.id;
    if (!subject) throw new Error(`review thread ${threadId} has no comment to react to`);
    await this.#graphql(
      `mutation($subject: ID!, $content: ReactionContent!) { addReaction(input: {subjectId: $subject, content: $content}) { reaction { content } } }`,
      { subject, content: content === "+1" ? "THUMBS_UP" : "THUMBS_DOWN" },
    );
  }

  async #graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.transport.request<{ data?: T; errors?: Array<{ message?: string }> }>({
      method: "POST", path: "graphql", body: { query, variables },
    });
    if (response.errors?.length) {
      throw new Error(`GitHub GraphQL failed: ${response.errors.map((error) => error.message ?? "error").join("; ")}`);
    }
    return response.data as T;
  }

  /** All of the pull request's review threads with their first comment, through paginated GraphQL; throws unless every page was read. */
  async listReviewThreads(address: string, pullRequestNumber: number): Promise<GitHubReviewThread[]> {
    const [owner, name] = address.split("/");
    const threads: GitHubReviewThread[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const response: {
        data?: { repository?: { pullRequest?: { reviewThreads?: {
          nodes?: GitHubReviewThread[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        } } | null } | null };
        errors?: Array<{ message?: string }>;
      } = await this.transport.request({
        method: "POST",
        path: "graphql",
        body: { query: REVIEW_THREADS_QUERY, variables: { owner, name, number: pullRequestNumber, cursor } },
      });
      if (response.errors?.length) {
        throw new Error(`GitHub GraphQL failed: ${response.errors.map((error) => error.message ?? "error").join("; ")}`);
      }
      const connection = response.data?.repository?.pullRequest?.reviewThreads;
      if (!connection?.nodes) throw new Error(`GitHub GraphQL returned no review threads for ${address}#${pullRequestNumber}`);
      threads.push(...connection.nodes);
      if (!connection.pageInfo?.hasNextPage) return threads;
      if (!connection.pageInfo.endCursor) throw new Error(`GitHub GraphQL review threads of ${address}#${pullRequestNumber} cannot be paginated`);
      cursor = connection.pageInfo.endCursor;
    }
    throw new Error(`GitHub pull request ${address}#${pullRequestNumber} has too many review threads to import`);
  }

  async listReviews(address: string, pullRequestNumber: number): Promise<GitHubReview[]> {
    return this.transport.request<GitHubReview[]>({
      method: "GET",
      path: `repos/${address}/pulls/${pullRequestNumber}/reviews?per_page=100`,
      paginate: true,
    });
  }

  async updateManagedSection(input: {
    address: string;
    issueNumber: number;
    section: ManagedSectionName;
    markdown: string;
    expectedRevision: string;
  }): Promise<SourceIssue> {
    const current = await this.transport.request<GitHubIssue>({
      method: "GET",
      path: `repos/${input.address}/issues/${input.issueNumber}`,
    });
    const body = current.body ?? "";
    const updatedBody = upsertManagedSection(
      body,
      input.section,
      input.markdown,
      input.expectedRevision,
    );
    const updated = await this.transport.request<GitHubIssue>({
      method: "PATCH",
      path: `repos/${input.address}/issues/${input.issueNumber}`,
      body: { body: updatedBody },
    });
    const labels = updated.labels.map(labelName).sort((left, right) => left.localeCompare(right));
    return {
      id: `github:${input.address}#${updated.number}`,
      number: updated.number,
      url: updated.html_url,
      title: updated.title,
      body: updated.body ?? "",
      state: updated.state,
      labels,
      updatedAt: updated.updated_at,
    };
  }

  managedRevision(body: string): string {
    return parseManagedSections(body).revision;
  }

  async ensurePullRequest(input: {
    address: string;
    issueNumber: number;
    branch: string;
    baseBranch: string;
    title: string;
    closingReference: boolean;
  }): Promise<PullRequestReference> {
    const [owner] = input.address.split("/");
    const head = `${owner}:${input.branch}`;
    const existing = await this.transport.request<GitHubPullRequest[]>({
      method: "GET",
      path: `repos/${input.address}/pulls?state=all&head=${encodeURIComponent(head)}&base=${encodeURIComponent(input.baseBranch)}`,
    });
    const pullRequest =
      existing[0] ??
      (await this.transport.request<GitHubPullRequest>({
        method: "POST",
        path: `repos/${input.address}/pulls`,
        body: {
          title: input.title,
          head: input.branch,
          base: input.baseBranch,
          body: input.closingReference
            ? `Closes #${input.issueNumber}`
            : `Related to #${input.issueNumber}`,
        },
      }));
    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      state: pullRequest.state,
    };
  }

  async getPullRequestDelivery(
    address: string,
    pullRequestNumber: number,
  ): Promise<GitHubDeliveryState> {
    const pullRequest = await this.transport.request<GitHubPullRequest>({
      method: "GET",
      path: `repos/${address}/pulls/${pullRequestNumber}`,
    });
    if (!pullRequest.head?.sha || !pullRequest.head.ref || !pullRequest.base?.ref) {
      throw new Error(`GitHub pull request #${pullRequestNumber} is missing branch metadata`);
    }
    const response = await this.transport.request<{ check_runs: GitHubCheckRun[] }>({
      method: "GET",
      path: `repos/${address}/commits/${pullRequest.head.sha}/check-runs?per_page=100`,
    });
    return {
      pullRequest: {
        number: pullRequest.number,
        url: pullRequest.html_url,
        state: pullRequest.merged === true ? "merged" : pullRequest.state,
        merged: pullRequest.merged === true,
        mergedAt: pullRequest.merged_at ?? null,
        mergeCommitSha: pullRequest.merge_commit_sha ?? null,
        draft: pullRequest.draft === true,
        mergeState: pullRequest.mergeable_state ?? null,
        headBranch: pullRequest.head.ref,
        headSha: pullRequest.head.sha,
        baseBranch: pullRequest.base.ref,
        body: pullRequest.body ?? "",
      },
      checks: response.check_runs.map((check) => ({
        id: check.id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        url: check.details_url,
        startedAt: check.started_at,
        completedAt: check.completed_at,
      })),
    };
  }

  async getPullRequestChange(address: string, pullRequestNumber: number): Promise<{
    number: number;
    url: string;
    state: string;
    draft: boolean;
    mergeState: string | null;
    headSha: string;
    mergedAt: string | null;
    body?: string;
  }> {
    const pullRequest = await this.transport.request<GitHubPullRequest>({
      method: "GET",
      path: `repos/${address}/pulls/${pullRequestNumber}`,
    });
    if (!pullRequest.head?.sha) {
      throw new Error(`GitHub pull request #${pullRequestNumber} has no head commit`);
    }
    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      state: pullRequest.merged === true ? "merged" : pullRequest.state,
      draft: pullRequest.draft === true,
      mergeState: pullRequest.mergeable_state ?? null,
      headSha: pullRequest.head.sha,
      mergedAt: pullRequest.merged_at ?? null,
      body: pullRequest.body ?? "",
    };
  }

  /** Upserts the acceptance-criteria managed section in a pull request body, keeping the rest. */
  async setPullRequestChecklist(address: string, pullRequestNumber: number, markdown: string): Promise<void> {
    const path = `repos/${address}/pulls/${pullRequestNumber}`;
    const current = await this.transport.request<GitHubPullRequest>({ method: "GET", path });
    const body = current.body ?? "";
    const updated = upsertManagedSection(body, "acceptance-criteria", markdown, parseManagedSections(body).revision);
    if (updated !== body) await this.transport.request<GitHubPullRequest>({ method: "PATCH", path, body: { body: updated } });
  }

  async getPullRequestHead(
    address: string,
    pullRequestNumber: number,
  ): Promise<{ sha: string }> {
    const pullRequest = await this.transport.request<GitHubPullRequest>({
      method: "GET",
      path: `repos/${address}/pulls/${pullRequestNumber}`,
    });
    if (!pullRequest.head?.sha) {
      throw new Error(`GitHub pull request #${pullRequestNumber} has no head commit`);
    }
    return { sha: pullRequest.head.sha };
  }

  async listCheckRuns(address: string, sha: string): Promise<GitHubCheckRun[]> {
    const pages = await this.transport.request<Array<{ check_runs?: GitHubCheckRun[] }> | { check_runs?: GitHubCheckRun[] }>({
      method: "GET",
      path: `repos/${address}/commits/${sha}/check-runs?per_page=100`,
      paginate: true,
    });
    const runs = (Array.isArray(pages) ? pages : [pages]).flatMap((page) => page?.check_runs ?? []);
    return runs;
  }

  async workflowExists(address: string, workflow: string, ref: string): Promise<boolean> {
    try {
      await this.transport.request<unknown>({
        method: "GET",
        path: `repos/${address}/contents/.github/workflows/${encodeURIComponent(workflow)}?ref=${encodeURIComponent(ref)}`,
      });
      return true;
    } catch (error) {
      if (error instanceof GitHubTransportError && /\b404\b|Not Found/i.test(error.message)) return false;
      throw error;
    }
  }

  /** File names in `.github/workflows` at a ref; null when the directory does not exist. */
  async listWorkflowFiles(address: string, ref: string): Promise<string[] | null> {
    try {
      const entries = await this.transport.request<Array<{ name: string; type?: string }>>({
        method: "GET",
        path: `repos/${address}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`,
      });
      return (Array.isArray(entries) ? entries : []).filter((entry) => entry.type !== "dir").map((entry) => entry.name);
    } catch (error) {
      if (error instanceof GitHubTransportError && /\b404\b|Not Found/i.test(error.message)) return null;
      throw error;
    }
  }

  async workflowSource(address: string, workflow: string, ref: string): Promise<string> {
    const file = await this.transport.request<{ content?: string; encoding?: string }>({
      method: "GET",
      path: `repos/${address}/contents/.github/workflows/${encodeURIComponent(workflow)}?ref=${encodeURIComponent(ref)}`,
    });
    if (file.encoding !== "base64" || typeof file.content !== "string") throw new Error(`workflow ${workflow} has no readable content`);
    return Buffer.from(file.content, "base64").toString("utf8");
  }

  /** Remove (if present) and re-add a PR label so a `labeled` workflow runs for the current head. */
  async retriggerLabel(address: string, pullRequestNumber: number, label: string): Promise<void> {
    try {
      await this.transport.request<unknown>({
        method: "DELETE",
        path: `repos/${address}/issues/${pullRequestNumber}/labels/${encodeURIComponent(label)}`,
      });
    } catch (error) {
      if (!(error instanceof GitHubTransportError && /\b404\b|Not Found|does not exist/i.test(error.message))) throw error;
    }
    await this.transport.request<unknown>({
      method: "POST",
      path: `repos/${address}/issues/${pullRequestNumber}/labels`,
      body: { labels: [label] },
    });
  }

  async rerunJob(address: string, jobId: number): Promise<void> {
    await this.transport.request<unknown>({
      method: "POST",
      path: `repos/${address}/actions/jobs/${jobId}/rerun`,
    });
  }

  async jobLog(address: string, jobId: number): Promise<string> {
    const text = await this.transport.request<string>({
      method: "GET",
      path: `repos/${address}/actions/jobs/${jobId}/logs`,
      raw: true,
    });
    return String(text ?? "");
  }

  async squashMerge(
    address: string,
    pullRequestNumber: number,
    expectedHeadSha?: string,
  ): Promise<{ merged: boolean; sha?: string }> {
    const current = await this.transport.request<GitHubPullRequest>({
      method: "GET",
      path: `repos/${address}/pulls/${pullRequestNumber}`,
    });
    if (current.merged === true) {
      return {
        merged: true,
        ...(current.merge_commit_sha ? { sha: current.merge_commit_sha } : {}),
      };
    }
    return this.transport.request<{ merged: boolean; sha?: string }>({
      method: "PUT",
      path: `repos/${address}/pulls/${pullRequestNumber}/merge`,
      body: expectedHeadSha ? { merge_method: "squash", sha: expectedHeadSha } : { merge_method: "squash" },
    });
  }

  private isConveyorLabel(label: string): boolean {
    return label === this.labelPrefix || label.startsWith(`${this.labelPrefix}:`);
  }
}

export function verifyGitHubSignature(
  body: Uint8Array,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=") || secret.length === 0) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(body).digest("hex"),
    "hex",
  );
  let received: Buffer;
  try {
    received = Buffer.from(signature.slice("sha256=".length), "hex");
  } catch {
    return false;
  }
  return expected.length === received.length && timingSafeEqual(expected, received);
}
