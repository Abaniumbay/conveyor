// The confined launch of pi under a real bwrap: pi's package and interpreter are mounted read-only,
// its private agent directory is in the run's home, and nothing else of the service is visible.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runPi } from "../../../src/plugins/pi/pi";
import { bwrapUnavailableReason } from "../../support/bwrap";
import { VALID_RESULT, installFakePi } from "../../support/fake-pi";
import { shortTemporaryDirectory } from "../../support/short-temporary-directory";

const directories: string[] = [];
const unavailable = bwrapUnavailableReason();
if (unavailable) console.warn(`SKIPPED pi filesystem tests: \`bwrap\` is unavailable (${unavailable})`);
const describeSandbox = unavailable ? describe.skip : describe;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// Checks what the confined pi process sees, then runs a command the way pi's bash tool does
// (its settings' shell, the prefix and the command joined by a newline) and returns a result.
const FAKE_PI = `
import { existsSync, readFileSync } from "node:fs";
const checks = JSON.parse(process.env.CHECKS);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const seen = {};
for (const [name, file] of Object.entries(checks.files)) seen[name] = existsSync(file);
seen.packageManifest = existsSync(checks.packageManifest);
seen.cwd = process.cwd();
seen.workspace = readFileSync(checks.workspace + "/own-marker", "utf8");
try { await Bun.write(checks.workspace + "/write-marker", "x"); seen.workspaceWritable = true; } catch { seen.workspaceWritable = false; }
seen.privateLogin = readFileSync(agentDir + "/auth.json", "utf8");
seen.processCredential = process.env.EXAMPLE_API_KEY ?? null;
const settings = JSON.parse(readFileSync(agentDir + "/settings.json", "utf8"));
const command = Bun.spawnSync([settings.shellPath, "-c", settings.shellCommandPrefix + "\\nprintf '%s|%s' \\"$EXAMPLE_API_KEY\\" \\"$PI_CODING_AGENT_DIR\\""]);
seen.commandSees = command.stdout.toString();
await Bun.write(checks.capture, JSON.stringify(seen));
await Bun.stdin.text();
console.log(JSON.stringify({ type: "session", version: 3, id: "fs-1", timestamp: "2026-11-13T10:00:00.000Z", cwd: checks.workspace }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(${JSON.stringify(VALID_RESULT)}) }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }));
`;

async function fixture() {
  const root = await shortTemporaryDirectory("conveyor-pifs-", { visibleInSandbox: true });
  directories.push(root);
  const install = path.join(root, "install");
  const { command, packageRoot } = await installFakePi(install, FAKE_PI);
  const workspace = path.join(root, "workspace");
  const service = path.join(root, "service-pi");
  const conveyorHome = path.join(root, "conveyor-home");
  const otherRun = path.join(root, "artifacts", "other-run");
  const artifacts = path.join(root, "artifacts", "run");
  await Promise.all([workspace, service, conveyorHome, otherRun, artifacts].map((directory) => mkdir(directory, { recursive: true })));
  await Promise.all([
    writeFile(path.join(workspace, "own-marker"), "own worktree"),
    writeFile(path.join(service, "auth.json"), '{"login":"service"}'),
    writeFile(path.join(service, "service-marker"), "hidden"),
    writeFile(path.join(conveyorHome, "home-marker"), "hidden"),
    writeFile(path.join(otherRun, "artifact-marker"), "hidden"),
    writeFile(path.join(install, "lib", "node_modules", "sibling-marker"), "hidden"),
  ]);
  const capture = path.join(artifacts, "capture.json");
  return {
    command, workspace, service, artifacts, capture,
    checks: {
      capture, workspace,
      packageManifest: path.join(packageRoot, "package.json"),
      files: {
        serviceAgentDirectory: path.join(service, "service-marker"),
        conveyorHome: path.join(conveyorHome, "home-marker"),
        otherRun: path.join(otherRun, "artifact-marker"),
        packageSibling: path.join(install, "lib", "node_modules", "sibling-marker"),
      },
    },
  };
}

describeSandbox("pi filesystem confinement", () => {
  for (const sandbox of ["read-only", "workspace-write"] as const) {
    test(`a ${sandbox} pi sees its package, its private login and its run's paths only, and its commands lose its credentials`, async () => {
      const f = await fixture();
      const result = await runPi({
        command: f.command, workspace: f.workspace, artifactsDirectory: f.artifacts, prompt: "verify",
        sandbox, automaticApprovals: false, mcp: { command: "bun", args: ["x"] },
        runner: { type: "pi", command: f.command, credentialVariables: ["EXAMPLE_API_KEY"] } as never,
        env: { PI_CODING_AGENT_DIR: f.service, CHECKS: JSON.stringify(f.checks), EXAMPLE_API_KEY: "provider-key" },
      });
      expect(result).toMatchObject({ sessionId: "fs-1", stageResult: { status: "done" } });
      const seen = JSON.parse(await readFile(f.capture, "utf8"));
      expect(seen.packageManifest).toBe(true);
      expect(seen.cwd).toBe(f.workspace);
      expect(seen.workspace).toBe("own worktree");
      expect(seen.workspaceWritable).toBe(sandbox === "workspace-write");
      expect(seen.privateLogin).toBe('{"login":"service"}');
      expect(seen.serviceAgentDirectory).toBe(false);
      expect(seen.conveyorHome).toBe(false);
      expect(seen.otherRun).toBe(false);
      expect(seen.packageSibling).toBe(false);
      expect(seen.processCredential).toBe("provider-key");
      expect(seen.commandSees).toBe("|");
    });
  }
});
