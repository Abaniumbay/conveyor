// An in-memory GitHub REST/GraphQL API behind the `GitHubTransport` seam: the real adapter, code
// host and CI provider run against it, so a test or benchmark counts exactly the requests
// production would send. A request it does not model is recorded and fails loudly.

import { GitHubTransportError, type GitHubTransport, type GitHubTransportRequest } from "../../src/source/github/adapter";

export interface SimulatedIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  updatedAt: string;
  blockedBy: number[];
  subIssues: number[];
  comments: Array<{ id: number; body: string }>;
}

export interface SimulatedCheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface SimulatedPullRequest {
  number: number;
  headSha: string;
  headRef: string;
  baseRef: string;
  state: "open" | "closed";
  merged: boolean;
  mergeableState: string;
  body: string;
}

export interface SimulatedRepository {
  address: string;
  issues: Map<number, SimulatedIssue>;
  pulls: Map<number, SimulatedPullRequest>;
  checkRuns: Map<string, SimulatedCheckRun[]>;
  labels: Set<string>;
  hooks: Array<{ id: number; active: boolean; events: string[]; config: { url: string }; last_response: { code: number | null; status: string } }>;
  /** Delivery attempts per hook, newest first, as GitHub lists them. */
  hookDeliveries: Map<number, Array<{ id: string; guid: string; delivered_at: string; status_code: number; redelivery: boolean }>>;
  /** Delivery attempts the simulator was asked to send again. */
  redeliveries: string[];
  /** Ping requests for the repository's webhooks. */
  pings: number;
  /** Pull request conversations, which GitHub serves through the issues API. */
  pullConversations: Map<number, SimulatedIssue>;
}

const notFound = (request: GitHubTransportRequest) =>
  new GitHubTransportError(`GitHub API ${request.method} ${request.path} failed: Not Found (HTTP 404)`, 1, "gh: Not Found (HTTP 404)");

/** A fake GitHub holding repositories, issues, pull requests and check runs. */
export class GitHubSimulator implements GitHubTransport {
  readonly repositories = new Map<string, SimulatedRepository>();
  readonly requests: GitHubTransportRequest[] = [];
  /** Requests the simulator does not model; a run with any is not a valid measurement. */
  readonly unhandled: string[] = [];
  #nextId = 1_000;

  constructor(private readonly now: () => Date = () => new Date()) {}

  repository(address: string): SimulatedRepository {
    let repository = this.repositories.get(address.toLowerCase());
    if (!repository) {
      repository = { address, issues: new Map(), pulls: new Map(), checkRuns: new Map(), labels: new Set(), hooks: [], pullConversations: new Map(), hookDeliveries: new Map(), redeliveries: [], pings: 0 };
      this.repositories.set(address.toLowerCase(), repository);
    }
    return repository;
  }

  addIssue(address: string, issue: Partial<SimulatedIssue> & { number: number }): SimulatedIssue {
    const created: SimulatedIssue = {
      title: `Issue ${issue.number}`, body: "", state: "open", labels: [], updatedAt: this.now().toISOString(),
      blockedBy: [], subIssues: [], comments: [], ...issue,
    };
    this.repository(address).issues.set(issue.number, created);
    return created;
  }

  addPullRequest(address: string, pull: Partial<SimulatedPullRequest> & { number: number; headSha: string }): SimulatedPullRequest {
    const created: SimulatedPullRequest = {
      headRef: `conveyor/${pull.number}`, baseRef: "main", state: "open", merged: false, mergeableState: "clean", body: "", ...pull,
    };
    this.repository(address).pulls.set(pull.number, created);
    return created;
  }

  setCheckRuns(address: string, sha: string, runs: Array<Partial<SimulatedCheckRun> & { name: string }>): void {
    this.repository(address).checkRuns.set(sha, runs.map((run) => ({
      id: this.#nextId++, status: "queued", conclusion: null, startedAt: null, completedAt: null, ...run,
    })));
  }

  /** Changes an issue the way a person would, moving its `updated_at`. */
  updateIssue(address: string, number: number, change: Partial<SimulatedIssue>): void {
    const issue = this.repository(address).issues.get(number);
    if (!issue) throw new Error(`no simulated issue ${address}#${number}`);
    Object.assign(issue, change, { updatedAt: this.now().toISOString() });
  }

  async request<T>(request: GitHubTransportRequest): Promise<T> {
    this.requests.push(request);
    const result = this.#route(request);
    if (result === UNHANDLED) {
      this.unhandled.push(`${request.method} ${request.path}`);
      throw new Error(`GitHub simulator does not model ${request.method} ${request.path}`);
    }
    if (result instanceof GitHubTransportError) throw result;
    return structuredClone(result) as T;
  }

