import { describe, expect, test } from "bun:test";
import { GitHubAdapter, GitHubTransportError, type GitHubTransport, type GitHubTransportRequest } from "../../../src/source/github/adapter";
import { GitHubActionsCiProvider } from "../../../src/source/github/ci-provider";
import { ciProviderContract } from "../../app/ci-provider.contract";

class FakeTransport implements GitHubTransport {
  readonly requests: GitHubTransportRequest[] = [];
  workflows = new Set<string>();
  runs: unknown[] = [];
  jobs: Record<number, unknown> = {};
  annotations: Record<number, unknown[]> = {};
  workflowRuns: unknown[] = [];
  artifacts: Record<number, unknown[]> = {};
  archives: Record<number, Uint8Array> = {};
  async request<T>(request: GitHubTransportRequest): Promise<T> {
    this.requests.push(request);
    if (request.path.includes("/actions/runs?") && request.path.includes("head_sha=")) return { workflow_runs: this.workflowRuns } as T;
    if (request.path.includes("/actions/runs/") && request.path.includes("/artifacts")) {
      const id = Number(request.path.split("/").at(-2));
      return { artifacts: this.artifacts[id] ?? [] } as T;
    }
    if (request.path.includes("/actions/artifacts/") && request.path.endsWith("/zip")) {
      const id = Number(request.path.split("/").at(-2));
      return this.archives[id]! as T;
    }
    if (request.path.includes("/pulls/")) return { head: { sha: "commit-1" } } as T;
    if (request.path.includes("/check-runs/") && request.path.includes("/annotations")) {
      const id = Number(request.path.split("/").at(-2));
      return [this.annotations[id] ?? []] as T;
    }
    if (request.path.includes("/check-runs")) return [{ check_runs: this.runs }] as T;
    if (request.path.includes("/actions/jobs/") && !request.path.endsWith("/logs") && !request.path.endsWith("/rerun")) {
      const id = Number(request.path.split("/").at(-1));
      return this.jobs[id] as T;
    }
    if (request.path.includes("/actions/jobs/") && request.path.endsWith("/logs")) return "build log" as T;
    if (request.path.includes("/actions/jobs/") && request.path.endsWith("/rerun")) return {} as T;
    if (request.path.includes("/contents/.github/workflows/")) {
      const found = [...this.workflows].some((workflow) => request.path.includes(encodeURIComponent(workflow)));
      if (!found) throw new GitHubTransportError("404 Not Found", 1, "404 Not Found");
      return {} as T;
    }
    if (request.path.includes("/labels")) return {} as T;
    throw new Error(`unexpected transport path: ${request.path}`);
  }
}

