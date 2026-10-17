import type {
  BranchPushResult,
  ChangeDelivery,
  ChangeRequest,
  CodeHost,
  FindingVerdict,
  MergeChangeResult,
  MergeRefusal,
  ReviewArtifact,
} from "../../codehost/types";
import { GitHubAdapter, GitHubTransportError } from "./adapter";
import { GitHubRepositoryTrust } from "./trust";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type GitRunner = (cwd: string, args: string[]) => Promise<CommandResult>;

async function runGit(cwd: string, args: string[]): Promise<CommandResult> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function reference(address: string, id: string): number {
  const prefix = `github:${address}#pr-`;
  const number = id.startsWith(prefix)
    ? Number(id.slice(prefix.length))
    : id.startsWith("pr-")
      ? Number(id.slice("pr-".length))
      : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`change id "${id}" does not belong to GitHub repository ${address}`);
  }
  return number;
}

const findingMarker = (findingId: string) => `<!-- conveyor:finding:${findingId} -->`;
const OWN_MARKER = "<!-- conveyor:finding:";

function mergeRefusal(detail: string): MergeRefusal | null {
  if (/head branch was modified|head.*(?:moved|changed|modified)/i.test(detail)) return "head-moved";
  const policyRefusal = /permission|forbidden|not authorized|protected branch|branch protection|required status check|required pull request review/i.test(detail);
  if (!policyRefusal && /conflict|not mergeable/i.test(detail)) return "conflict";
  if (!policyRefusal && /behind|out[ -]?of[ -]?date|base branch (?:was )?modified/i.test(detail)) return "outdated";
  if (policyRefusal || /HTTP 40[13]/.test(detail)) return "blocked";
  if (/HTTP 409/.test(detail)) return "conflict";
  return null;
}

function refusalResult(detail: string): MergeChangeResult | null {
  const refusal = mergeRefusal(detail);
  return refusal ? { merged: false, refusal, reason: detail } : null;
}

function findingComment(findingId: string, body: string, where: string | null, resolution?: string): string {
  const heading = resolution ?? "**Review finding**";
  return `${findingMarker(findingId)}\n${heading}${where ? ` (${where})` : ""}\n\n${body}`;
}

const reaction = (verdict: FindingVerdict): "+1" | "-1" => (verdict === "fixed" ? "+1" : "-1");

/** Runs a best-effort GitHub step: the finding record is the authority, its projection is a courtesy. */
async function bestEffort(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch {
    // Left as is: the record stays resolved.
  }
}

/** GitHub implementation of the provider-neutral branch and change contract. */
/** Only a conflict is a definite no; blocked/behind/unknown/draft say nothing about conflicts, so they stay unknown. */
function mergeable(mergeState: string | null): boolean | null {
  if (mergeState === "clean" || mergeState === "has_hooks" || mergeState === "unstable") return true;
  if (mergeState === "dirty") return false;
  return null;
}

export class GitHubCodeHost implements CodeHost {
  constructor(
    private readonly github: GitHubAdapter,
    private readonly git: GitRunner = runGit,
    private readonly trust: Pick<GitHubRepositoryTrust, "isTrusted"> = new GitHubRepositoryTrust(github),
  ) {}

  readFileAtRevision(input: { address: string; path: string; headSha: string }): Promise<string | null> {
    return this.github.fileSource(input.address, input.path, input.headSha);
  }

  sourceFileUrl(input: { address: string; path: string; headSha: string; line?: number }): string {
    const line = input.line === undefined ? "" : `#L${input.line}`;
    return `https://github.com/${input.address}/blob/${input.headSha}/${input.path.split("/").map(encodeURIComponent).join("/")}${line}`;
  }

