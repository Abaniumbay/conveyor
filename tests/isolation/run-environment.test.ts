import { describe, expect, test } from "bun:test";

import { defaultRunVariables, environmentSettingsSchema, resolveRunEnvironment, runContextVariables } from "../../src/isolation/run-environment";

describe("resolveRunEnvironment", () => {
  const service = { PATH: "/usr/bin", LANG: "C", NPM_TOKEN: "from-service", GH_TOKEN: "service-token" };

  test("takes exactly the listed variables: a value as written, an empty value from the service", () => {
    const { variables } = resolveRunEnvironment([{ values: { PATH: null, NPM_TOKEN: null, MODE: "fast" } }], service);
    expect(variables).toEqual({ PATH: "/usr/bin", NPM_TOKEN: "from-service", MODE: "fast" });
  });

  test("sets nothing for an empty value the service does not have", () => {
    expect(resolveRunEnvironment([{ values: { MISSING: null } }], service).variables).toEqual({});
  });

  test("filters no name: a listed credential reaches the run", () => {
    expect(resolveRunEnvironment([{ values: { GH_TOKEN: null } }], service).variables).toEqual({ GH_TOKEN: "service-token" });
  });

  test("the last level that defines a name wins", () => {
    const { variables } = resolveRunEnvironment([
      { values: { MODE: "root", LANG: null } },
      { values: { MODE: "repository" } },
      { values: { MODE: "agent" } },
    ], service);
    expect(variables).toEqual({ MODE: "agent", LANG: "C" });
  });

  test("a name whose winning definition is the harness level is for the program only", () => {
    const result = resolveRunEnvironment([
      { values: { PATH: null, SHARED: "root" } },
      { values: { API_KEY: "k", SHARED: "harness" }, program: true },
      { values: { SHARED: "agent" } },
    ], service);
    expect(result.variables).toEqual({ PATH: "/usr/bin", API_KEY: "k", SHARED: "agent" });
    expect(result.programVariables).toEqual(["API_KEY"]);
  });
});

describe("defaultRunVariables", () => {
  test("is the root default's variables from the service, and nothing else", () => {
    expect(defaultRunVariables({ PATH: "/usr/bin", LANG: "C", HOME: "/home/real", GH_TOKEN: "t", SHELL: "/opt/login-shell" })).toEqual({ PATH: "/usr/bin", LANG: "C" });
  });
});

describe("environmentSettingsSchema", () => {
  test("refuses the variables Conveyor sets for every run", () => {
    for (const name of ["HOME", "SHELL", "TMPDIR", "CONVEYOR_ITEM_ID"]) {
      expect(environmentSettingsSchema.safeParse({ [name]: "x" }).success).toBe(false);
    }
  });

  test("keeps an empty value and writes numbers and booleans as text", () => {
    expect(environmentSettingsSchema.parse({ A: null, PORT: 5432, DEBUG: true })).toEqual({ A: null, PORT: "5432", DEBUG: "true" });
  });
});

describe("runContextVariables", () => {
  test("names the run and what it is part of", () => {
    expect(runContextVariables({ runId: "r1", repositoryId: "app", itemId: "42", stageId: "review", agentId: "laleh" })).toEqual({
      CONVEYOR_RUN_ID: "r1", CONVEYOR_REPOSITORY_ID: "app", CONVEYOR_ITEM_ID: "42", CONVEYOR_STAGE_ID: "review", CONVEYOR_AGENT_ID: "laleh",
    });
    expect(runContextVariables({ runId: "r2", agentId: "operator" })).toEqual({ CONVEYOR_RUN_ID: "r2", CONVEYOR_AGENT_ID: "operator" });
  });
});