function storedZip(path: string, content: string): Uint8Array {
  const name = new TextEncoder().encode(path);
  const data = new TextEncoder().encode(content);
  const bytes: number[] = [];
  const u16 = (value: number) => bytes.push(value & 0xff, value >>> 8 & 0xff);
  const u32 = (value: number) => bytes.push(value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0); u32(0); u32(data.length); u32(data.length); u16(name.length); u16(0);
  bytes.push(...name, ...data);
  const centralStart = bytes.length;
  u32(0x02014b50); u16(20); u16(20); u16(0); u16(0); u16(0); u16(0); u32(0); u32(data.length); u32(data.length); u16(name.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(0);
  bytes.push(...name);
  const centralSize = bytes.length - centralStart;
  u32(0x06054b50); u16(0); u16(0); u16(1); u16(1); u32(centralSize); u32(centralStart); u16(0);
  return new Uint8Array(bytes);
}

const triggerSet = [
  { label: "run-web-e2e", workflow: "web-e2e.yml", check: "Web", replaces: [] },
  { label: "run-android-e2e", workflow: "android-e2e.yml", check: "Android", replaces: [] },
  { label: "run-full-suite", workflow: "full-suite.yml", check: "Full", replaces: ["run-web-e2e", "run-android-e2e"] },
];
function provider(transport: FakeTransport) { return new GitHubActionsCiProvider(new GitHubAdapter(transport, "conveyor"), triggerSet); }
const change = { repository: "owner/repo", changeId: "7", url: "https://github.com/owner/repo/pull/7" };
function check(id: number, name: string, status: string, conclusion: string | null, app = "github-actions") {
  return { id, name, status, conclusion, details_url: `https://ci/${id}`, app: { slug: app }, started_at: null, completed_at: null };
}

ciProviderContract("GitHub Actions", async () => {
  const transport = new FakeTransport(); transport.runs = [check(12, "Cancelled", "completed", "cancelled")];
  const instance = new GitHubActionsCiProvider(new GitHubAdapter(transport, "conveyor"));
  return {
    provider: instance,
    change,
    commit: "commit-1",
    didRerun: () => transport.requests.some((request) => request.path.endsWith("/rerun")),
  };
});

describe("GitHub Actions CiProvider contract", () => {
  test("maps checks neutrally and picks an actual run over a newer skipped run", async () => {
    const transport = new FakeTransport();
    transport.runs = [
      check(5, "Build", "completed", "success"),
      check(9, "Build", "completed", "skipped"),
      check(8, "External", "completed", "failure", "third-party"),
      check(10, "Queued", "queued", null),
    ];
    const runs = await provider(transport).list(change, "commit-1");
    expect(runs.find((run) => run.name === "Build")).toMatchObject({ id: "5", state: "passed", canRerun: false, hasLog: true });
    expect(runs.find((run) => run.name === "External")).toMatchObject({ id: "8", state: "failed", canRerun: false, hasLog: false });
    expect(runs.find((run) => run.name === "Queued")?.state).toBe("queued");
  });
  test("latest comparable attempt wins and unrelated skipped attempts use latest ID", async () => {
    const transport = new FakeTransport();
    transport.runs = [check(3, "Build", "completed", "failure"), check(4, "Build", "completed", "success"), check(2, "Skipped", "completed", "skipped"), check(7, "Skipped", "completed", "skipped")];
    const runs = await provider(transport).list(change, "commit-1");
    expect(runs.find((run) => run.name === "Build")).toMatchObject({ id: "4", state: "passed" });
    expect(runs.find((run) => run.name === "Skipped")?.id).toBe("7");
  });
  test("identifies a failed GitHub Actions job with no runner or executed steps as never started", async () => {
    const transport = new FakeTransport();
    transport.runs = [check(12, "Tests", "completed", "failure")];
    transport.jobs[12] = { runner_name: null, steps: [] };
    transport.annotations[12] = [{ message: "Account billing stopped this job." }];

    const [result] = await provider(transport).list(change, "commit-1");

    expect(result).toMatchObject({
      name: "Tests",
      state: "failed",
      neverStarted: { annotation: "Account billing stopped this job." },
    });
    expect(transport.requests.map((request) => request.path)).toContain("repos/owner/repo/actions/jobs/12");
    expect(transport.requests.map((request) => request.path)).toContain("repos/owner/repo/check-runs/12/annotations?per_page=100");
  });

  test("does not classify a failed job with an executed step as never started", async () => {
    const transport = new FakeTransport();
    transport.runs = [check(12, "Tests", "completed", "failure")];
    transport.jobs[12] = { runner_name: null, steps: [{ status: "completed" }] };

    const [result] = await provider(transport).list(change, "commit-1");

    expect(result?.neverStarted).toBeUndefined();
    expect(transport.requests.some((request) => request.path.includes("/annotations"))).toBe(false);
  });
  test("reruns and reads logs only when the mapped run advertises those capabilities", async () => {
    const transport = new FakeTransport(); transport.runs = [check(12, "Cancelled", "completed", "cancelled")];
    const instance = provider(transport);
    const [run] = await instance.list(change, "commit-1");
    expect(run).toMatchObject({ canRerun: true, hasLog: true, state: "cancelled" });
    await instance.rerun(change, run!.id);
    await expect(instance.log(change, run!.id)).resolves.toBe("build log");
    expect(transport.requests.some((request) => request.path.endsWith("/rerun"))).toBe(true);
    expect(transport.requests.some((request) => request.path.endsWith("/logs"))).toBe(true);
  });
  test("reads only matching reports from the current check's completed workflow run at the requested head", async () => {
    const transport = new FakeTransport();
    transport.jobs[101] = { run_id: 1 };
    transport.workflowRuns = [
      { id: 1, head_sha: "commit-1", status: "completed" },
      { id: 2, head_sha: "other-commit", status: "completed" },
      { id: 3, head_sha: "commit-1", status: "in_progress" },
      { id: 4, head_sha: "commit-1", status: "completed" },
    ];
    transport.artifacts[1] = [
      { id: 11, name: "junit", expired: false },
      { id: 12, name: "other", expired: false },
    ];
    transport.archives[11] = storedZip("reports/results.xml", "<testsuite><testcase name=\"passes\"/></testsuite>");
    transport.artifacts[4] = [{ id: 41, name: "junit", expired: false }];

    await expect(provider(transport).reports(change, "commit-1", [{ id: "101", name: "Check", state: "passed", url: null, canRerun: false, hasLog: true }], { artifact: "junit", path: "reports/*.xml" })).resolves.toEqual([
      { runId: "1", artifactId: "11", path: "reports/results.xml", content: "<testsuite><testcase name=\"passes\"/></testsuite>" },
    ]);
    expect(transport.requests.map((request) => request.path)).toContain("repos/owner/repo/actions/runs?head_sha=commit-1&per_page=100");
    expect(transport.requests.some((request) => request.path.includes("/runs/2/artifacts") || request.path.includes("/runs/3/artifacts") || request.path.includes("/runs/4/artifacts"))).toBe(false);
    expect(transport.requests.some((request) => request.path.includes("/artifacts/12/zip"))).toBe(false);
  });
  test("starts only present workflows, honors replacement, and does not restart running jobs", async () => {
    const transport = new FakeTransport();
    transport.workflows = new Set(["web-e2e.yml", "android-e2e.yml", "full-suite.yml"]);
    transport.runs = [check(1, "Web", "in_progress", null)];
    const instance = provider(transport);
    expect(await instance.start(change, "commit-1", 60_000, 0)).toEqual(["Full"]);
    expect(transport.requests.filter((request) => request.method === "POST" && request.path.endsWith("/labels"))).toHaveLength(1);
    expect(transport.requests.find((request) => request.method === "POST" && request.path.endsWith("/labels"))?.body).toEqual({ labels: ["run-full-suite"] });
  });
  test("starts both platform workflows when the replacing workflow is absent", async () => {
    const transport = new FakeTransport();
    transport.workflows = new Set(["web-e2e.yml", "android-e2e.yml"]);
    const instance = provider(transport);
    expect(await instance.start(change, "commit-1", 60_000, 0)).toEqual(["Web", "Android"]);
    const labels = transport.requests.filter((request) => request.method === "POST" && request.path.endsWith("/labels"));
    expect(labels.map((request) => (request.body as { labels: string[] }).labels[0])).toEqual(["run-web-e2e", "run-android-e2e"]);
  });
  test("retriggering a skipped configured run is bounded by the retry window", async () => {
    const transport = new FakeTransport(); transport.workflows.add("web-e2e.yml");
    transport.runs = [check(2, "Web", "completed", "skipped")];
    const instance = provider(transport);
    expect(await instance.start(change, "commit-1", 10_000, 0)).toEqual(["Web"]);
    expect(await instance.start(change, "commit-1", 10_000, 1_000)).toEqual(["Web"]);
    expect(transport.requests.filter((request) => request.method === "POST" && request.path.endsWith("/labels"))).toHaveLength(1);
  });
});

describe("GitHub Actions CI definitions", () => {
  const b64 = (text: string) => ({ encoding: "base64", content: Buffer.from(text).toString("base64") });
  class WorkflowTransport implements GitHubTransport {
    readonly requests: GitHubTransportRequest[] = [];
    files: Record<string, string> | Error = {};
    async request<T>(request: GitHubTransportRequest): Promise<T> {
      this.requests.push(request);
      const match = /\/contents\/\.github\/workflows(?:\/([^?]+))?\?ref=(.+)$/.exec(request.path);
      if (!match) throw new Error(`unexpected transport path: ${request.path}`);
      if (this.files instanceof Error) throw this.files;
      if (!match[1]) return Object.keys(this.files).map((name) => ({ name, type: "file" })) as T;
      const text = this.files[decodeURIComponent(match[1])];
      if (text === undefined) throw new GitHubTransportError("404 Not Found", 1, "404 Not Found");
      return b64(text) as T;
    }
  }
  const make = (transport: WorkflowTransport, triggers = triggerSet) => new GitHubActionsCiProvider(new GitHubAdapter(transport, "conveyor"), triggers);

  test("a workflow triggered by pull_request, push or pull_request_target (string, list or map) is applicable", async () => {
    for (const on of ["on: pull_request", "on: [push, workflow_dispatch]", "on:\n  pull_request_target:\n    branches: [main]", "on:\n  push:\n    branches: [main]"]) {
      const transport = new WorkflowTransport();
      transport.files = { "ci.yml": `name: CI\n${on}\njobs: {}\n` };
      const result = await make(transport, []).definitions(change, "sha1");
      expect(result).toMatchObject({ defined: true, provable: true });
      expect(result.summary).toContain("ci.yml");
      expect(transport.requests[0]?.path).toBe("repos/owner/repo/contents/.github/workflows?ref=sha1");
    }
  });
  test("workflows that never run for a change are not a definition", async () => {
    const transport = new WorkflowTransport();
    transport.files = { "nightly.yml": "on:\n  schedule:\n    - cron: '0 0 * * *'\njobs: {}\n", "notes.txt": "x", "bad.yml": ": : :\n\t-" };
    const result = await make(transport, []).definitions(change, "sha1");
    expect(result).toMatchObject({ defined: false, provable: true });
  });
  test("a configured trigger whose workflow is present counts as a definition", async () => {
    const transport = new WorkflowTransport();
    transport.files = { "web-e2e.yml": "on: workflow_dispatch\njobs: {}\n" };
    const result = await make(transport).definitions(change, "sha1");
    expect(result).toMatchObject({ defined: true, provable: true });
    expect(result.summary).toContain("run-web-e2e");
  });
  test("a missing workflows directory is provably undefined; other errors are not provable", async () => {
    const missing = new WorkflowTransport();
    missing.files = new GitHubTransportError("404 Not Found", 1, "404 Not Found");
    expect(await make(missing, []).definitions(change, "sha1")).toMatchObject({ defined: false, provable: true });
    const broken = new WorkflowTransport();
    broken.files = new Error("HTTP 502");
    expect(await make(broken, []).definitions(change, "sha1")).toMatchObject({ defined: false, provable: false });
  });
  test("a provable answer is cached per commit; an unprovable one is retried", async () => {
    const transport = new WorkflowTransport();
    transport.files = { "ci.yml": "on: push\njobs: {}\n" };
    const instance = make(transport, []);
    await instance.definitions(change, "sha1");
    const first = transport.requests.length;
    await instance.definitions(change, "sha1");
    expect(transport.requests).toHaveLength(first);
    await instance.definitions(change, "sha2");
    expect(transport.requests.length).toBeGreaterThan(first);
  });
});
