import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";

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
    expect(Object.keys(config.agents).sort()).toEqual(["darya", "jamshid", "kaveh", "omid", "shaghayegh", "shirin"]);
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

  test("Omid receives the allowlisted Operator skill and no broader board controls", async () => {
    const config = await loadReference();
    const omid = config.agents.omid!;
    expect([...omid.tasks].sort()).toEqual([
      "agent.reportBlocker", "agent.reportMilestone", "agent.reportProgress", "agent.reportRationale", "agent.reportResult",
      "operator.getBoard", "operator.getItemHistory", "operator.moveBacklogItem", "operator.retryItem",
    ]);
    expect(await readFile(path.join(EXAMPLES, "config/agents.yaml"), "utf8")).toContain("instructions: ../../skills/conveyor-operator/SKILL.md");
    expect(await readFile(path.resolve(EXAMPLES, "../skills/conveyor-operator/SKILL.md"), "utf8")).toContain("Inspect first, before mutation.");
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
    for (const file of ["darya", "kaveh", "reviewer", "omid"]) {
      const text = await readFile(path.join(dir, `${file}.md`), "utf8");
      expect(text).not.toMatch(/mitra|verifier/i);
      expect(text).not.toMatch(/\b(source|run|delivery)\.[a-z]+_[a-z_]+|workspace\.(request|get_)\w*/);
    }
  });

  test("reviews go to Shaghayegh on Claude Code first, then Shirin on Codex; a writable Claude agent without network is refused", async () => {
    const config = await loadReference();
    expect(config.runners[config.agents.shaghayegh!.runner]!.type).toBe("claude-code");
    expect(config.runners[config.agents.shirin!.runner]!.type).toBe("codex");
    const { directory, base } = await referenceConfigDirectory();
    bases.push(base);
    const agentsFile = path.join(directory, "agents.yaml");
    const agents = parse(await readFile(agentsFile, "utf8")) as { agents: Record<string, { access?: string }> };
    agents.agents.shaghayegh!.access = "workspace-write";
    await writeFile(agentsFile, stringify(agents));
    await expect(loadConfig(directory)).rejects.toThrow("agents.shaghayegh runs on Claude Code with access: workspace-write, which needs network: true");
  });

  test("Kaveh compacts long sessions, and Kaveh and Darya get a code index limited to lookups", async () => {
    const config = await loadReference();
    expect(config.agents.kaveh!.codexConfig).toEqual({ model_auto_compact_token_limit: 80000 });
    const editingOrShell = /create|replace|insert|delete|rename|write|edit|execute|shell|onboarding|activate/;
    for (const agent of ["kaveh", "darya"]) {
      const serena = config.agents[agent]!.mcpServers.serena!;
      expect(serena.args).toContain("{workspace}");
      expect(serena.gitExclude).toEqual([".serena/"]);
      expect(serena.enabledTools).toContain("find_symbol");
      expect(serena.enabledTools!.filter((tool) => editingOrShell.test(tool))).toEqual([]);
    }
  });

  test("a Claude Code agent with codexConfig is refused", async () => {
    const { directory, base } = await referenceConfigDirectory();
    bases.push(base);
    const agentsFile = path.join(directory, "agents.yaml");
    const agents = parse(await readFile(agentsFile, "utf8")) as { agents: Record<string, Record<string, unknown>> };
    agents.agents.shaghayegh!.codexConfig = { model_auto_compact_token_limit: 1 };
    await writeFile(agentsFile, stringify(agents));
    await expect(loadConfig(directory)).rejects.toThrow("agents.shaghayegh runs on Claude Code, which does not take codexConfig");
  });

  test("implementation falls back from Kaveh on Codex to Jamshid on Claude Code (Haiku), with the same tools and worktree access", async () => {
    const config = await loadReference();
    const jamshid = config.agents.jamshid!;
    const kaveh = config.agents.kaveh!;
    expect(config.runners[jamshid.runner]!.type).toBe("claude-code");
    expect(jamshid).toMatchObject({ name: "Jamshid", model: "claude-haiku-4-5-20251001", workspaceAccess: "workspace-write", network: true });
    expect(jamshid.instructions).toBe(kaveh.instructions);
    expect([...jamshid.tasks].sort()).toEqual([...kaveh.tasks].sort());
    expect(jamshid.writableRoots).toEqual(kaveh.writableRoots);
    expect(jamshid.mcpServers.serena!.args).toContain("--context=claude-code");
    for (const pipeline of Object.values(config.pipelines)) {
      for (const stage of pipeline.stages) {
        if (stage.id !== "implementation" || !("actions" in stage)) continue;
        const implement = (stage.actions as Array<{ id: string; with?: { agents?: string[] } }>).find((action) => action.id === "implement");
        expect(implement?.with?.agents).toEqual(["kaveh", "jamshid"]);
      }
    }
  });

  test("the instructions mention the tasks each agent is granted to do its new duties", async () => {
    const config = await loadReference();
    const read = (agent: string) => readFile(config.agents[agent]!.instructions, "utf8");
    const mentions = async (agent: string, names: string[]) => {
      const text = await read(agent);
      for (const name of names) {
        expect(text).toContain(name);
        expect(config.agents[agent]!.tasks).toContain(name);
      }
    };
    await mentions("darya", ["item.setTitle", "item.setCriteria", "item.setSystemLabels", "item.setDependencies", "item.createChild"]);
    await mentions("kaveh", ["todo.get", "todo.set", "todo.update", "workspace.push", "workspace.fetch", "ci.getLogs", "change.resolveFinding", "change.listFindings"]);
    for (const reviewer of ["shaghayegh", "shirin"]) {
      await mentions(reviewer, ["change.comment", "change.checkCriterion", "change.listFindings", "change.resolveFinding"]);
    }
  });
});

