import { describe, expect, test } from "bun:test";

import { restoreSteps } from "../../scripts/check-agent-egress";

describe("restoreSteps", () => {
  test("uses an empty task-scoped cache for every ecosystem", () => {
    const steps = restoreSteps(["package-lock.json", "pubspec.yaml", "App.csproj", "gradlew", "requirements.txt"], "/scratch");
    expect(steps.map((step) => step.name)).toEqual(["npm", "flutter", "dotnet", "gradle", "pip"]);
    expect(steps[0]!.argv).toEqual(["npm", "ci", "--cache", "/scratch/npm"]);
    expect(steps[1]!.env).toEqual({ PUB_CACHE: "/scratch/pub" });
    expect(steps[2]!.argv).toContain("/scratch/nuget");
    expect(steps[3]!.argv).toEqual(["./gradlew", "--gradle-user-home", "/scratch/gradle", "help"]);
    expect(steps[4]!.argv).toContain("--no-cache-dir");
  });

  test("detects nothing for an unknown project", () => {
    expect(restoreSteps(["README.md"], "/scratch")).toEqual([]);
  });
});
