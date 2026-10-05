// Operator smoke check: uses the real Codex runner and Conveyor MCP server with an isolated,
// read-only conversation fixture. It never connects to the live Conveyor database or GitHub.
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createConveyorMcpServer, type RunMcpContext } from "../src/mcp/server";
import { runCodex } from "../src/runner/codex";
import { prompt } from "../src/tasks/agent-support";

async function main() {
  const args = Bun.argv.slice(2);
  if (args[0] === "--mcp") {
    const root = args[1];
    if (!root) throw new Error("missing smoke fixture directory");
    const context: RunMcpContext = JSON.parse(await readFile(path.join(root, "context.json"), "utf8"));
    const server = createConveyorMcpServer(context, {
      async call(tool, input) {
        if (tool !== "conversation.get") throw new Error("smoke fixture allows only conversation.get");
        await appendFile(path.join(root, "calls.jsonl"), JSON.stringify({ tool, input }) + "\n");
        return { messages: [{ actorName: "Smoke fixture", message: "Conveyor discovery fixture reached." }] };
      },
    });
    await server.connect(new StdioServerTransport());
    return;
  }
  if (args.length !== 2 || args[0] !== "--model" || !args[1]) {
    throw new Error("usage: bun scripts/check-codex-tool-discovery.ts --model <configured Codex model>");
  }
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-discovery-smoke-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const git = Bun.spawn(["git", "init", "--quiet", workspace], { stdout: "ignore", stderr: "pipe" });
  if (await git.exited !== 0) throw new Error(`fixture git init failed: ${await new Response(git.stderr).text()}`);
  const context: RunMcpContext = {
    version: 1, runId: "discovery-smoke", stageId: "review",
    repository: { id: "smoke", address: "fixture/only", baseBranch: "main" },
    issue: { id: "smoke", number: 1, title: "Tool discovery smoke", body: "", labels: [], url: "https://example.invalid/1" },
    workspace: { path: workspace, branch: "fixture" },
    delivery: { pullRequest: null, checks: [] }, sourceGuidance: "Read-only fixture; no live board access.",
    control: { url: "http://127.0.0.1:1/unused", token: "fixture-only" },
    allowedTools: ["conversation.get"],
  };
  await writeFile(path.join(root, "context.json"), JSON.stringify(context), { mode: 0o600 });
  console.log(`Checking Codex ${args[1]} against an isolated read-only Conveyor MCP fixture...`);
  try {
    const result = await runCodex({
      command: "codex", model: args[1], effort: "high", workspace,
      artifactsDirectory: path.join(root, "artifacts"), sandbox: "read-only", automaticApprovals: false,
      timeoutMs: 180_000,
      mcp: { command: process.execPath, args: ["run", import.meta.path, "--mcp", root] },
      prompt: prompt({},
        "This is a tool discovery smoke check. First discover the Conveyor tools in the runtime registry, then call conversation.get with an empty object. Return success with status done only after the actual tool response contains the fixture message. Include that message in your summary. Do not run shell commands or inspect files; do not do any other work.",
        { grantedTools: context.allowedTools }),
    });
    const calls = (await readFile(path.join(root, "calls.jsonl"), "utf8").catch(() => ""))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (!calls.some((call) => call.tool === "conversation.get" && call.input.issueId === "smoke") ||
      result.stageResult.outcome !== "success" || !result.stageResult.summary.includes("Conveyor discovery fixture reached.")) {
      throw new Error(`Smoke check failed: ${calls.length} actual MCP calls; ${result.stageResult.reason ?? result.stageResult.summary}`);
    }
    console.log(`PASS: ${calls.length} actual conversation.get call(s) through the real Codex runner and Conveyor MCP server.`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
