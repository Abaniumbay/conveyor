import type {
  BranchPushResult,
  ChangeDelivery,
  ChangeRequest,
  CodeHost,
} from "../../codehost/types";
import { GitHubAdapter } from "./adapter";

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
  const number = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`change id "${id}" does not belong to GitHub repository ${address}`);
  }
  return number;
}

/** GitHub implementation of the provider-neutral branch and change contract. */
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
      mergeable: pull.mergeState === null ? null : pull.mergeState === "clean" || pull.mergeState === "has_hooks",
      mergedAt: pull.mergedAt,
    };
  }

  async mergeChange(input: { address: string; id: string; method: "squash" }): Promise<{ merged: boolean; sha?: string }> {
    return this.github.squashMerge(
      input.address,
      reference(input.address, input.id),
    );
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
        mergeable: delivery.pullRequest.mergeState === null
          ? null
          : delivery.pullRequest.mergeState === "clean" || delivery.pullRequest.mergeState === "has_hooks",
        mergedAt: delivery.pullRequest.mergedAt,
      },
      pullRequest: delivery.pullRequest,
      checks: delivery.checks,
    };
  }
}
