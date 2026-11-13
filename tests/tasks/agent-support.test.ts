import { expect, test } from "bun:test";
import { codexToolNameGuidance } from "../../src/plugins/codex/guidance";
import { conveyorToolGuidance, prompt, reportMcpFailures } from "../../src/tasks/agent-support";

const GRANT = ["workspace.request_push", "workspace.push", "workspace.fetch", "agent.reportProgress"];

test("handoff names only the current grant, canonicalizing aliases and deduplicating", () => {
  const text = prompt({}, "Implement the issue.", { grantedTools: GRANT });
  expect(text).toContain("This run is granted: workspace.push, workspace.fetch, agent.reportProgress.");
  expect(text).not.toContain("workspace.request_push");
  expect(text).not.toContain("change.merge");
  expect(text).toContain("An empty dotted-name search does not establish that tools are unavailable");
  expect(text).toContain("Do not repeat a previous run's missing-tool claim");
});

test("handoff without a harness's own lines says nothing about Codex code execution", () => {
  const text = prompt({}, "Implement the issue.", { grantedTools: GRANT });
  expect(text).not.toContain("Codex");
  expect(text).not.toContain("tools.mcp__conveyor__");
  expect(text).not.toContain("ALL_TOOLS");
});

test("the harness's own lines map the canonical grant once", () => {
  const text = prompt({}, "Implement the issue.", { grantedTools: GRANT, toolNameGuidance: codexToolNameGuidance });
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

test("handoff explains pull request descriptions only when the write grant is present", () => {
  expect(conveyorToolGuidance(["change.setMetadata"])).toContain("explain the pull request itself");
  expect(conveyorToolGuidance(["change.get"])).not.toContain("explain the pull request itself");
});

test("native runs explain supported stops while legacy runs keep their configured statuses", () => {
  expect(prompt({}, "Review.")).toContain("use blocked or rejected");
  expect(prompt({}, "Review.")).toContain("Do not invent status names such as blocked-external");
  expect(prompt({}, "Review.")).toContain("existing finding from change.listFindings that you verified still applies");
  expect(prompt({}, "Review.")).toContain("do not create duplicate findings");
  const legacy = prompt({ allowedFailureStatuses: ["needs-intervention", "error"] }, "Check.");
  expect(legacy).toContain("configured failure statuses: needs-intervention, error");
  expect(legacy).not.toContain("use blocked or rejected");
});

test("a failed MCP server is noted once however often the failure is observed", () => {
  const events: unknown[] = [];
  const messages: string[] = [];
  const store = {
    appendRunEvent: (_run: string, type: string, payload: unknown) => { events.push({ type, payload }); },
    appendConversationMessage: (m: { message: string }) => { messages.push(m.message); },
  } as never;
  reportMcpFailures(store, {
    issueId: "i", stageId: "s", runId: "r", agentId: "kaveh",
    failures: [{ server: "serena", detail: "first" }, { server: "serena", detail: "again" }, { server: "other", detail: "x" }],
  });
  expect(messages).toHaveLength(2);
  expect(messages[0]).toContain("`serena`");
  expect(events).toHaveLength(2);
});

test("no MCP failures post nothing", () => {
  const store = { appendRunEvent: () => { throw new Error("no"); }, appendConversationMessage: () => { throw new Error("no"); } } as never;
  reportMcpFailures(store, { issueId: "i", stageId: "s", runId: "r", agentId: "a", failures: [] });
});
