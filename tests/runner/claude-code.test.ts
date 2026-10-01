import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeArguments, claudeSchema, runClaudeCode, sandboxArguments } from "../../src/runner/claude-code";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const base = {
  command: "claude", workspace: "/w", artifactsDirectory: "/a", prompt: "p",
  sandbox: "read-only" as const, automaticApprovals: false, mcp: { command: "bun", args: ["mcp"] },
};

describe("claude code runner", () => {
  test("runs isolated from personal settings, with read tools, Bash and the Conveyor MCP only", () => {
    const args = claudeArguments({ ...base, model: "claude-opus-5-5", effort: "ultra", resumeSessionId: "s1" }, "{}");
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("--setting-sources")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(value("--mcp-config")!)).toEqual({ mcpServers: { conveyor: { command: "bun", args: ["mcp"] } } });
    expect(value("--tools")).toBe("Read,Grep,Glob,Bash");
    expect(value("--allowedTools")).toBe("Read,Grep,Glob,Bash,mcp__conveyor");
    expect(value("--permission-mode")).toBe("dontAsk");
    expect(value("--model")).toBe("claude-opus-5-5");
    expect(value("--effort")).toBe("max");
    expect(value("--resume")).toBe("s1");
  });

  test("mounts everything read-only except its config, home and a private /tmp", () => {
    const args = sandboxArguments({ workspace: "/w", configDir: "/c", home: "/h", serviceHome: undefined }).join(" ");
    expect(args).toStartWith("--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp");
    expect(args).toContain("--bind /c /c");
    expect(args).toContain("--bind /h /h");
    expect(args).toContain("--chdir /w --die-with-parent --");
    expect(args).not.toContain("--bind /w");
  });

  test("passes the result schema without the $schema reference Claude Code rejects", async () => {
    const raw = await readFile(path.join(import.meta.dir, "../../src/runner/schemas/producer-result.json"), "utf8");
    expect(raw).toContain("$schema");
    const schema = JSON.parse(claudeSchema(raw));
    expect(schema.$schema).toBeUndefined();
    expect(schema.required).toContain("outcome");
  });

  test("refuses a writable sandbox", async () => {
    await expect(runClaudeCode({ ...base, sandbox: "workspace-write" })).rejects.toThrow("read-only");
  });

  test.skipIf(!Bun.which("bwrap"))("parses the result, usage and session, and cannot write the workspace", async () => {
    const root = await mkdtemp(path.join(process.env.HOME ?? tmpdir(), ".conveyor-claude-test-"));
    directories.push(root);
    const workspace = path.join(root, "ws");
    await Bun.write(path.join(workspace, "file.txt"), "keep");
    const fake = path.join(root, "claude");
    await writeFile(fake, `#!/bin/sh
cat > /dev/null
echo changed > file.txt 2>/dev/null
echo '{"type":"system","subtype":"init","session_id":"sess-9"}'
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-9","usage":{"input_tokens":10,"cache_creation_input_tokens":90,"cache_read_input_tokens":900,"output_tokens":5},"structured_output":{"version":1,"outcome":"success","status":"done","summary":"Reviewed","reason":null,"metrics":{},"artifacts":[]}}'
`);
    await chmod(fake, 0o755);
    const result = await runClaudeCode({
      ...base, command: fake, workspace, artifactsDirectory: path.join(root, "artifacts", "run-1"),
      env: { CLAUDE_CONFIG_DIR: path.join(root, "config") },
    });
    expect(result.stageResult).toMatchObject({ outcome: "success", status: "done", summary: "Reviewed" });
    expect(result.sessionId).toBe("sess-9");
    expect(result.usage).toMatchObject({ inputTokens: 1000, cachedTokens: 900, outputTokens: 5 });
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("keep");
  });
});
