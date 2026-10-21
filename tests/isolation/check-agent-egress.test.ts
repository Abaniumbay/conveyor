import { describe, expect, test } from "bun:test";

import { checkPassed, dockerSocketChecks, localServiceChecks, restoreSteps } from "../../scripts/check-agent-egress";

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

describe("local service and Docker checks", () => {
  test("probes each configured service at its sandbox endpoint", () => {
    const checks = localServiceChecks([
      { name: "postgres", endpoint: "127.0.0.1:5432" },
      { name: "redis", endpoint: "127.0.0.1:6379" },
    ]);
    expect(checks.map((check) => check.argv.at(-1))).toEqual(["exec 3<>/dev/tcp/127.0.0.1/5432", "exec 3<>/dev/tcp/127.0.0.1/6379"]);
    expect(checks.map((check) => check.name)).toEqual([
      "local service postgres is reachable at 127.0.0.1:5432",
      "local service redis is reachable at 127.0.0.1:6379",
    ]);
    expect(checks.every((check) => !check.expectFailure)).toBe(true);
  });

  test("an unreachable service fails its check", () => {
    const [check] = localServiceChecks([{ name: "postgres", endpoint: "127.0.0.1:5432" }]);
    expect(checkPassed(check!, 1)).toBe(false);
    expect(checkPassed(check!, 0)).toBe(true);
  });

  test("a successful Docker socket connection fails the check", () => {
    const checks = dockerSocketChecks();
    expect(checks.map((check) => check.argv)).toEqual([
      expect.arrayContaining(["--unix-socket", "/var/run/docker.sock"]),
      expect.arrayContaining(["--unix-socket", "/run/docker.sock"]),
    ]);
    for (const check of checks) {
      expect(checkPassed(check, 0)).toBe(false);
      expect(checkPassed(check, 7)).toBe(true);
    }
  });

  test("no local services adds no service checks", () => {
    expect(localServiceChecks([])).toEqual([]);
  });
});
