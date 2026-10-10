import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeArguments, claudeSchema, runClaudeCode, sandboxArguments } from "../../src/runner/claude-code";
import { bwrapUnavailableReason } from "../support/bwrap";

const directories: string[] = [];
const bwrapUnavailable = bwrapUnavailableReason();
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

  test("refuses full access", async () => {
    await expect(runClaudeCode({ ...base, sandbox: "danger-full-access" })).rejects.toThrow("never with full access");
  });

  test("a workspace-write agent gets Edit and Write in acceptEdits mode, never pre-allowed; network adds web tools; MCP servers are listed", () => {
    const args = claudeArguments({
      ...base, sandbox: "workspace-write", network: true,
      mcpServers: {
        serena: { command: "serena", args: ["start-mcp-server"], env: { SERENA_HOME: "/s" }, enabledTools: ["find_symbol", "get_symbols_overview"] },
        plain: { command: "idx", args: [], env: {} },
      },
    }, "{}");
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("--tools")).toBe("Read,Grep,Glob,Bash,Edit,Write,WebFetch,WebSearch");
    expect(value("--allowedTools")).toBe("Read,Grep,Glob,Bash,WebFetch,WebSearch,mcp__conveyor,mcp__serena__find_symbol,mcp__serena__get_symbols_overview,mcp__plain");
    expect(value("--allowedTools")).not.toMatch(/\b(Edit|Write)\b/);
    expect(value("--permission-mode")).toBe("acceptEdits");
    expect(JSON.parse(value("--mcp-config")!)).toEqual({ mcpServers: {
      conveyor: { command: "bun", args: ["mcp"] },
      serena: { command: "serena", args: ["start-mcp-server"], env: { SERENA_HOME: "/s" } },
      plain: { command: "idx", args: [] },
    } });
    const readOnly = claudeArguments({ ...base, network: true }, "{}");
    expect(readOnly[readOnly.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Bash,WebFetch,WebSearch");
  });

  test("hides the session bus and existing root-equivalent sockets, and binds writable directories that exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-claude-sbx-"));
    directories.push(root);
    const bus = path.join(root, "bus");
    await writeFile(bus, "");
    const cache = path.join(root, "cache");
    await Bun.write(path.join(cache, "x"), "");
    const args = sandboxArguments({ workspace: "/w", configDir: "/c", home: "/h", serviceHome: undefined, sessionBus: bus, writable: [cache, path.join(root, "missing")] }).join(" ");
    expect(args).toContain(`--ro-bind /dev/null ${bus}`);
    expect(args).toContain(`--bind ${cache} ${cache}`);
    expect(args).not.toContain("missing");
  });

  test.skipIf(bwrapUnavailable !== null)("parses the result, usage and session, and cannot write the workspace", async () => {
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

  test.skipIf(bwrapUnavailable !== null)("a workspace-write agent can change its worktree but nothing beside it", async () => {
    const root = await mkdtemp(path.join(process.env.HOME ?? tmpdir(), ".conveyor-claude-test-"));
    directories.push(root);
    const workspace = path.join(root, "ws");
    await Bun.write(path.join(workspace, "file.txt"), "keep");
    await Bun.write(path.join(root, "beside.txt"), "keep");
    const fake = path.join(root, "claude");
    await writeFile(fake, `#!/bin/sh
cat > /dev/null
echo changed > file.txt
echo changed > ../beside.txt 2>/dev/null
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s","usage":{"input_tokens":1,"output_tokens":1},"structured_output":{"version":1,"outcome":"success","status":"done","summary":"Done","reason":null,"metrics":{},"artifacts":[]}}'
`);
    await chmod(fake, 0o755);
    const result = await runClaudeCode({
      ...base, sandbox: "workspace-write", network: true, command: fake, workspace, artifactsDirectory: path.join(root, "artifacts", "run-2"),
      env: { CLAUDE_CONFIG_DIR: path.join(root, "config") },
    });
    expect(result.stageResult).toMatchObject({ status: "done" });
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("changed\n");
    expect(await readFile(path.join(root, "beside.txt"), "utf8")).toBe("keep");
  });
});
