import type {
  BranchPushResult,
  ChangeDelivery,
  ChangeRequest,
  CodeHost,
  ReviewArtifact,
} from "../../codehost/types";
import { GitHubAdapter, GitHubTransportError } from "./adapter";

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

function findingComment(findingId: string, body: string, where: string | null, resolvedBy?: string): string {
  const heading = resolvedBy ? `✅ Resolved by ${resolvedBy}` : "**Review finding**";
  return `${findingMarker(findingId)}\n${heading}${where ? ` (${where})` : ""}\n\n${body}`;
}

const isBot = (login: string) => login.endsWith("[bot]");

/** GitHub implementation of the provider-neutral branch and change contract. */
/** Only a conflict is a definite no; blocked/behind/unknown/draft say nothing about conflicts, so they stay unknown. */
function mergeable(mergeState: string | null): boolean | null {
  if (mergeState === "clean" || mergeState === "has_hooks" || mergeState === "unstable") return true;
  if (mergeState === "dirty") return false;
  return null;
}

export class GitHubCodeHost implements CodeHost {
  constructor(private readonly github: GitHubAdapter, private readonly git: GitRunner = runGit) {}

  async pushBranch(input: {
    address: string;
    workspace: { path: string; branch: string };
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
    const pushed = await this.git(path, ["push", "--set-upstream", "origin", branch]);
    if (pushed.exitCode !== 0) throw new Error(`cannot push ${branch}: ${pushed.stderr || "Git error"}`);
    return { pushed: true };
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
  }): Promise<{ merged: boolean; sha?: string; headMoved?: boolean }> {
    try {
      return await this.github.squashMerge(input.address, reference(input.address, input.id), input.expectedHeadSha);
    } catch (error) {
      // GitHub answers HTTP 409 when the `sha` in the merge request is no longer the head.
      if (input.expectedHeadSha && error instanceof GitHubTransportError && /HTTP 409|Head branch was modified/i.test(error.stderr)) {
        return { merged: false, headMoved: true };
      }
      throw error;
    }
  }

  async setChangeChecklist(input: { address: string; id: string; markdown: string }): Promise<void> {
    await this.github.setPullRequestChecklist(input.address, reference(input.address, input.id), input.markdown);
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
  }): Promise<void> {
    const [kind, rawId] = input.projection.split(":");
    const commentId = Number(rawId);
    if (!Number.isSafeInteger(commentId)) throw new Error(`unknown finding projection "${input.projection}"`);
    if (kind === "inline") {
      await this.github.replyToReviewComment(input.address, reference(input.address, input.id), commentId, `Resolved by ${input.actor}`);
    } else {
      await this.github.updateComment(input.address, commentId, findingComment(input.findingId, input.body, null, input.actor));
    }
  }

  async listReviewArtifacts(input: { address: string; id: string }): Promise<ReviewArtifact[]> {
    const number = reference(input.address, input.id);
    const [threads, reviews] = await Promise.all([
      this.github.listReviewThreads(input.address, number),
      this.github.listReviews(input.address, number),
    ]);
    const artifacts: ReviewArtifact[] = [];
    const threadedReviews = new Set<number>();
    for (const thread of threads) {
      const first = thread.comments.nodes[0];
      if (!first) continue;
      if (first.pullRequestReview) threadedReviews.add(first.pullRequestReview.databaseId);
      const author = first.author?.login ?? "ghost";
      if (isBot(author) || first.body.includes(OWN_MARKER)) continue;
      artifacts.push({ providerKey: `thread:${thread.id}`, author, body: first.body, url: first.url, path: first.path, line: first.line, resolved: thread.isResolved });
    }
    const ordered = [...reviews].sort((a, b) => a.id - b.id);
    for (const review of ordered) {
      const author = review.user?.login ?? "ghost";
      const body = review.body ?? "";
      if (review.state !== "CHANGES_REQUESTED" || isBot(author) || body.includes(OWN_MARKER) || threadedReviews.has(review.id)) continue;
      const approved = ordered.some((later) => later.id > review.id && later.user?.login === author && later.state === "APPROVED");
      artifacts.push({ providerKey: `review:${review.id}`, author, body, url: review.html_url, path: null, line: null, resolved: approved });
    }
    return artifacts;
  }
}
