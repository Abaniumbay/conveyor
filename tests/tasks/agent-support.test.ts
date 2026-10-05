import { expect, test } from "bun:test";
import { conveyorToolGuidance, prompt } from "../../src/tasks/agent-support";

test("handoff maps only the current grant, canonicalizing aliases and deduplicating", () => {
  const text = prompt({}, "Implement the issue.", {
    grantedTools: ["workspace.request_push", "workspace.push", "workspace.fetch", "agent.reportProgress"],
  });
  expect(text).toContain("workspace.push → tools.mcp__conveyor__workspace_push");
  expect(text).toContain("workspace.fetch → tools.mcp__conveyor__workspace_fetch");
  expect(text).toContain("agent.reportProgress → tools.mcp__conveyor__agent_reportProgress");
  expect(text).toContain('tool.name.startsWith("mcp__conveyor__")');
  expect(text).toContain("An empty dotted-name search does not establish that tools are unavailable");
  expect(text.match(/workspace.push →/g)).toHaveLength(1);
  expect(text).not.toContain("workspace.request_push →");
  expect(text).not.toContain("change.merge →");
  expect(text).toContain("Do not repeat a previous run's missing-tool claim");
});

test("no grant advertises no callable tools", () => {
  expect(conveyorToolGuidance()).toBe("");
  expect(prompt({}, "Instructions.")).not.toContain("Conveyor tool names:");
});

test("native runs explain supported stops while legacy runs keep their configured statuses", () => {
  expect(prompt({}, "Review.")).toContain("use blocked or rejected");
  expect(prompt({}, "Review.")).toContain("Do not invent status names such as blocked-external");
  expect(prompt({}, "Review.")).toContain("after recording a review finding with change.comment");
  const legacy = prompt({ allowedFailureStatuses: ["needs-intervention", "error"] }, "Check.");
  expect(legacy).toContain("configured failure statuses: needs-intervention, error");
  expect(legacy).not.toContain("use blocked or rejected");
});
