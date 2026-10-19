import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderTaskDocs } from "../../scripts/generate-task-docs";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import { defineGroup, pass, TaskRegistry } from "../../src/tasks/contract";

describe("docs/tasks.md", () => {
  test("matches the generator output", async () => {
    const actual = await readFile(path.join(import.meta.dir, "../../docs/tasks.md"), "utf8");
    if (actual !== renderTaskDocs(createTaskRegistry())) {
      throw new Error("docs/tasks.md is out of date: run `bun run scripts/generate-task-docs.ts`");
    }
  });

  test("documents lease pushes before a change request exists", async () => {
    const [taskDocs, instructions, specification] = await Promise.all([
      readFile(path.join(import.meta.dir, "../../docs/tasks.md"), "utf8"),
      readFile(path.join(import.meta.dir, "../../examples/config/instructions/kaveh.md"), "utf8"),
      readFile(path.join(import.meta.dir, "../../SPEC.md"), "utf8"),
    ]);

    for (const text of [taskDocs, instructions, specification]) {
      expect(text).toContain("workspace.fetch");
      expect(text).toContain("rebase");
    }
    expect(taskDocs).toContain("refs/remotes/origin/<branch>");
    expect(taskDocs).toContain("forceWithLease");
    expect(taskDocs).toContain("fetch the base and feature branch");
    expect(taskDocs).toContain("retaining every published change");
    expect(taskDocs).toContain("retained changes are missing");
    expect(instructions).toContain("refs/remotes/origin/<branch>");
    expect(instructions).toContain("forceWithLease");
    expect(instructions).toContain("A stale lease means the remote moved");
    expect(instructions).toContain("A missing-change refusal means reconcile or reapply");
    expect(specification).toContain("remote branch live");
    expect(specification).toContain("force-with-lease");
    expect(specification).toContain("retaining every published change");
    expect(specification).toContain("published change is missing");
  });

  test("explains the semantics an operator needs", () => {
    const text = renderTaskDocs(new TaskRegistry());
    for (const word of ["load", "check", "act", "tool", "pass", "pending", "fail", "instance id", "implicit", "when", "wait", "onFail", "exit gate"]) {
      expect(text.toLowerCase()).toContain(word.toLowerCase());
    }
    expect(text).toContain("No tasks are registered yet");
  });

  test("renders one table per group", () => {
    const registry = new TaskRegistry();
    registry.register(
      defineGroup("demo", [
        { name: "demo.act", kind: "act", description: "Does it", reads: ["item"], writes: ["agent"], invalidates: ["workspace"], run: () => pass() },
        { name: "demo.gate", kind: "check", description: "Checks it", reads: ["item"], writes: [], invalidates: [], run: () => pass() },
      ]),
    );
    const text = renderTaskDocs(registry);
    expect(text).toContain("### demo");
    expect(text).toContain("| `demo.act` | act | item | writes agent; invalidates workspace | Does it |");
    expect(text).toContain("| `demo.gate` | check | item | - | Checks it |");
  });
});
