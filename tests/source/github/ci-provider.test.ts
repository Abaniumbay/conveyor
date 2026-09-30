import { describe, expect, test } from "bun:test";
import { GitHubAdapter, GitHubTransportError, type GitHubTransport, type GitHubTransportRequest } from "../../../src/source/github/adapter";
import { GitHubActionsCiProvider } from "../../../src/source/github/ci-provider";
import { ciProviderContract } from "../../app/ci-provider.contract";

class FakeTransport implements GitHubTransport {
  readonly requests: GitHubTransportRequest[] = [];
  workflows = new Set<string>();
  runs: unknown[] = [];
  async request<T>(request: GitHubTransportRequest): Promise<T> {
    this.requests.push(request);
    if (request.path.includes("/pulls/")) return { head: { sha: "commit-1" } } as T;
    if (request.path.includes("/check-runs")) return [{ check_runs: this.runs }] as T;
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
