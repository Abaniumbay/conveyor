// Conveyor's copy of GitHub. Every read is answered from it while its entry is within the lifetime
// for its kind of data; only a missing or expired entry goes to GitHub. Webhook deliveries and
// Conveyor's own writes keep it current: full issue objects replace the held issue and listing
// entries, while label writes patch only listing labels. Deliveries do the same when they are not
// older; anything else they change is dropped, to be read again when next needed. GitHub stays the
// source of truth; the copy only saves requests. It lives in the database, so a restart reads
// nothing it already holds.

import type { GitHubTransport, GitHubTransportRequest } from "./adapter";

/** One stored item: its kind, the format version it was written in, the data and when it was read or updated. */
export interface GitHubMirrorEntry { kind: string; version: number; value: unknown; at: number }

/** Where the copy is kept: the database in the service, memory until one is attached. */
export interface GitHubMirrorStorage {
  get(key: string): GitHubMirrorEntry | null;
  set(key: string, entry: GitHubMirrorEntry): void;
  delete(key: string): void;
  /** Every key that starts with `prefix`. */
  keys(prefix: string): string[];
}

/**
 * The format of stored items. Raise it when what is stored changes (a GitHub API version, a new
 * shape): rows of another version are read again instead of being trusted.
 */
export const GITHUB_MIRROR_VERSION = 1;

/** How long each kind of data is used before it is read again, in ms (`settings.githubCache`). */
export interface GitHubCacheLifetimes {
  issue: number;
  change: number;
  permission: number;
  /** A commit's check runs while one still runs; a lost "finished" delivery holds a wait no longer than this. */
  runningChecks: number;
  /** A commit whose check runs all finished: a re-run arrives as a new run by delivery. */
  finishedChecks: number;
  other: number;
}

const HOUR = 60 * 60_000;

export const DEFAULT_GITHUB_CACHE_LIFETIMES: GitHubCacheLifetimes = {
  issue: HOUR, change: HOUR, permission: HOUR, runningChecks: 15 * 60_000, finishedChecks: Number.POSITIVE_INFINITY, other: HOUR,
};

type Kind = "issue" | "change" | "permission" | "checks" | "log" | "other";

/** Reads that are never copied: they report on GitHub itself or on its deliveries, not on repository data. */
const UNCACHED = [/^rate_limit/, /^repos\/[^/]+\/[^/]+\/hooks(?:\/|\?|$)/];

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/** `repos/<owner>/<repo>` in lower case, and the rest of the path as it is. */
function split(requestPath: string): { repository: string; rest: string } | null {
  const match = /^repos\/([^/]+)\/([^/?]+)(.*)$/.exec(requestPath);
  return match ? { repository: `repos/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`, rest: match[3]! } : null;
}

function normalize(requestPath: string): string {
  const parts = split(requestPath);
  return parts ? parts.repository + parts.rest : requestPath;
}

