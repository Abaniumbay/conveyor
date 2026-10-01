import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { loadConfig, type ConveyorConfig } from "../../src/config/load";
import { referenceConfigDirectory } from "./reference-fixture";

const bases: string[] = [];
afterEach(async () => {
  await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

async function loadReference(): Promise<ConveyorConfig> {
  const { directory, base } = await referenceConfigDirectory();
  bases.push(base);
  return loadConfig(directory);
}

const EXAMPLES = path.resolve(import.meta.dir, "../../examples");

describe("reference configuration", () => {
  test("loads and compiles a plan for all five repositories", async () => {
    const config = await loadReference();
    expect(config.plans.map((plan) => plan.repositoryId).sort()).toEqual(["caravan", "conveyor", "meal-planner", "midgame", "quesshi"]);
    expect(config.plans.find((plan) => plan.repositoryId === "midgame")!.id).toBe("midgame-delivery");
    expect(config.plans.find((plan) => plan.repositoryId === "caravan")!.id).toBe("delivery");
    for (const plan of config.plans) expect(plan.stages.map((stage) => stage.id)).toEqual(["refinement", "implementation", "review", "merge", "deploy", "verify", "cleanup"]);
  });

  test("has no AI verifier, no checks and no legacy stages", async () => {
    const config = await loadReference();
    expect(config.checks).toEqual({});
    expect(Object.keys(config.agents).sort()).toEqual(["darya", "kaveh", "omid", "shirin"]);
    for (const pipeline of Object.values(config.pipelines)) for (const stage of pipeline.stages) expect("run" in stage).toBe(false);
    for (const plan of config.plans) {
      for (const stage of plan.stages) {
        expect(stage.legacy).toBe(false);
        for (const task of [...stage.actions, ...stage.exitGate]) {
          expect(task.task).not.toMatch(/^legacy\.|verify/);
        }
      }
    }
  });

  test("every native stage has a non-empty exit gate", async () => {
    const config = await loadReference();
    for (const plan of config.plans) for (const stage of plan.stages) expect(stage.exitGate.length).toBeGreaterThan(0);
  });

  test("every script.run declares its recovery mode, and conveyor's deploy is replay-safe", async () => {
    const config = await loadReference();
    const scripts = config.plans.flatMap((plan) =>
      plan.stages.flatMap((stage) => stage.actions.filter((task) => task.task === "script.run").map((task) => ({ plan, stage, task }))),
    );
    expect(scripts.length).toBeGreaterThanOrEqual(11);
    for (const { task } of scripts) expect(["replay-safe", "reconcile"]).toContain(task.with.recovery as string);
    const deploy = (repository: string) =>
      scripts.find(({ plan, stage }) => plan.repositoryId === repository && stage.id === "deploy")!.task;
    expect(deploy("conveyor").with.recovery).toBe("replay-safe");
    expect(String(deploy("conveyor").with.script)).toContain("skip-conveyor-self-deploy");
    for (const repository of ["caravan", "meal-planner", "midgame", "quesshi"]) expect(deploy(repository).with.recovery).toBe("reconcile");
  });

  test("CI follows each repository's mode: disabled for caravan and meal-planner, required elsewhere", async () => {
    const config = await loadReference();
    const gates = (repository: string) => {
      const plan = config.plans.find((candidate) => candidate.repositoryId === repository)!;
      const implementation = plan.stages.find((stage) => stage.id === "implementation")!;
      return {
        actions: implementation.actions.map((task) => task.id),
        gate: implementation.exitGate.map((task) => task.id),
        review: plan.stages.find((stage) => stage.id === "review")!.exitGate.map((task) => task.id),
      };
    };
    for (const repository of ["caravan", "meal-planner"]) {
      expect(config.repositories[repository]!.ci.mode).toBe("disabled");
      const { actions, gate, review } = gates(repository);
      expect(actions).not.toContain("startCi");
      expect(gate).not.toContain("ciGate");
      expect(review).not.toContain("ciHead");
    }
    for (const repository of ["conveyor", "midgame", "quesshi"]) {
      expect(config.repositories[repository]!.ci.mode).toBe("required");
      const { actions, gate, review } = gates(repository);
      expect(actions).toContain("startCi");
      expect(gate).toEqual(expect.arrayContaining(["ciDefined", "ciGate"]));
      expect(review).toContain("ciHead");
    }
  });

  test("every repository restricts agent egress", async () => {
    const config = await loadReference();
    for (const repository of Object.values(config.repositories)) {
      expect(repository.agentEgress?.allowLoopbackMcp).toBe(true);
      expect(repository.agentEgress?.httpsHosts.length).toBeGreaterThan(0);
    }
  });

  test("shared reference files declare no repositories, settings or checks, so they import cleanly", async () => {
    const dir = path.join(EXAMPLES, "config");
    const files = (await readdir(dir, { recursive: true })).filter((file) => /\.ya?ml$/i.test(file));
    expect(files.sort()).toEqual(["agents.yaml", "pipeline.yaml", "providers.yaml"]);
    for (const file of files) {
      const document = parse(await readFile(path.join(dir, file), "utf8")) as Record<string, unknown>;
      for (const key of ["repositories", "settings", "checks", "web", "import"]) expect(document).not.toHaveProperty(key);
    }
  });

  test("the agent instructions name no verifier and use only canonical task names", async () => {
    const dir = path.join(EXAMPLES, "config/instructions");
    for (const agent of ["darya", "kaveh", "shirin", "omid"]) {
      const text = await readFile(path.join(dir, `${agent}.md`), "utf8");
      expect(text).not.toMatch(/mitra|verifier/i);
      expect(text).not.toMatch(/\b(source|run|delivery)\.[a-z]+_[a-z_]+|workspace\.(request|get_)\w*/);
    }
  });

  test("the instructions mention the tasks each agent is granted to do its new duties", async () => {
    const config = await loadReference();
    const read = (agent: string) => readFile(path.join(EXAMPLES, "config/instructions", `${agent}.md`), "utf8");
    const mentions = async (agent: string, names: string[]) => {
      const text = await read(agent);
      for (const name of names) {
        expect(text).toContain(name);
        expect(config.agents[agent]!.tasks).toContain(name);
      }
    };
    await mentions("darya", ["item.setCriteria", "item.setSystemLabels", "item.setDependencies", "item.createChild"]);
    await mentions("kaveh", ["workspace.push", "workspace.fetch", "ci.getLogs", "change.resolveFinding", "change.listFindings"]);
    await mentions("shirin", ["change.comment", "change.checkCriterion", "change.listFindings", "change.resolveFinding"]);
  });
});