  async pushBranch(input: {
    address: string;
    workspace: { path: string; branch: string };
    base?: string;
  }): Promise<BranchPushResult> {
    const { path, branch } = input.workspace;
    const fetched = await this.git(path, [
      "fetch",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    const remote = `origin/${branch}`;
    if (fetched.exitCode === 0) {
      const localBehind =
        (await this.git(path, ["merge-base", "--is-ancestor", "HEAD", remote])).exitCode === 0;
      const remoteBehind =
        (await this.git(path, ["merge-base", "--is-ancestor", remote, "HEAD"])).exitCode === 0;
      if (localBehind && !remoteBehind) {
        const status = await this.git(path, ["status", "--porcelain"]);
        if (status.stdout.length > 0) {
          return {
            pushed: false,
            status: "changes-requested",
            reason: `The local branch ${branch} is behind origin/${branch} and has uncommitted changes; commit or discard them before synchronizing.`,
          };
        }
        const fastForward = await this.git(path, ["merge", "--ff-only", remote]);
        if (fastForward.exitCode !== 0) {
          throw new Error(`cannot fast-forward ${branch}: ${fastForward.stderr || "Git error"}`);
        }
      } else if (!localBehind && !remoteBehind) {
        return {
          pushed: false,
          status: "changes-requested",
          reason: `The local branch ${branch} and origin/${branch} have diverged; rebase the local work onto origin/${branch} (keeping both sides) and push.`,
        };
      }
    } else if (!/couldn't find remote ref|remote ref does not exist|not found/i.test(fetched.stderr)) {
      throw new Error(`cannot fetch origin/${branch}: ${fetched.stderr || "Git error"}`);
    }
    if (input.base) {
      const synced = await this.syncWithBase(path, branch, input.base);
      if (synced) return synced;
    }
    const pushed = await this.git(path, ["push", "--set-upstream", "origin", branch]);
    if (pushed.exitCode !== 0) throw new Error(`cannot push ${branch}: ${pushed.stderr || "Git error"}`);
    return { pushed: true };
  }

  /**
   * Brings the branch up to date with its base before it is pushed, so CI runs the base's current
   * workflows and a strict "branch must be up to date" rule can be met. A merge (not a rebase) keeps
   * later pushes fast-forward; a conflict is aborted and handed back to implementation.
   */
  private async syncWithBase(path: string, branch: string, base: string): Promise<BranchPushResult | null> {
    const fetched = await this.git(path, ["fetch", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    if (fetched.exitCode !== 0) {
      // A base the remote does not have yet leaves nothing to merge.
      if (/couldn't find remote ref|remote ref does not exist|not found/i.test(fetched.stderr)) return null;
      throw new Error(`cannot fetch origin/${base}: ${fetched.stderr || "Git error"}`);
    }
    const upToDate = (await this.git(path, ["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"])).exitCode === 0;
    if (upToDate) return null;
    const status = await this.git(path, ["status", "--porcelain"]);
    if (status.stdout.length > 0) {
      return {
        pushed: false,
        status: "changes-requested",
        reason: `The branch ${branch} is behind origin/${base} and has uncommitted changes; commit or discard them so it can be updated.`,
      };
    }
    const merged = await this.git(path, ["merge", "--no-edit", `origin/${base}`]);
    if (merged.exitCode === 0) return null;
    const conflicts = await this.git(path, ["diff", "--name-only", "--diff-filter=U"]);
    await this.git(path, ["merge", "--abort"]);
    const files = conflicts.stdout.trim().split("\n").filter(Boolean);
    return {
      pushed: false,
      status: "changes-requested",
      reason: `The branch ${branch} conflicts with origin/${base}${files.length ? ` in ${files.join(", ")}` : ""}; merge origin/${base} into it, resolve the conflicts keeping both sides' intent, run the tests and push.`,
    };
  }

  async ensureChange(input: {
    address: string;
    issueNumber: number;
    branch: string;
    base: string;
    title: string;
    closes: boolean;
  }): Promise<ChangeRequest> {
    const ref = await this.github.ensurePullRequest({
      address: input.address, issueNumber: input.issueNumber, branch: input.branch,
      baseBranch: input.base, title: input.title, closingReference: input.closes,
    });
    return this.getChange({ address: input.address, id: `github:${input.address}#pr-${ref.number}` });
  }

  async getChange(input: { address: string; id: string }): Promise<ChangeRequest> {
    const pull = await this.github.getPullRequestChange(input.address, reference(input.address, input.id));
    return {
      id: input.id,
      number: pull.number,
      url: pull.url,
      state: pull.state,
      headSha: pull.headSha,
      draft: pull.draft,
      mergeable: mergeable(pull.mergeState),
      mergedAt: pull.mergedAt,
      body: pull.body ?? "",
    };
  }

  async mergeChange(input: {
    address: string;
    id: string;
    method: "squash";
    expectedHeadSha?: string;
  }): Promise<MergeChangeResult> {
    try {
      const result = await this.github.squashMerge(input.address, reference(input.address, input.id), input.expectedHeadSha);
      if (result.merged) return result.sha ? { merged: true, sha: result.sha } : { merged: true };
      return refusalResult(result.message ?? "") ?? { merged: false, refusal: "blocked", ...(result.message ? { reason: result.message } : {}) };
    } catch (error) {
      if (error instanceof GitHubTransportError) {
        const result = refusalResult(error.stderr);
        if (result) return result;
      }
      throw error;
    }
  }

  async setChangeChecklist(input: { address: string; id: string; markdown: string }): Promise<void> {
    await this.github.setPullRequestChecklist(input.address, reference(input.address, input.id), input.markdown);
  }

  async setChangeDescription(input: { address: string; id: string; markdown: string }): Promise<ChangeRequest> {
    await this.github.setPullRequestDescription(input.address, reference(input.address, input.id), input.markdown);
    return this.getChange({ address: input.address, id: input.id });
  }

  async getChangeDelivery(input: { address: string; id: string }): Promise<ChangeDelivery> {
    const delivery = await this.github.getPullRequestDelivery(input.address, reference(input.address, input.id));
    return {
      change: {
        id: input.id,
        number: delivery.pullRequest.number,
        url: delivery.pullRequest.url,
        state: delivery.pullRequest.state,
        headSha: delivery.pullRequest.headSha,
        draft: delivery.pullRequest.draft,
        mergeable: mergeable(delivery.pullRequest.mergeState),
        mergedAt: delivery.pullRequest.mergedAt,
        body: delivery.pullRequest.body ?? "",
      },
      pullRequest: delivery.pullRequest,
      checks: delivery.checks,
    };
  }

  async createFinding(input: {
    address: string; id: string; findingId: string; body: string; headSha: string; path?: string; line?: number;
  }): Promise<{ url: string; projection: string }> {
    const number = reference(input.address, input.id);
    const positioned = input.path !== undefined && input.line !== undefined;
    if (positioned) {
      try {
        const created = await this.github.createReviewComment(input.address, number, {
          body: findingComment(input.findingId, input.body, null), commitId: input.headSha, path: input.path!, line: input.line!,
        });
        return { url: created.url, projection: `inline:${created.id}` };
      } catch (error) {
        // GitHub answers HTTP 422 when the line is not part of the diff: fall back to a change comment.
        if (!(error instanceof GitHubTransportError && /HTTP 422/.test(error.stderr))) throw error;
      }
    }
    const where = input.path ? `${input.path}${input.line !== undefined ? `:${input.line}` : ""}` : null;
    const created = await this.github.createComment(input.address, number, findingComment(input.findingId, input.body, where));
    return { url: created.url, projection: `comment:${created.id}` };
  }

  async resolveFindingProjection(input: {
    address: string; id: string; findingId: string; projection: string; body: string; actor: string;
    verdict: FindingVerdict; message: string;
  }): Promise<void> {
    const [kind, rawId] = input.projection.split(":");
    const commentId = Number(rawId);
    if (!Number.isSafeInteger(commentId)) throw new Error(`unknown finding projection "${input.projection}"`);
    const number = reference(input.address, input.id);
    if (kind === "inline") {
      await this.github.replyToReviewComment(input.address, number, commentId, input.message);
      await bestEffort(() => this.github.reactToReviewComment(input.address, commentId, reaction(input.verdict)));
      await bestEffort(async () => {
        const thread = (await this.github.listReviewThreads(input.address, number))
          .find((candidate) => candidate.comments.nodes[0]?.databaseId === commentId);
        if (thread && !thread.isResolved) await this.github.resolveReviewThread(thread.id);
      });
    } else {
      await this.github.updateComment(input.address, commentId, findingComment(input.findingId, input.body, null, input.message));
      await bestEffort(() => this.github.reactToIssueComment(input.address, commentId, reaction(input.verdict)));
    }
  }

  async resolveNativeFinding(input: {
    address: string; id: string; providerKey: string; verdict: FindingVerdict; message: string;
  }): Promise<void> {
    const [kind, key] = input.providerKey.split(":");
    if (!key) throw new Error(`Cannot resolve native finding with provider key ${input.providerKey}`);
    if (kind === "thread") {
      await this.github.replyToReviewThread(key, input.message);
      await bestEffort(() => this.github.reactToReviewThread(key, reaction(input.verdict)));
      // Required: an unresolved thread would reopen the finding on the next import.
      await this.github.resolveReviewThread(key);
      return;
    }
    if (kind === "review") {
      // A changes-requested review has no thread to resolve; answer it on the pull request.
      await this.github.createComment(input.address, reference(input.address, input.id), `${input.message}\n\n(Re: review ${key})`);
      return;
    }
    throw new Error(`unknown review artifact "${input.providerKey}"`);
  }

  async deleteBranch(input: { address: string; branch: string }): Promise<"deleted" | "absent" | "kept"> {
    if (await this.github.hasOpenPullRequestFor(input.address, input.branch)) return "kept";
    return (await this.github.deleteBranchRef(input.address, input.branch)) ? "deleted" : "absent";
  }

  async listReviewArtifacts(input: { address: string; id: string; extraTrustedLogins?: readonly string[] }): Promise<ReviewArtifact[]> {
    const number = reference(input.address, input.id);
    const threads = await this.github.listReviewThreads(input.address, number);
    const reviews = await this.github.listReviews(input.address, number);
    const artifacts: ReviewArtifact[] = [];
    const threadedReviews = new Set<number>();
    const extraTrustedLogins = input.extraTrustedLogins ?? [];
    const trustByLogin = new Map<string | null, Promise<boolean>>();
    const isTrusted = (login: string | null): Promise<boolean> => {
      const key = login?.toLowerCase() ?? null;
      const existing = trustByLogin.get(key);
      if (existing !== undefined) return existing;
      const decision = this.trust.isTrusted({ address: input.address, login, extraTrustedLogins });
      trustByLogin.set(key, decision);
      return decision;
    };
    for (const thread of threads) {
      const first = thread.comments.nodes[0];
      if (!first) continue;
      for (const comment of thread.comments.nodes) {
        if (comment.pullRequestReview) threadedReviews.add(comment.pullRequestReview.databaseId);
      }
      if (first.body.includes(OWN_MARKER)) continue;
      const author = first.author?.login ?? null;
      const trusted = await isTrusted(author);
      artifacts.push({ providerKey: `thread:${thread.id}`, author, trusted, body: first.body, url: first.url, path: first.path, line: first.line, resolved: thread.isResolved });
      if (trusted) continue;
      for (const reply of thread.comments.nodes.slice(1)) {
        if (reply.body.includes(OWN_MARKER)) continue;
        const replyAuthor = reply.author?.login ?? null;
        const replyTrusted = await isTrusted(replyAuthor);
        if (!replyTrusted) continue;
        artifacts.push({
          providerKey: `thread:${thread.id}:comment:${reply.id}`, author: replyAuthor, trusted: true, body: reply.body,
          url: reply.url, path: reply.path, line: reply.line, resolved: thread.isResolved,
        });
        break;
      }
    }
    const ordered = [...reviews].sort((a, b) => a.id - b.id);
    for (const review of ordered) {
      const author = review.user?.login ?? null;
      const body = review.body ?? "";
      if (review.state !== "CHANGES_REQUESTED" || body.includes(OWN_MARKER) || threadedReviews.has(review.id)) continue;
      const trusted = await isTrusted(author);
      const approved = ordered.some((later) => later.id > review.id && later.user?.login?.toLowerCase() === author?.toLowerCase() && later.state === "APPROVED");
      artifacts.push({ providerKey: `review:${review.id}`, author, trusted, body, url: review.html_url, path: null, line: null, resolved: approved });
    }
    return artifacts;
  }
}