  #issueJson(address: string, issue: SimulatedIssue) {
    return {
      id: issue.number * 10, number: issue.number, html_url: `https://github.com/${address}/issues/${issue.number}`,
      title: issue.title, body: issue.body, state: issue.state, state_reason: issue.state === "closed" ? "completed" : null,
      labels: issue.labels.map((name) => ({ name })), updated_at: issue.updatedAt,
    };
  }

  #pullJson(address: string, pull: SimulatedPullRequest) {
    return {
      number: pull.number, html_url: `https://github.com/${address}/pull/${pull.number}`, state: pull.state, merged: pull.merged,
      merged_at: pull.merged ? this.now().toISOString() : null, merge_commit_sha: pull.merged ? "f".repeat(40) : null, draft: false,
      mergeable_state: pull.mergeableState, body: pull.body, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef },
    };
  }

  #route(request: GitHubTransportRequest): unknown {
    const [pathname = "", query = ""] = request.path.split("?");
    const params = new URLSearchParams(query);
    const { method } = request;
    if (pathname === "rate_limit") {
      const reset = Math.floor(this.now().getTime() / 1_000) + 3_600;
      return { resources: { core: { limit: 5000, remaining: 5000, reset }, graphql: { limit: 5000, remaining: 5000, reset } } };
    }
    if (pathname === "user") return { login: "conveyor-bot" };
    if (pathname === "graphql") {
      const body = request.body as { query?: string } | undefined;
      if (body?.query?.includes("userContentEdits")) {
        return { data: { repository: { issue: { userContentEdits: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
      }
      if (body?.query?.includes("reviewThreads")) {
        return { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
      }
      return UNHANDLED;
    }
    if (/^orgs\/[^/]+\/issue-(types|fields)$/.test(pathname)) return notFound(request);
    const repoMatch = /^repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(pathname);
    if (!repoMatch) return UNHANDLED;
    const repository = this.repositories.get(repoMatch[1]!.toLowerCase());
    if (!repository) return notFound(request);
    const address = repository.address;
    const rest = repoMatch[2] ?? "";
    const issueOf = (value: string) => repository.issues.get(Number(value));
    let match: RegExpExecArray | null;

    if (rest === "" && method === "GET") return { visibility: "private", private: true, permissions: { admin: true, push: true } };
    if (rest === "issues" && method === "GET") {
      const since = params.get("since");
      return [...repository.issues.values()]
        .filter((issue) => since === null || issue.updatedAt >= since)
        .sort((left, right) => left.number - right.number)
        .map((issue) => this.#issueJson(address, issue));
    }
    if ((match = /^issues\/(\d+)$/.exec(rest))) {
      const issue = issueOf(match[1]!);
      if (!issue) return notFound(request);
      if (method === "GET") return this.#issueJson(address, issue);
      if (method === "PATCH") {
        Object.assign(issue, request.body as object, { updatedAt: this.now().toISOString() });
        return this.#issueJson(address, issue);
      }
    }
    if ((match = /^issues\/(\d+)\/events$/.exec(rest)) && method === "GET") {
      const issue = issueOf(match[1]!);
      if (!issue) return notFound(request);
      return issue.labels.map((name, index) => ({
        id: index + 1, event: "labeled", label: { name }, actor: { login: "maintainer" }, created_at: "2026-01-01T00:00:00Z",
      }));
    }
    if ((match = /^issues\/(\d+)\/sub_issues$/.exec(rest)) && method === "GET") {
      const issue = issueOf(match[1]!);
      return (issue?.subIssues ?? []).flatMap((number) => {
        const child = repository.issues.get(number);
        return child ? [this.#issueJson(address, child)] : [];
      });
    }
    if ((match = /^issues\/(\d+)\/dependencies\/blocked_by$/.exec(rest)) && method === "GET") {
      const issue = issueOf(match[1]!);
      return (issue?.blockedBy ?? []).flatMap((number) => {
        const blocker = repository.issues.get(number);
        return blocker ? [this.#issueJson(address, blocker)] : [];
      });
    }
    if ((match = /^issues\/(\d+)\/labels$/.exec(rest))) {
      const issue = issueOf(match[1]!);
      if (!issue) return notFound(request);
      const labels = (request.body as { labels?: string[] } | undefined)?.labels ?? [];
      if (method === "PUT") issue.labels = [...labels];
      else if (method === "POST") issue.labels = [...new Set([...issue.labels, ...labels])];
      else return UNHANDLED;
      issue.updatedAt = this.now().toISOString();
      return issue.labels.map((name) => ({ name }));
    }
    if ((match = /^issues\/(\d+)\/labels\/(.+)$/.exec(rest)) && method === "DELETE") {
      const issue = issueOf(match[1]!);
      if (!issue) return notFound(request);
      issue.labels = issue.labels.filter((label) => label !== decodeURIComponent(match![2]!));
      issue.updatedAt = this.now().toISOString();
      return null;
    }
    if ((match = /^issues\/(\d+)\/comments$/.exec(rest))) {
      const number = Number(match[1]!);
      const issue = issueOf(match[1]!) ?? (repository.pulls.has(number) ? this.#pullIssue(repository, number) : undefined);
      if (!issue) return notFound(request);
      if (method === "GET") return issue.comments.map((comment) => ({ id: comment.id, body: comment.body }));
      if (method === "POST") {
        const comment = { id: this.#nextId++, body: String((request.body as { body?: unknown }).body ?? "") };
        issue.comments.push(comment);
        return { id: comment.id, body: comment.body, html_url: `https://github.com/${address}/issues/${issue.number}#issuecomment-${comment.id}` };
      }
    }
    if ((match = /^issues\/comments\/(\d+)$/.exec(rest)) && method === "PATCH") {
      const id = Number(match[1]!);
      for (const issue of [...repository.issues.values(), ...repository.pullConversations.values()]) {
        const comment = issue.comments.find((entry) => entry.id === id);
        if (comment) {
          comment.body = String((request.body as { body?: unknown }).body ?? "");
          return { id, body: comment.body };
        }
      }
      return notFound(request);
    }
    if ((match = /^collaborators\/[^/]+\/permission$/.exec(rest)) && method === "GET") return { permission: "write" };
    if (rest === "labels") {
      if (method === "GET") return [...repository.labels].map((name) => ({ name }));
      if (method === "POST") {
        const name = String((request.body as { name?: unknown }).name);
        repository.labels.add(name);
        return { name };
      }
    }
    if (rest === "hooks") {
      if (method === "GET") return repository.hooks;
      if (method === "POST") {
        const body = request.body as { events: string[]; config: { url: string } };
        const hook = { id: this.#nextId++, active: true, events: body.events, config: { url: body.config.url }, last_response: { code: null, status: "unused" } };
        repository.hooks.push(hook);
        return hook;
      }
    }
    if ((match = /^hooks\/(\d+)\/deliveries$/.exec(rest)) && method === "GET") {
      // As GitHub sends it: ids are bare numbers in the text, however large.
      const deliveries = repository.hookDeliveries.get(Number(match[1]!)) ?? [];
      return JSON.stringify(deliveries).replace(/"id":"(\d+)"/g, '"id":$1');
    }
    if ((match = /^hooks\/(\d+)\/pings$/.exec(rest)) && method === "POST") {
      repository.pings += 1;
      return null;
    }
    if ((match = /^hooks\/(\d+)\/deliveries\/(\d+)\/attempts$/.exec(rest)) && method === "POST") {
      repository.redeliveries.push(match[2]!);
      return null;
    }
    if ((match = /^pulls\/(\d+)$/.exec(rest))) {
      const pull = repository.pulls.get(Number(match[1]!));
      if (!pull) return notFound(request);
      if (method === "GET") return this.#pullJson(address, pull);
      if (method === "PATCH") {
        Object.assign(pull, request.body as object);
        return this.#pullJson(address, pull);
      }
    }
    if ((match = /^pulls\/(\d+)\/(reviews|comments)$/.exec(rest)) && method === "GET") {
      return repository.pulls.has(Number(match[1]!)) ? [] : notFound(request);
    }
    if (rest === "pulls" && method === "GET") {
      const head = params.get("head");
      return [...repository.pulls.values()]
        .filter((pull) => (params.get("state") === "all" || pull.state === "open") && (head === null || head.endsWith(`:${pull.headRef}`)))
        .map((pull) => this.#pullJson(address, pull));
    }
    if ((match = /^commits\/([0-9a-z]+)\/check-runs$/.exec(rest)) && method === "GET") {
      const runs = repository.checkRuns.get(match[1]!) ?? [];
      const page = {
        total_count: runs.length,
        check_runs: runs.map((run) => ({
          id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, app: { slug: "github-actions" },
          details_url: `https://github.com/${address}/actions/runs/${run.id}`, started_at: run.startedAt, completed_at: run.completedAt,
        })),
      };
      return request.paginate ? [page] : page;
    }
    if (/^contents\//.test(rest) && method === "GET") return notFound(request);
    return UNHANDLED;
  }

  /** A pull request's conversation, which GitHub serves through the issues API. */
  #pullIssue(repository: SimulatedRepository, number: number): SimulatedIssue {
    let issue = repository.pullConversations.get(number);
    if (!issue) {
      issue = { number, title: `Pull request ${number}`, body: "", state: "open", labels: [], updatedAt: this.now().toISOString(), blockedBy: [], subIssues: [], comments: [] };
      repository.pullConversations.set(number, issue);
    }
    return issue;
  }
}

const UNHANDLED = Symbol("unhandled");
