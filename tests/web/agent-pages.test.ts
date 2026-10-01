import { describe, expect, test } from "bun:test";

import { renderAgentList, renderAgentProfile } from "../../src/web/agent-pages";
import type { AgentProfileViewModel } from "../../src/web/types";

const kaveh: AgentProfileViewModel = {
  id: "kaveh",
  name: "Kaveh",
  title: "Senior Developer",
  harness: "codex",
  model: "gpt-6-luna",
  effort: "high",
  access: "workspace-write",
  usage: [{ pipeline: "delivery", stage: "implementation", role: "runs the stage action" }],
  tasks: [{ group: "workspace", tasks: ["workspace.fetch", "workspace.push"] }],
  instructions: "You are <Kaveh>.",
};

describe("agent pages", () => {
  test("the list links every agent to its profile", () => {
    const html = renderAgentList([kaveh, { ...kaveh, id: "darya", name: "Darya", title: "Product Owner" }]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('href="/agents/kaveh"');
    expect(html).toContain('href="/agents/darya"');
    expect(html).toContain("Product Owner");
  });

  test("a profile shows identity, configuration, usage, grants and escaped instructions", () => {
    const html = renderAgentProfile(kaveh);
    expect(html).toContain('<span class="agent-page-title">Kaveh</span>');
    expect(html).toContain("Senior Developer");
    expect(html).toContain("gpt-6-luna");
    expect(html).toContain("workspace-write");
    expect(html).toContain("delivery");
    expect(html).toContain("implementation");
    expect(html).toContain("workspace.push");
    expect(html).toContain("You are &lt;Kaveh");
    expect(html).not.toContain("<Kaveh>");
    expect(html).toContain('href="/agents"');
    expect(html).toContain('class="mini-line"');
    expect(html).toContain("<span>Implementation</span>");
  });

  test("a profile is read-only: no forms or buttons", () => {
    const html = renderAgentProfile(kaveh);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });

  test("missing optional facts render as not set", () => {
    const html = renderAgentProfile({ ...kaveh, model: null, effort: null, usage: [], instructions: null });
    expect(html).toContain("Harness default");
    expect(html).toContain("Not used by any pipeline stage.");
    expect(html).toContain("Instructions could not be read.");
  });
});
