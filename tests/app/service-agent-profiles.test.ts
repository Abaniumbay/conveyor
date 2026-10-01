import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { referenceConfigDirectory } from "../config/reference-fixture";

const bases: string[] = [];
afterEach(async () => {
  await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

describe("agent profiles in the service", () => {
  test("the dashboard lists every agent and the web dependencies serve their profiles", async () => {
    const { directory, base } = await referenceConfigDirectory();
    bases.push(base);
    const config = await loadConfig(directory);
    const store = await ConveyorStore.open(path.join(base, "conveyor.sqlite"));
    const service = new ConveyorService(config, store, {} as never);

    expect(service.dashboard("csrf").agents).toEqual([
      { id: "darya", name: "Darya", title: "Product Owner" },
      { id: "kaveh", name: "Kaveh", title: "Senior Developer" },
      { id: "omid", name: "Omid", title: "Conveyor Operator" },
      { id: "shirin", name: "Shirin", title: "Senior Reviewer" },
    ]);
    const web = service.webDependencies({} as never, "operator");
    expect((await web.getAgentProfiles()).map((profile) => profile.id)).toEqual(["darya", "kaveh", "omid", "shirin"]);
    expect(await web.getAgentProfile("shirin")).toMatchObject({ name: "Shirin", access: "read-only" });
    expect(await web.getAgentProfile("nobody")).toBeNull();
    store.close();
  });
});
