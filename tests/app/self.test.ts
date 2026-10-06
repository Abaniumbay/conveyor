import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { scriptInterpreters } from "../../src/cli/commands/doctor";
import type { ConveyorConfig } from "../../src/config/load";
import { writeOutputSchema } from "../../src/runner/output-schemas";
import { DEFAULT_SCRIPT_INTERPRETER, INTERNAL, scriptCommand, selfCommand } from "../../src/self";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("helper processes", () => {
  test("from a checkout, internal subcommands re-run src/cli.ts with this Bun", () => {
    expect(selfCommand(INTERNAL.mcp, "--context", "/c.json")).toEqual([
      process.execPath, path.resolve(import.meta.dir, "../../src/cli.ts"), "__mcp", "--context", "/c.json",
    ]);
  });

  test("the packaged MCP server starts as `conveyor __mcp` and lists only the granted tools", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-self-"));
    directories.push(directory);
    const context = path.join(directory, "context.json");
    await writeFile(context, JSON.stringify({
      version: 1, runId: "r1", stageId: "steering",
      repository: { id: "conveyor-system", address: "conveyor/system", baseBranch: "main" },
      issue: { id: "steering:r1", number: 1, title: "t", body: "", labels: [], url: "http://127.0.0.1:1/" },
      workspace: { path: directory, branch: "steering" },
      delivery: { pullRequest: null, checks: [] },
      sourceGuidance: "",
      control: { url: "http://127.0.0.1:1/internal/mcp", token: "t" },
      allowedTools: ["agent.reportProgress"],
    }));
    const child = Bun.spawn(selfCommand(INTERNAL.mcp, "--context", context), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    child.stdin.end();
    const lines = (await new Response(child.stdout).text()).trim().split("\n").map((line) => JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } });
    expect(lines.find((line) => line.id === 2)?.result?.tools?.map((tool) => tool.name)).toEqual(["agent.reportProgress"]);
  });
});

describe("operator scripts", () => {
  test("run under bun by default, or the configured interpreter; [] executes the script itself", () => {
    expect(DEFAULT_SCRIPT_INTERPRETER).toEqual(["bun", "run"]);
    expect(scriptCommand("/s/deploy.ts")).toEqual(["bun", "run", "/s/deploy.ts"]);
    expect(scriptCommand("/s/deploy.py", ["python3", "-u"])).toEqual(["python3", "-u", "/s/deploy.py"]);
    expect(scriptCommand("/s/deploy", [])).toEqual(["/s/deploy"]);
  });

  test("doctor lists every interpreter the configured scripts need", () => {
    const config = {
      plans: [{ id: "p", repositoryId: "r", stages: [{
        id: "deploy", actions: [
          { task: "script.run", with: { script: "/s/a.ts" } },
          { task: "script.run", with: { script: "/s/b.py", interpreter: ["python3"] } },
          { task: "script.run", with: { script: "/s/c", interpreter: [] } },
        ], exitGate: [],
      }] }],
      pipelines: { legacy: { stages: [{ id: "deploy", run: { type: "script", runner: "process", script: "/s/d.rb", interpreter: ["ruby"] } }] } },
      checks: { exit: { script: "/s/e.ts", verifier: "x" } },
    } as unknown as ConveyorConfig;
    expect(scriptInterpreters(config)).toEqual(["bun", "python3", "ruby"]);
  });
});

test("the embedded output schemas are written for the Codex CLI to read by path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-schema-"));
  directories.push(directory);
  const file = await writeOutputSchema(directory, "check");
  const original = JSON.parse(await readFile(path.resolve(import.meta.dir, "../../src/runner/schemas/check-result.json"), "utf8")) as unknown;
  expect(JSON.parse(await readFile(file, "utf8")) as unknown).toEqual(original);
});
