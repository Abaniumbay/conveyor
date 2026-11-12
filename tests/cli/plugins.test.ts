import { describe, expect, test } from "bun:test";

import { doctorItemSource, type DoctorTransport } from "../../src/cli/plugins";

describe("doctorItemSource", () => {
  test("probes through the given transport", async () => {
    const paths: string[] = [];
    const transport: DoctorTransport = {
      async request<T>(request: { path: string }): Promise<T> {
        paths.push(request.path);
        return { visibility: "public" } as T;
      },
    };
    const source = doctorItemSource(transport, false, "conveyor");
    expect(await source?.repositoryVisibility("owner/my-app")).toBe("public");
    expect(paths).toEqual(["repos/owner/my-app"]);
  });

  test("uses the gh CLI when no transport is given and gh is ready", () => {
    expect(doctorItemSource(undefined, true, "conveyor")).not.toBeNull();
  });

  test("is null when no transport is given and gh is not ready", () => {
    expect(doctorItemSource(undefined, false, "conveyor")).toBeNull();
  });
});