describe("canary: reference import combined with converted legacy sections", () => {
  /** The conversion docs/migration.md describes, applied to tests/fixtures/legacy-pipeline. */
  async function legacyConverted(): Promise<string> {
    const dir = path.resolve(import.meta.dir, "../fixtures/legacy-pipeline");
    const docs = await Promise.all(
      ["10-agents.yaml", "20-pipeline.yaml", "30-repositories.yaml"].map(async (file) => parse(await readFile(path.join(dir, file), "utf8")) as Record<string, any>),
    );
    const [agentsDoc, pipelineDoc, repositoriesDoc] = docs as [Record<string, any>, Record<string, any>, Record<string, any>];
    // 1. Rename the four legacy agents that collide with the reference agents; mitra and checks stay.
    const renamed = new Map(["darya", "kaveh", "shirin", "omid"].map((name) => [name, `${name}-legacy`]));
    const agents: Record<string, unknown> = {};
    for (const [name, agent] of Object.entries(agentsDoc.agents)) agents[renamed.get(name) ?? name] = agent;
    // 2. Update every run.agent in the legacy pipelines.
    for (const pipeline of Object.values<any>(pipelineDoc.pipelines)) {
      for (const stage of pipeline.stages) {
        if (stage.run?.agent && renamed.has(stage.run.agent)) stage.run.agent = renamed.get(stage.run.agent);
      }
    }
    // 3. The legacy pipeline named like a reference pipeline (midgame-delivery) is renamed, and its repository follows.
    pipelineDoc.pipelines["midgame-delivery-legacy"] = pipelineDoc.pipelines["midgame-delivery"];
    delete pipelineDoc.pipelines["midgame-delivery"];
    repositoriesDoc.repositories.midgame.pipeline = "midgame-delivery-legacy";
    // 4. The migrated repository (conveyor) comes from the reference; the rest stay legacy.
    delete repositoriesDoc.repositories["conveyor-v2"];
    // sources, runners, labels and settings are dropped: the import provides the same names and labels.
    return stringify({ agents, checks: agentsDoc.checks, ...pipelineDoc, ...repositoriesDoc });
  }

  test("loads and compiles every repository", async () => {
    const { directory, base } = await referenceConfigDirectory();
    bases.push(base);
    const local = parse(await readFile(path.join(directory, "local.yaml"), "utf8")) as { repositories: Record<string, unknown> };
    for (const id of Object.keys(local.repositories)) if (id !== "conveyor") delete local.repositories[id];
    await writeFile(path.join(directory, "local.yaml"), stringify(local));
    await writeFile(path.join(directory, "legacy.yaml"), await legacyConverted());
    const config = await loadConfig(directory);
    expect(config.plans.map((plan) => plan.repositoryId).sort()).toEqual(["caravan-v2", "conveyor", "meal-planner", "midgame", "quesshi"]);
    const byId = (id: string) => config.plans.find((plan) => plan.repositoryId === id)!;
    expect(byId("conveyor").stages.every((stage) => !stage.legacy)).toBe(true);
    expect(byId("quesshi").stages.some((stage) => stage.legacy)).toBe(true);
    expect(config.agents["kaveh-legacy"]).toBeDefined();
    expect(config.agents.kaveh!.instructions).toContain("instructions/kaveh.md");
  });
});
