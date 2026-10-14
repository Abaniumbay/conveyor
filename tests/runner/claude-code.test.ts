import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeArguments, claudeSchema, clearClaudeCodeHome, runClaudeCode, sandboxArguments, type ClaudeCodeRunInput } from "../../src/runner/claude-code";
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

async function runnable(script: string) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-claude-cleanup-"));
  directories.push(root);
  const workspace = path.join(root, "workspace");
  const artifactsDirectory = path.join(root, "artifacts", "run-1");
  const bin = path.join(root, "bin");
  const command = path.join(bin, "claude");
  await mkdir(workspace, { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(bin, "bwrap"), `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`);
  await writeFile(command, script);
  await Promise.all([chmod(path.join(bin, "bwrap"), 0o755), chmod(command, 0o755)]);
  return {
    root, workspace, artifactsDirectory, command,
    run: (env: Record<string, string> = {}, options: Partial<ClaudeCodeRunInput> = {}) => runClaudeCode({
      ...base, ...options, command, workspace, artifactsDirectory,
      env: { CLAUDE_CONFIG_DIR: path.join(root, "config"), PATH: `${bin}:${process.env.PATH}`, ...env },
    }),
  };
}

const successfulResult = '{"type":"result","subtype":"success","is_error":false,"session_id":"s","usage":{"input_tokens":1,"output_tokens":1},"structured_output":{"version":1,"outcome":"success","status":"done","summary":"Done","reason":null,"metrics":{},"artifacts":[]}}';

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

  test("uses resolved paths for every mount behind a symbolic link", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-claude-paths-"));
    directories.push(root);
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    for (const name of ["workspace", "config", "home", "service", "cache"]) {
      await mkdir(path.join(target, name), { recursive: true });
    }
    await writeFile(path.join(target, "config.json"), "{}");
    await symlink(target, link);

    const args = sandboxArguments({
      workspace: path.join(link, "workspace"),
      configDir: path.join(link, "config"),
      home: path.join(link, "home"),
      serviceHome: path.join(link, "service"),
      writable: [path.join(link, "cache"), path.join(link, "missing")],
    });

    expect(args.join(" ")).not.toContain(link);
    expect(args).toContain(path.join(target, "workspace"));
    expect(args).toContain(path.join(target, "config"));
    expect(args).toContain(path.join(target, "config.json"));
    expect(args).toContain(path.join(target, "home"));
    expect(args).toContain(path.join(target, "cache"));
    expect(args.join(" ")).not.toContain("missing");
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

  test("clears the private home after a successful run without removing recorded artifacts", async () => {
    const run = await runnable(`#!/bin/sh
cat > /dev/null
echo cache > "$HOME/tool-state"
echo artifact > "$DECLARED_ARTIFACT"
echo '${successfulResult}'
`);
    const artifact = path.join(run.artifactsDirectory, "result.txt");

    await run.run({ DECLARED_ARTIFACT: artifact });

    expect(existsSync(path.join(run.artifactsDirectory, "home"))).toBe(false);
    expect(await readFile(artifact, "utf8")).toBe("artifact\n");
  });

  test("preserves a declared artifact created in private home", async () => {
    const run = await runnable(`#!/bin/sh
cat > /dev/null
printf 'private artifact\\n' > "$HOME/result.txt"
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"session","usage":{"input_tokens":1,"output_tokens":1},"structured_output":{"version":1,"outcome":"success","status":"done","summary":"Done","reason":null,"metrics":{},"artifacts":[{"name":"result","path":"'"$HOME"'/result.txt"}]}}'
`);

    const result = await run.run();
    const artifact = result.artifacts[0];

    expect(artifact).toBeDefined();
    expect(artifact?.path).not.toStartWith(path.join(run.artifactsDirectory, "home"));
    await expect(readFile(artifact!.path, "utf8")).resolves.toBe("private artifact\n");
    expect(existsSync(path.join(run.artifactsDirectory, "home"))).toBe(false);
  });

  test("clears the private home when Claude setup fails before the process starts", async () => {
    const run = await runnable(`#!/bin/sh
cat > /dev/null
echo '${successfulResult}'
`);
    const configFile = path.join(run.root, "not-a-directory");
    await writeFile(configFile, "config");

    await expect(run.run({ CLAUDE_CONFIG_DIR: configFile })).rejects.toThrow();

    expect(existsSync(path.join(run.artifactsDirectory, "home"))).toBe(false);
  });

  test("accepts an already-removed private home after a successful run", async () => {
    const run = await runnable(`#!/bin/sh
cat > /dev/null
rm "$HOME/.gitconfig"
rmdir "$HOME"
echo '${successfulResult}'
`);

    await expect(run.run()).resolves.toMatchObject({ stageResult: { status: "done" } });
    expect(existsSync(path.join(run.artifactsDirectory, "home"))).toBe(false);
  });

  test("clears the private home after a failed run without touching other run homes or shared caches", async () => {
    const run = await runnable(`#!/bin/sh
cat > /dev/null
echo cache > "$HOME/tool-state"
echo failure > "$DECLARED_ARTIFACT"
exit 3
`);
    const otherHome = path.join(run.root, "artifacts", "run-2", "home");
    const sharedCache = path.join(run.root, "shared-cache");
    const artifact = path.join(run.artifactsDirectory, "failure.txt");
    await Promise.all([mkdir(otherHome, { recursive: true }), mkdir(sharedCache, { recursive: true })]);
    await Promise.all([writeFile(path.join(otherHome, "keep"), "other"), writeFile(path.join(sharedCache, "keep"), "shared")]);

    await expect(run.run({ DECLARED_ARTIFACT: artifact })).rejects.toThrow("exited with code 3");

    expect(existsSync(path.join(run.artifactsDirectory, "home"))).toBe(false);
    expect(await readFile(artifact, "utf8")).toBe("failure\n");
    expect(await readFile(path.join(otherHome, "keep"), "utf8")).toBe("other");
    expect(await readFile(path.join(sharedCache, "keep"), "utf8")).toBe("shared");
  });

  test("keeps an active private home and clears it after interruption", async () => {
    const run = await runnable(`#!/bin/sh
cat > /dev/null
echo cache > "$HOME/tool-state"
echo ready > "$READY"
exec tail -f /dev/null
`);
    const controller = new AbortController();
    const ready = path.join(run.root, "ready");
    const execution = run.run({ READY: ready }, { signal: controller.signal, interruptGraceMs: 20 });
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) await Bun.sleep(5);
    expect(existsSync(path.join(run.artifactsDirectory, "home", "tool-state"))).toBe(true);

    controller.abort();
    await expect(execution).rejects.toThrow("was interrupted");
    expect(existsSync(path.join(run.artifactsDirectory, "home"))).toBe(false);
  });

  test("clears the private home after a timeout", async () => {
    const run = await runnable(`#!/bin/sh
cat > /dev/null
echo cache > "$HOME/tool-state"
exec tail -f /dev/null
`);

    await expect(run.run({}, { timeoutMs: 20, interruptGraceMs: 20 })).rejects.toThrow("timed out");

    expect(existsSync(path.join(run.artifactsDirectory, "home"))).toBe(false);
  });

  test("clears only the resolved run home through symbolic links and refuses an escaped home", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-claude-cleanup-paths-"));
    directories.push(root);
    const target = path.join(root, "target");
    const artifactsLink = path.join(root, "artifacts");
    const artifacts = path.join(target, "runs", "run-1");
    const privateHome = path.join(artifacts, "private-home");
    const homeLink = path.join(artifacts, "home");
    await mkdir(privateHome, { recursive: true });
    await writeFile(path.join(privateHome, "cache"), "private");
    await writeFile(path.join(artifacts, "result.json"), "result");
    await symlink(path.join(target, "runs"), artifactsLink);
    await symlink(privateHome, homeLink);

    await clearClaudeCodeHome(path.join(artifactsLink, "run-1"), path.join(artifactsLink, "run-1", "home"));

    expect(existsSync(privateHome)).toBe(false);
    expect(await readFile(path.join(artifacts, "result.json"), "utf8")).toBe("result");

    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep"), "outside");
    await rm(homeLink, { force: true });
    await symlink(outside, homeLink);

    await expect(clearClaudeCodeHome(artifacts, homeLink)).rejects.toThrow("outside run artifacts");
    expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("outside");
    expect(await readFile(path.join(artifacts, "result.json"), "utf8")).toBe("result");
  });

  test("returns a successful result while reporting a failed cleanup without deleting a home symlink target outside the run", async () => {
    const run = await runnable(`#!/bin/sh
cat > /dev/null
      rm "$HOME/.gitconfig"
      rmdir "$HOME"
ln -s "$OUTSIDE" "$HOME"
echo '${successfulResult}'
`);
    const outside = path.join(run.root, "outside");
    const artifact = path.join(run.artifactsDirectory, "result.json");
    await Promise.all([mkdir(outside), mkdir(run.artifactsDirectory, { recursive: true })]);
    await Promise.all([writeFile(path.join(outside, "keep"), "outside"), writeFile(artifact, "result")]);

    await expect(run.run({ OUTSIDE: outside })).resolves.toMatchObject({
      stageResult: { status: "done" },
      cleanupError: expect.stringContaining("could not clear Claude Code private home"),
    });

    expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("outside");
    expect(await readFile(artifact, "utf8")).toBe("result");
  });

  test("preserves an interruption error when private-home cleanup fails", async () => {
    const run = await runnable(`#!/bin/sh
cat > /dev/null
rm "$HOME/.gitconfig"
rmdir "$HOME"
ln -s "$OUTSIDE" "$HOME"
echo ready > "$READY"
exec tail -f /dev/null
`);
    const outside = path.join(run.root, "outside");
    const ready = path.join(run.root, "ready");
    const controller = new AbortController();
    await mkdir(outside);

    const execution = run.run({ OUTSIDE: outside, READY: ready }, { signal: controller.signal, interruptGraceMs: 20 });
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++) await Bun.sleep(5);
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      kind: "interrupted",
      cleanupError: expect.stringContaining("could not clear Claude Code private home"),
    });
  });

  test.skipIf(bwrapUnavailable !== null)("parses the result, usage and session, and cannot write the workspace", async () => {
    const root = await mkdtemp(path.join(process.env.HOME ?? tmpdir(), ".conveyor-claude-test-"));
    directories.push(root);
    const workspace = path.join(root, "ws");
    await mkdir(workspace, { recursive: true });
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
    await mkdir(workspace, { recursive: true });
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

  test.skipIf(bwrapUnavailable !== null)("gives a read-only agent writable private scratch", async () => {
    const root = await mkdtemp(path.join(process.env.HOME ?? tmpdir(), ".conveyor-claude-test-"));
    directories.push(root);
    const workspace = path.join(root, "ws");
    const scratch = path.join(root, "scratch");
    const fake = path.join(root, "claude");
    await mkdir(workspace, { recursive: true });
    await writeFile(fake, `#!/bin/sh
set -e
cat > /dev/null
echo temporary > "$TMPDIR/from-agent"
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s","usage":{"input_tokens":1,"output_tokens":1},"structured_output":{"version":1,"outcome":"success","status":"done","summary":"Done","reason":null,"metrics":{},"artifacts":[]}}'
`);
    await chmod(fake, 0o755);

    const result = await runClaudeCode({
      ...base, command: fake, workspace, artifactsDirectory: path.join(root, "artifacts", "run-1"), temporaryDirectory: scratch,
      env: { CLAUDE_CONFIG_DIR: path.join(root, "config") },
    });

    expect(result.stageResult).toMatchObject({ outcome: "success", status: "done" });
    expect(await readFile(path.join(scratch, "from-agent"), "utf8")).toBe("temporary\n");
  });

  test.skipIf(bwrapUnavailable !== null)("starts with symlinked run paths and can write its resolved home", async () => {
    const root = await mkdtemp(path.join(process.env.HOME ?? tmpdir(), ".conveyor-claude-paths-"));
    directories.push(root);
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    await mkdir(path.join(target, "workspace"), { recursive: true });
    await symlink(target, link);
    const fake = path.join(root, "claude");
    await writeFile(fake, `#!/bin/sh
set -e
cat > /dev/null
echo home > "$HOME/from-agent"
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s","usage":{"input_tokens":1,"output_tokens":1},"structured_output":{"version":1,"outcome":"success","status":"done","summary":"Done","reason":null,"metrics":{},"artifacts":[]}}'
`);
    await chmod(fake, 0o755);

    const result = await runClaudeCode({
      ...base,
      command: fake,
      workspace: path.join(link, "workspace"),
      artifactsDirectory: path.join(link, "artifacts", "run-1"),
      temporaryDirectory: path.join(link, "scratch"),
      env: { CLAUDE_CONFIG_DIR: path.join(link, "config") },
    });

    expect(result.stageResult).toMatchObject({ outcome: "success", status: "done" });
    expect(await readFile(path.join(target, "artifacts", "run-1", "home", "from-agent"), "utf8")).toBe("home\n");
  });
});
