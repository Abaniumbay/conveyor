import { readFile } from "node:fs/promises";

import type { ConveyorConfig } from "../config/load";
import { isNativeStage } from "../config/schema";
import type { AgentProfileViewModel, AgentUsageViewModel } from "../web/types";

function displayName(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

/** Where each agent appears in the configured pipelines, plus dashboard steering. */
function usageOf(config: ConveyorConfig, agentId: string): AgentUsageViewModel[] {
  const usage: AgentUsageViewModel[] = [];
  for (const [pipelineId, pipeline] of Object.entries(config.pipelines)) {
    for (const stage of pipeline.stages) {
      if (isNativeStage(stage)) {
        for (const entry of [...stage.actions, ...stage.exitGate]) {
          if (entry.task !== "agent.run") continue;
          const configured = entry.with as { agent?: unknown; agents?: unknown } | undefined;
          // `agents` is an order of preference: the next runs when one's harness cannot.
          const listed = Array.isArray(configured?.agents) ? configured.agents as unknown[] : [configured?.agent];
          const position = listed.indexOf(agentId);
          if (position === 0) usage.push({ pipeline: pipelineId, stage: stage.id, role: "runs the stage action" });
          else if (position > 0) usage.push({ pipeline: pipelineId, stage: stage.id, role: `runs the stage action when ${String(listed[position - 1])} cannot` });
        }
        continue;
      }
      if (stage.run.type === "agent" && stage.run.agent === agentId) {
        usage.push({ pipeline: pipelineId, stage: stage.id, role: "runs the stage action" });
      }
      const verifies = (check: string | undefined) => Boolean(check && config.checks[check]?.verifier === agentId);
      const enter = verifies(stage.enterCheck);
      const exit = verifies(stage.exitCheck);
      if (enter || exit) {
        const role = enter && exit ? "verifies entry and exit (legacy)" : enter ? "verifies stage entry (legacy)" : "verifies stage exit (legacy)";
        usage.push({ pipeline: pipelineId, stage: stage.id, role });
      }
    }
  }
  if (config.web.steering?.agent === agentId) {
    usage.push({ pipeline: null, stage: null, role: "steers Conveyor from the dashboard" });
  }
  return usage;
}

function groupTasks(tasks: readonly string[]): AgentProfileViewModel["tasks"] {
  const groups = new Map<string, string[]>();
  for (const task of [...new Set(tasks)].sort()) {
    const group = task.split(".")[0] ?? task;
    groups.set(group, [...(groups.get(group) ?? []), task]);
  }
  return [...groups].map(([group, names]) => ({ group, tasks: names }));
}

/** Read-only profiles of every configured agent, sorted by id. */
export async function buildAgentProfiles(
  config: ConveyorConfig,
  readInstructions: (file: string) => Promise<string> = (file) => readFile(file, "utf8"),
): Promise<AgentProfileViewModel[]> {
  const ids = Object.keys(config.agents).sort();
  return Promise.all(ids.map(async (id) => {
    const agent = config.agents[id]!;
    const instructions = await readInstructions(agent.instructions).catch(() => null);
    return {
      id,
      name: agent.name ?? displayName(id),
      title: agent.title ?? "AI Agent",
      harness: agent.runner,
      model: agent.model ?? null,
      effort: agent.effort ?? null,
      access: agent.workspaceAccess,
      usage: usageOf(config, id),
      tasks: groupTasks(agent.tasks),
      instructions,
    };
  }));
}
