import { describe, expect, test } from "bun:test";

import { remainingWorkStartsProcess } from "../../src/engine/remaining-work";

const stage = {
  actions: [
    { id: "implement", task: "agent.run" },
    { id: "runScript", task: "script.run" },
    { id: "refresh", task: "ci.await" },
  ],
  exitGate: [{ id: "ciGate", task: "ci.passed" }],
};

describe("remainingWorkStartsProcess", () => {
  test("is false once the cursor is in an exit gate of checks", () => {
    expect(remainingWorkStartsProcess(stage, { list: "exit-gate", taskInstanceId: null })).toBe(false);
    expect(remainingWorkStartsProcess(stage, { list: "exit-gate", taskInstanceId: "ciGate" })).toBe(false);
  });

  test("is false when only check actions remain", () => {
    expect(remainingWorkStartsProcess(stage, { list: "actions", taskInstanceId: "refresh" })).toBe(false);
  });

  test("is true while an agent or script action is not yet done", () => {
    expect(remainingWorkStartsProcess(stage, { list: "actions", taskInstanceId: null })).toBe(true);
    expect(remainingWorkStartsProcess(stage, { list: "actions", taskInstanceId: "entry-approval" })).toBe(true);
    expect(remainingWorkStartsProcess(stage, { list: "actions", taskInstanceId: "implement" })).toBe(true);
    expect(remainingWorkStartsProcess(stage, { list: "actions", taskInstanceId: "runScript" })).toBe(true);
  });

  test("is true for a script or agent step in the exit gate, a missing cursor or an unknown task", () => {
    expect(remainingWorkStartsProcess({ actions: [], exitGate: [{ id: "s", task: "script.run" }] }, { list: "exit-gate", taskInstanceId: null })).toBe(true);
    expect(remainingWorkStartsProcess(stage, null)).toBe(true);
    expect(remainingWorkStartsProcess(stage, { list: "actions", taskInstanceId: "gone" })).toBe(true);
  });
});
