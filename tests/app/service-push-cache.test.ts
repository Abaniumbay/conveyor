import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ScopedMcpFactory } from "../../src/app/runtime";
import { ConveyorService } from "../../src/app/service";
import { CodeHostRegistry } from "../../src/codehost/registry";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { GitHubAdapter, type GitHubTransport, type GitHubTransportRequest } from "../../src/source/github/adapter";
import { GitHubCodeHost } from "../../src/source/github/codehost";
import { GitHubReadCache } from "../../src/source/github/read-cache";
import { createTaskRegistry } from "../../src/tasks/catalogue";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function commit(workspace: string, filename: string): Promise<string> {
  await writeFile(path.join(workspace, filename), `${filename}\n`);
  await git(workspace, ["add", filename]);
  await git(workspace, ["commit", "-m", filename]);
  return git(workspace, ["rev-parse", "HEAD"]);
}

describe("a push through the service refreshes the cached pull request", () => {
  test("with no webhook, change.get reports the pushed head and a lease push of it passes the head fence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-service-push-cache-"));
    directories.push(root);
    const repositoryPath = path.join(root, "repo");
    await mkdir(repositoryPath);
    await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: {}
sources: { github: { type: github } }
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    stages:
      - id: implementation
        concurrency: 1
        actions: []
        exit-gate: [{ task: item.criteriaDefined }]
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repositoryPath}
    pipeline: default
`);
    const config = await loadConfig(path.join(root, "config.yml"), createTaskRegistry());
    const store = await ConveyorStore.open(config.settings.database);
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash });

    const remote = path.join(root, "remote.git");
    const workspace = path.join(root, "workspace");
    const branch = "conveyor/7-r1-push";
    await git(root, ["init", "--bare", "--initial-branch=main", remote]);
    await git(root, ["clone", remote, workspace]);
    await commit(workspace, "base.txt");
    await git(workspace, ["push", "origin", "main"]);
    await git(workspace, ["checkout", "-b", branch]);
    const a = await commit(workspace, "a.txt");
    await git(workspace, ["push", "origin", branch]);

    store.upsertIssue({
      id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://example.test/7", title: "Push", body: "",
      sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    const enrollment = store.activateEnrollment("i1");
    store.recordWorkspace({ id: "workspace", enrollmentId: enrollment.id, path: workspace, branch, status: "active" });
    store.upsertPullRequest({ issueId: "i1", id: "github:owner/repo#pr-5", number: 5, url: "https://github.com/owner/repo/pull/5", state: "open" });

    let head = a;
    const requests: string[] = [];
    const transport: GitHubTransport = {
      async request<T>(request: GitHubTransportRequest): Promise<T> {
        requests.push(`${request.method} ${request.path}`);
        if (request.path === "repos/owner/repo/pulls/5") {
          return { number: 5, html_url: "https://github.com/owner/repo/pull/5", state: "open", draft: false, head: { sha: head, ref: branch }, base: { ref: "main" }, body: "" } as T;
        }
        if (request.path.startsWith("repos/owner/repo/commits/")) return { check_runs: [] } as T;
        throw new Error(`unexpected request ${request.method} ${request.path}`);
      },
    };
    const github = new GitHubAdapter(new GitHubReadCache(transport), "conveyor");
    const codeHosts = new CodeHostRegistry().register("github", new GitHubCodeHost(github, undefined, { isTrusted: async () => true }));
    const service = new ConveyorService(config, store, github, { codeHosts });

    const issue = store.getIssue("i1")!;
    const factory = (service as unknown as { mcpFactory(): ScopedMcpFactory }).mcpFactory();
    const lease = await factory.create({
      runId: "run-1", stageId: "implementation",
      context: { issue, repository: { id: "repo", address: "owner/repo", folder: root, baseBranch: "main" }, workspace: null, sourceGuidance: "g" } as never,
      allowedTools: ["workspace.push", "change.get"], actor: { id: "k", name: "K", title: "Implementer" },
    });
    const token = (JSON.parse(await readFile(path.join(root, "artifacts/run-1/mcp-context.json"), "utf8")) as { control: { token: string } }).control.token;
    const call = (tool: string, input: unknown) => service.handleMcp({ tool, input }, token);
    const reportedHead = async () => ((await call("change.get", {})) as { change?: { headSha?: string } }).change?.headSha;

    expect(await reportedHead()).toBe(a);
    const b = await commit(workspace, "b.txt");
    head = b;
    expect(await reportedHead()).toBe(a); // cached; no webhook yet

    await call("workspace.push", {});
    expect(await reportedHead()).toBe(b);

    const c = await commit(workspace, "c.txt");
    await call("workspace.push", { forceWithLease: true, headSha: b });
    expect(await git(remote, ["rev-parse", `refs/heads/${branch}`])).toBe(c);

    // The agent's own `git push` reaches GitHub with no webhook: the head fence re-reads once and lets the call through.
    head = c;
    expect(await reportedHead()).toBe(c);
    const d = await commit(workspace, "d.txt");
    await git(workspace, ["push", "origin", branch]);
    head = d;
    const e = await commit(workspace, "e.txt");
    await call("workspace.push", { forceWithLease: true, headSha: d });
    expect(await git(remote, ["rev-parse", `refs/heads/${branch}`])).toBe(e);

    await lease.close();
    await service.close();
  });
});
