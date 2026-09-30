import { describe, expect, test } from "bun:test";
import type { CiChange, CiProvider } from "../../src/app/ci-provider";

export interface CiProviderContractFixture {
  provider: CiProvider;
  change: CiChange;
  commit: string;
  didRerun(): boolean;
}

/** Shared behavioral contract for every provider implementation. */
export function ciProviderContract(name: string, createFixture: () => Promise<CiProviderContractFixture>) {
  describe(`${name} CiProvider contract`, () => {
    test("starts, lists neutral runs, reruns capable runs, and reads their logs", async () => {
      const fixture = await createFixture();
      const { provider, change, commit } = fixture;
      expect(await provider.currentCommit(change)).toBe(commit);
      const pending = await provider.start(change, commit, 10_000, 0);
      expect(pending.every((item) => typeof item === "string")).toBe(true);
      const runs = await provider.list(change, commit);
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        if (typeof run.id !== "string" || typeof run.name !== "string" || typeof run.canRerun !== "boolean" || typeof run.hasLog !== "boolean") {
          throw new Error("provider returned a malformed neutral run");
        }
        if (!("queued running passed failed cancelled skipped".split(" ").includes(run.state))) throw new Error("provider returned an unsupported run state");
        if (run.url !== null && typeof run.url !== "string") throw new Error("provider returned a malformed run URL");
      }
      const rerunnable = runs[0];
      if (!rerunnable || rerunnable.canRerun !== true) throw new Error("provider did not expose a rerunnable run");
      await provider.rerun(change, rerunnable!.id);
      expect(fixture.didRerun()).toBe(true);
      expect(await provider.log(change, rerunnable!.id)).toContain("build log");
    });
  });
}
