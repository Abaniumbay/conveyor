import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import { buildAgentProfiles } from "../../src/app/agent-profiles";
import { loadConfig } from "../../src/config/load";
import { referenceConfigDirectory } from "../config/reference-fixture";

const bases: string[] = [];
afterEach(async () => {
  await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

async function reference() {
  const { directory, base } = await referenceConfigDirectory();
  bases.push(base);
  return loadConfig(directory);
}

describe("buildAgentProfiles", () => {
  test("describes every configured agent from the reference configuration", async () => {
    const profiles = await buildAgentProfiles(await reference());
    expect(profiles.map((profile) => profile.id)).toEqual(["darya", "kaveh", "omid", "shaghayegh", "shirin"]);

    const kaveh = profiles.find((profile) => profile.id === "kaveh")!;
    expect(kaveh).toMatchObject({
      name: "Kaveh",
      title: "Senior Developer",
      harness: "codex",
      model: "gpt-6-luna",
      effort: "high",
      access: "workspace-write",
    });
    expect(kaveh.usage).toContainEqual({ pipeline: "delivery", stage: "implementation", role: "runs the stage action" });
    expect(kaveh.usage).toContainEqual({ pipeline: "midgame-delivery", stage: "implementation", role: "runs the stage action" });
    const groups = Object.fromEntries(kaveh.tasks.map((group) => [group.group, group.tasks]));
    expect(groups.workspace).toEqual(["workspace.fetch", "workspace.get", "workspace.push"]);
    expect(groups.change).toContain("change.resolveFinding");
    expect(kaveh.instructions).toContain("Kaveh");
  });

  test("names the steering operator and an agent used nowhere in a pipeline", async () => {
    const config = await reference();
    const omid = (await buildAgentProfiles({ ...config, web: { ...config.web, steering: { agent: "omid", workspace: "/tmp" } } }))
      .find((profile) => profile.id === "omid")!;
    expect(omid.usage).toEqual([{ pipeline: null, stage: null, role: "steers Conveyor from the dashboard" }]);
  });

  test("reports legacy stages and verifier checks for today's configuration shape", async () => {
    const config = await loadConfig(path.resolve(import.meta.dir, "../fixtures/legacy-pipeline"));
    const profiles = await buildAgentProfiles(config, async () => "instructions");
    const darya = profiles.find((profile) => profile.id === "darya")!;
    expect(darya.usage).toContainEqual({ pipeline: "caravan-delivery", stage: "refinement", role: "runs the stage action" });
    const mitra = profiles.find((profile) => profile.id === "mitra")!;
    expect(mitra.usage).toContainEqual({ pipeline: "caravan-delivery", stage: "review", role: "verifies entry and exit (legacy)" });
  });

  test("an unreadable instructions file does not hide the profile", async () => {
    const profiles = await buildAgentProfiles(await reference(), async () => { throw new Error("gone"); });
    expect(profiles.every((profile) => profile.instructions === null)).toBe(true);
  });
});
