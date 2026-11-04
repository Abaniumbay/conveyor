import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const root = path.resolve(import.meta.dir, "../..");
const workflowsDir = path.join(root, ".github/workflows");
const action = "./.github/actions/setup-bubblewrap";

type Step = { uses?: string; run?: string };
type Job = { steps?: Step[] };

const needsBubblewrap = (run: string) => /smoke-test\.ts|\bbun (run check|test)\b/.test(run);

test("every workflow job that runs bun test or the smoke test sets up Bubblewrap first via the shared action", async () => {
  const files = (await readdir(workflowsDir)).filter((file) => /\.ya?ml$/.test(file));
  let checked = 0;
  for (const file of files) {
    const workflow = parse(await readFile(path.join(workflowsDir, file), "utf8")) as { jobs: Record<string, Job> };
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      const first = steps.findIndex((step) => needsBubblewrap(step.run ?? ""));
      if (first < 0) continue;
      checked += 1;
      const setup = steps.findIndex((step) => step.uses === action);
      expect(setup, `${file} job ${name} lacks the Bubblewrap setup step before its tests`).toBeGreaterThanOrEqual(0);
      expect(setup, `${file} job ${name} sets up Bubblewrap after running tests`).toBeLessThan(first);
    }
  }
  expect(checked).toBeGreaterThanOrEqual(3);
});

test("the shared action installs, relaxes AppArmor tolerantly and probes bwrap; workflows keep no inline copy", async () => {
  const definition = parse(await readFile(path.join(root, ".github/actions/setup-bubblewrap/action.yml"), "utf8")) as {
    runs: { using: string; steps: Step[] };
  };
  expect(definition.runs.using).toBe("composite");
  const script = definition.runs.steps.map((step) => step.run ?? "").join("\n");
  expect(script).toContain("set -euo pipefail");
  expect(script).toContain("apt-get install --yes bubblewrap");
  expect(script).toContain("sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true");
  expect(script).toContain("bwrap --unshare-net --dev-bind / / true");

  for (const file of await readdir(workflowsDir)) {
    const text = await readFile(path.join(workflowsDir, file), "utf8");
    expect(text).not.toMatch(/apt-get install[^\n]*bubblewrap|bwrap |apparmor_restrict/);
  }
});

test("both the Check and Release workflows reference the shared action", async () => {
  for (const file of ["check.yml", "release.yml"]) {
    expect(await readFile(path.join(workflowsDir, file), "utf8")).toContain(`uses: ${action}`);
  }
});