/** The path of a key, without its query and request flags. */
const resource = (key: string) => key.split(" ")[0]!.replace(/[?#].*$/, "");

/** What kind of data a key holds. */
function kindOf(key: string): Kind {
  if (key.startsWith("graphql ")) return "change";
  const path = resource(key);
  if (/\/commits\/[^/]+\/check-runs$/.test(path)) return "checks";
  if (/\/actions\/jobs\/\d+\/logs$/.test(path)) return "log";
  if (/\/collaborators\/[^/]+\/permission$/.test(path)) return "permission";
  if (/\/pulls(\/|$)/.test(path)) return "change";
  if (/\/issues(\/|$)/.test(path)) return "issue";
  return "other";
}

/** Whether a commit's held check runs have all finished (the latest run of each check counts). */
function checksFinished(value: unknown): boolean {
  const runs = (Array.isArray(value) ? value : [value]).flatMap((page) => (isObject(page) && Array.isArray(page.check_runs) ? page.check_runs : []));
  const latest = new Map<string, Json>();
  for (const run of runs) {
    if (!isObject(run)) continue;
    const known = latest.get(String(run.name));
    if (!known || Number(known.id) < Number(run.id)) latest.set(String(run.name), run);
  }
  return latest.size > 0 && [...latest.values()].every((run) => run.status === "completed");
}

/** How long an entry is used. A finished job's log never changes. */
function lifetimeOf(entry: GitHubMirrorEntry, lifetimes: GitHubCacheLifetimes): number {
  switch (entry.kind as Kind) {
    case "issue": return lifetimes.issue;
    case "change": return lifetimes.change;
    case "permission": return lifetimes.permission;
    case "checks": return checksFinished(entry.value) ? lifetimes.finishedChecks : lifetimes.runningChecks;
    case "log": return Number.POSITIVE_INFINITY;
    default: return lifetimes.other;
  }
}

/** A plain in-memory store, for a cache with no database attached. */
function memoryStorage(): GitHubMirrorStorage {
  const entries = new Map<string, GitHubMirrorEntry>();
  return {
    get: (key) => entries.get(key) ?? null,
    set: (key, entry) => { entries.set(key, entry); },
    delete: (key) => { entries.delete(key); },
    keys: (prefix) => [...entries.keys()].filter((key) => key.startsWith(prefix)),
  };
}

export class GitHubReadCache implements GitHubTransport {
  #storage: GitHubMirrorStorage = memoryStorage();
  #lifetimes: GitHubCacheLifetimes = DEFAULT_GITHUB_CACHE_LIFETIMES;

  constructor(private readonly inner: GitHubTransport) {}

  /** Keeps the copy in `storage` (the database) from now on, with the configured lifetimes. */
  useStorage(storage: GitHubMirrorStorage, lifetimes: GitHubCacheLifetimes = DEFAULT_GITHUB_CACHE_LIFETIMES): void {
    this.#storage = storage;
    this.#lifetimes = lifetimes;
  }

  async request<T>(request: GitHubTransportRequest): Promise<T> {
    const key = readKey(request);
    if (key === null) {
      const result = await this.inner.request<T>(request);
      this.#afterWrite(request, result);
      return result;
    }
    const held = this.#storage.get(key);
    if (held && held.version === GITHUB_MIRROR_VERSION && Date.now() - held.at < lifetimeOf(held, this.#lifetimes)) return structuredClone(held.value) as T;
    const value = await this.inner.request<T>(request);
    return this.#storeRead(key, value, held) as T;
  }

  /** Applies what a verified webhook delivery says about the repository's data. */
  applyDelivery(eventType: string, payload: unknown): void {
    if (!isObject(payload) || !isObject(payload.repository) || typeof payload.repository.full_name !== "string") return;
    const repository = `repos/${payload.repository.full_name.toLowerCase()}`;
    const issue = isObject(payload.issue) ? payload.issue : null;
    const pull = isObject(payload.pull_request) ? payload.pull_request : null;
    switch (eventType) {
      case "issues":
      case "issue_comment": {
        if (!issue || typeof issue.number !== "number") return;
        if (eventType === "issue_comment") this.#drop(`${repository}/issues/${issue.number}/comments`);
        // A comment on a pull request carries its issue view, not an issue to keep.
        if (issue.pull_request !== undefined) return;
        if (payload.action === "transferred" || payload.action === "deleted") {
          this.#drop(`${repository}/issues/${issue.number}`);
          this.#dropList(`${repository}/issues`);
        } else {
          this.#putNewer(`${repository}/issues/${issue.number}`, issue);
          this.#putNewerInIssueListings(repository, issue);
        }
        // Its timeline and history changed with it.
        this.#drop(`${repository}/issues/${issue.number}/events`);
        this.#drop(`${repository}/issues/${issue.number}/timeline`);
        return;
      }
      case "pull_request": {
        if (!pull || typeof pull.number !== "number") return;
        this.#putNewer(`${repository}/pulls/${pull.number}`, pull);
        if (["opened", "closed", "reopened"].includes(String(payload.action))) this.#dropList(`${repository}/pulls`);
        return;
      }
      case "pull_request_review":
      case "pull_request_review_comment":
      case "pull_request_review_thread": {
        if (!pull || typeof pull.number !== "number") return;
        this.#drop(`${repository}/pulls/${pull.number}/reviews`);
        this.#drop(`${repository}/pulls/${pull.number}/comments`);
        this.#dropGraphql();
        return;
      }
      case "check_run": {
        const run = isObject(payload.check_run) ? payload.check_run : null;
        if (!run || typeof run.head_sha !== "string" || typeof run.id !== "number") return;
        this.#upsertCheckRun(`${repository}/commits/${run.head_sha}/check-runs`, run);
        return;
      }
      case "member": {
        // A collaborator added, removed or changed: their permission is read again when next needed.
        const login = isObject(payload.member) ? payload.member.login : null;
        if (typeof login === "string") this.#drop(`${repository}/collaborators/${login}`);
        return;
      }
      case "sub_issues":
      case "issue_dependencies": {
        for (const field of ["parent_issue", "sub_issue", "blocked_issue", "blocking_issue"]) {
          const named = payload[field];
          if (!isObject(named) || typeof named.number !== "number") continue;
          this.#drop(`${repository}/issues/${named.number}/sub_issues`);
          this.#drop(`${repository}/issues/${named.number}/dependencies`);
        }
        this.#dropGraphql();
        return;
      }
      default:
    }
  }

  /** Drops everything held for a repository, so its next reads go to GitHub (Sync now). */
  forgetRepository(address: string): void {
    for (const key of this.#storage.keys(`repos/${address.toLowerCase()}/`)) this.#storage.delete(key);
    this.#dropGraphql();
  }

  /** Stores an object a delivery carries, unless the copy holds a newer state of it. */
  #putNewer(key: string, value: Json): void {
    const held = this.#storage.get(key);
    const heldAt = isObject(held?.value) ? Date.parse(String(held.value.updated_at)) : Number.NaN;
    const deliveredAt = Date.parse(String(value.updated_at));
    if (!Number.isNaN(heldAt) && !Number.isNaN(deliveredAt) && deliveredAt < heldAt) return;
    this.#put(key, value);
  }

  /** Replaces an issue in every held repository listing, but never with an older delivery. */
  #putNewerInIssueListings(repository: string, issue: Json): void {
    this.#replaceInIssueListings(repository, issue, (held) => {
      const heldAt = Date.parse(String(held.updated_at));
      const deliveredAt = Date.parse(String(issue.updated_at));
      return Number.isNaN(heldAt) || Number.isNaN(deliveredAt) || deliveredAt >= heldAt;
    });
  }

  /** Replaces an issue in every held repository listing after Conveyor receives its full write response. */
  #putInIssueListings(repository: string, issue: Json): void {
    this.#replaceInIssueListings(repository, issue, () => true);
  }

  /** Applies GitHub's returned labels to held issue listings without disturbing the rest of each issue. */
  #putLabelsInIssueListings(repository: string, issueNumber: string, labels: unknown[]): void {
    const listing = `${repository}/issues`;
    for (const key of this.#storage.keys(listing)) {
      if (resource(key) !== listing) continue;
      const held = this.#storage.get(key);
      if (!held || !Array.isArray(held.value)) continue;
      let changed = false;
      const value = held.value.map((entry) => {
        if (!isObject(entry) || String(entry.number) !== issueNumber) return entry;
        changed = true;
        return { ...entry, labels };
      });
      if (changed) this.#storage.set(key, { ...held, value });
    }
  }

  /** Replaces matching full issue entries in every cached listing of the repository. */
  #replaceInIssueListings(repository: string, issue: Json, replace: (held: Json) => boolean): void {
    if (typeof issue.number !== "number") return;
    const listing = `${repository}/issues`;
    for (const key of this.#storage.keys(listing)) {
      if (resource(key) !== listing) continue;
      const held = this.#storage.get(key);
      if (!held || !Array.isArray(held.value)) continue;
      let changed = false;
      const value = held.value.map((entry) => {
        if (!isObject(entry) || entry.number !== issue.number || !replace(entry)) return entry;
        changed = true;
        return issue;
      });
      if (changed) this.#storage.set(key, { ...held, value });
    }
  }

  #put(key: string, value: unknown): void {
    // The same object read with a query (for example ?per_page) is another entry; drop those.
    for (const other of this.#storage.keys(key)) if (other !== key && resource(other) === key) this.#storage.delete(other);
    this.#store(key, value);
  }

  #store(key: string, value: unknown): void {
    if (value === undefined) this.#storage.delete(key);
    else this.#storage.set(key, { kind: kindOf(key), version: GITHUB_MIRROR_VERSION, value, at: Date.now() });
  }

  /** Stores a completed read without replaying labels that a concurrent write has already patched. */
  #storeRead(key: string, value: unknown, beforeRead: GitHubMirrorEntry | null): unknown {
    const current = this.#storage.get(key);
    if (
      beforeRead === null || current === beforeRead || resource(key).match(/\/issues$/) === null
      || !Array.isArray(value) || !Array.isArray(beforeRead.value) || !Array.isArray(current?.value)
    ) {
      this.#store(key, value);
      return value;
    }
    const beforeByNumber = new Map(beforeRead.value.filter(isObject).map((issue) => [issue.number, issue]));
    const currentByNumber = new Map(current.value.filter(isObject).map((issue) => [issue.number, issue]));
    const protectedLabels = value.map((issue) => {
      if (!isObject(issue)) return issue;
      const before = beforeByNumber.get(issue.number);
      const patched = currentByNumber.get(issue.number);
      if (!before || !patched || JSON.stringify(before.labels) === JSON.stringify(patched.labels)) return issue;
      return { ...issue, labels: patched.labels };
    });
    this.#store(key, protectedLabels);
    return protectedLabels;
  }

  /** Drops the entries of a resource and everything below it. */
  #drop(resourcePath: string): void {
    const base = normalize(resourcePath);
    for (const key of this.#storage.keys(base)) {
      const path = resource(key);
      if (path === base || path.startsWith(`${base}/`)) this.#storage.delete(key);
    }
  }

  /** Drops the listings of a collection (`<path>?…`), not its members. */
  #dropList(collectionPath: string): void {
    const base = normalize(collectionPath);
    for (const key of this.#storage.keys(base)) if (resource(key) === base) this.#storage.delete(key);
  }

  #dropGraphql(): void {
    for (const key of this.#storage.keys("graphql ")) this.#storage.delete(key);
  }

  /** Drops entries of a repository whose path matches `pattern` (when a write does not name the item). */
  #dropMatching(repository: string, pattern: RegExp): void {
    for (const key of this.#storage.keys(`${repository}/`)) if (pattern.test(resource(key))) this.#storage.delete(key);
  }

  /** Adds or replaces one check run in the commit's held check runs; a commit not held stays unread. */
  #upsertCheckRun(base: string, run: Json): void {
    for (const key of this.#storage.keys(normalize(base))) {
      if (resource(key) !== normalize(base)) continue;
      const held = this.#storage.get(key);
      if (!held) continue;
      const replace = (page: unknown): unknown => {
        if (!isObject(page) || !Array.isArray(page.check_runs)) return page;
        const runs = (page.check_runs as unknown[]).filter((existing) => !(isObject(existing) && existing.id === run.id));
        return { ...page, check_runs: [...runs, run], total_count: runs.length + 1 };
      };
      const value = Array.isArray(held.value) ? held.value.map((page, index) => (index === 0 ? replace(page) : page)) : replace(held.value);
      this.#storage.set(key, { ...held, value });
    }
  }

  /** Keeps the copy true after a write: the returned object replaces the held one, anything else is dropped. */
  #afterWrite(request: GitHubTransportRequest, result: unknown): void {
    if (request.path === "graphql") {
      this.#dropGraphql();
      return;
    }
    const parts = split(request.path);
    if (!parts) return;
    const { repository } = parts;
    const rest = resource(parts.rest);
    let match: RegExpExecArray | null;
    if (/^\/issues\/\d+$/.test(rest) && request.method === "PATCH") {
      this.#put(repository + rest, result);
      if (isObject(result)) this.#putInIssueListings(repository, result);
    } else if ((match = /^\/issues\/(\d+)\/labels/.exec(rest))) {
      // The labels the issue now has, kept on the held issue; the rest of it is unchanged.
      const issueKey = `${repository}/issues/${match[1]}`;
      const held = this.#storage.get(issueKey);
      if (held && isObject(held.value) && Array.isArray(result)) this.#storage.set(issueKey, { ...held, value: { ...held.value, labels: result } });
      else this.#drop(issueKey);
      if (Array.isArray(result)) this.#putLabelsInIssueListings(repository, match[1]!, result);
      this.#drop(`${issueKey}/labels`);
      this.#drop(`${issueKey}/events`);
      this.#drop(`${issueKey}/timeline`);
    } else if ((match = /^\/issues\/(\d+)\/([^/]+)/.exec(rest))) {
      // comments, sub_issues, dependencies, …: what was written below the issue.
      this.#drop(`${repository}/issues/${match[1]}/${match[2]}`);
    } else if (/^\/issues\/comments\//.test(rest)) {
      // A comment edited by its id: the issue it is on is not in the path.
      this.#dropMatching(repository, /\/issues\/\d+\/comments$/);
    } else if (/^\/pulls\/\d+$/.test(rest) && request.method === "PATCH") {
      this.#put(repository + rest, result);
    } else if ((match = /^\/pulls\/(\d+)\//.exec(rest))) {
      this.#drop(`${repository}/pulls/${match[1]}`);
      this.#dropGraphql();
    } else if (rest === "/pulls" && request.method === "POST") {
      this.#dropList(`${repository}/pulls`);
      if (isObject(result) && typeof result.number === "number") this.#put(`${repository}/pulls/${result.number}`, result);
    } else if (/^\/pulls\/comments\//.test(rest)) {
      this.#dropMatching(repository, /\/pulls\/\d+\/comments$/);
      this.#dropGraphql();
    } else if (/^\/actions\//.test(rest)) {
      // A rerun changes a commit's check runs; the commit is not in the path.
      this.#dropMatching(repository, /\/(commits\/[^/]+\/check-runs|actions\/.*)$/);
    } else if (/^\/git\/refs\//.test(rest)) {
      this.#dropList(`${repository}/pulls`);
    } else {
      this.#drop(repository + rest);
    }
  }
}

/** The key of a read, or null for a write. */
function readKey(request: GitHubTransportRequest): string | null {
  if (request.method === "GET") {
    if (UNCACHED.some((pattern) => pattern.test(request.path))) return null;
    return `${normalize(request.path)}${request.paginate ? " paginate" : ""}${request.raw ? " raw" : ""}`;
  }
  if (request.method === "POST" && request.path === "graphql" && isObject(request.body) && typeof request.body.query === "string" && !/^\s*mutation\b/.test(request.body.query)) {
    return `graphql ${JSON.stringify(request.body)}`;
  }
  return null;
}
