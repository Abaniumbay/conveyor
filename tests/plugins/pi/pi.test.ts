import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parsePiResult, piArguments, piMcpConfiguration, piSettings, piTools, runPi, type PiRunInput } from "../../../src/plugins/pi/pi";
import { FAKE_PI, VALID_RESULT, assistant, installFakePi, installPassThroughBwrap, piEvents } from "../../support/fake-pi";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const base = { sandbox: "read-only" as const, mcp: { command: "bun", args: ["mcp"] } };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-pi-"));
  directories.push(root);
  const { command } = await installFakePi(path.join(root, "install"), FAKE_PI);
  const fakeBin = path.join(root, "fake-bin");
  await installPassThroughBwrap(fakeBin);
  const workspace = path.join(root, "workspace");
  const service = path.join(root, "service-pi");
  await Promise.all([mkdir(workspace), mkdir(service)]);
  const artifacts = (run: string) => path.join(root, "artifacts", run);
  const capture = path.join(root, "capture.json");
  const events = path.join(root, "events.jsonl");
  const resumedEvents = path.join(root, "events-resumed.jsonl");
  const run = (options: Partial<PiRunInput> & { run?: string } = {}) => {
    const { run: runName, env, ...rest } = options;
    return runPi({
      command, workspace, artifactsDirectory: artifacts(runName ?? "run-1"), prompt: "Do the work",
      automaticApprovals: false, ...base,
      runner: { type: "pi", command },
      ...rest,
      env: { PATH: `${fakeBin}:${process.env.PATH}`, CAPTURE: capture, FAKE_EVENTS: events, FAKE_EVENTS_RESUMED: resumedEvents, PI_CODING_AGENT_DIR: service, ...env },
    });
  };
  const captured = async () => JSON.parse(await readFile(capture, "utf8")) as {
    args: string[]; stdin: string; env: Record<string, string>; agentDir: string; auth: string | null; models: string | null;
    settings: Record<string, unknown>; mcp: Record<string, unknown>; resumed: string | null;
  };
  return { root, command, workspace, service, artifacts, capture, events, resumedEvents, run, captured };
}

const result = (value: unknown = VALID_RESULT) => JSON.stringify(value);

describe("pi arguments", () => {
  const options = { sessions: "/h/.pi/agent/sessions", schema: '{"type":"object"}' };
  const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  test("start pi in JSON mode with only Conveyor's choices: no extensions but MCP, no skills, templates, themes or project trust", () => {
    const args = piArguments({ ...base }, options);
    expect(value(args, "--mode")).toBe("json");
    expect(args).toContain("--no-approve");
    expect(args).toContain("--no-extensions");
    expect(value(args, "-e")).toBe("builtin:mcp");
    expect(args).toEqual(expect.arrayContaining(["--no-skills", "--no-prompt-templates", "--no-themes"]));
    expect(value(args, "--session-dir")).toBe("/h/.pi/agent/sessions");
    expect(value(args, "--append-system-prompt")).toContain('{"type":"object"}');
    expect(value(args, "--append-system-prompt")).toContain("exactly one JSON object");
    expect(args).not.toContain("--session");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--no-context-files");
  });

  test("pass the agent's model, the runner's provider, its effort as thinking (ultra as max) and the resumed session", () => {
    const args = piArguments({ ...base, model: "claude-opus-5-5", effort: "ultra" }, { ...options, provider: "anthropic", resumeFile: "/h/.pi/agent/sessions/x_s1.jsonl" });
    expect(value(args, "--provider")).toBe("anthropic");
    expect(value(args, "--model")).toBe("claude-opus-5-5");
    expect(value(args, "--thinking")).toBe("max");
    expect(value(args, "--session")).toBe("/h/.pi/agent/sessions/x_s1.jsonl");
    expect(value(piArguments({ ...base, effort: "high" }, options), "--thinking")).toBe("high");
    // pi requires --model with --provider, so without a model the provider goes to settings instead.
    expect(piArguments({ ...base }, { ...options, provider: "anthropic" })).not.toContain("--provider");
  });

  test("tools follow the agent's access and shell, and name every allowed MCP tool", () => {
    const servers = { "code-index": { command: "idx", args: [], env: {} }, serena: { command: "serena", args: [], env: {}, enabledTools: ["find_symbol", "get-overview"] } };
    expect(piTools({ ...base })).toEqual(["read", "grep", "find", "ls", "bash", "mcp__conveyor__*"]);
    expect(piTools({ ...base, shell: false })).toEqual(["read", "grep", "find", "ls", "mcp__conveyor__*"]);
    expect(piTools({ ...base, sandbox: "workspace-write" })).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write", "mcp__conveyor__*"]);
    expect(piTools({ ...base, sandbox: "workspace-write", shell: false, mcpServers: servers })).toEqual([
      "read", "grep", "find", "ls", "edit", "write", "mcp__conveyor__*", "mcp__code_index__*", "mcp__serena__find_symbol", "mcp__serena__get_overview",
    ]);
  });

  test("mcp.json declares Conveyor's server and the agent's servers directly, hiding a server's tools beyond enabledTools", () => {
    expect(piMcpConfiguration({
      mcp: { command: "/usr/bin/conveyor", args: ["__mcp", "--context", "c"] },
      mcpServers: {
        serena: { command: "serena", args: ["start"], env: { SERENA_HOME: "/s" }, enabledTools: ["find_symbol"] },
        plain: { command: "idx", args: [], env: {} },
      },
    })).toEqual({
      autoEnableCodemode: false,
      mcpServers: {
        conveyor: { command: "/usr/bin/conveyor", args: ["__mcp", "--context", "c"], exposure: "direct" },
        serena: { command: "serena", args: ["start"], env: { SERENA_HOME: "/s" }, exposure: "hidden", toolExposure: { find_symbol: "direct" } },
        plain: { command: "idx", args: [], exposure: "direct" },
      },
    });
  });

  test("an MCP server env value pi would expand or run is refused", () => {
    for (const value of ["!cat /etc/passwd", "prefix-${HOME}"]) {
      expect(() => piMcpConfiguration({ mcp: base.mcp, mcpServers: { s: { command: "s", args: [], env: { X: value } } } })).toThrow("pi would expand the value of X");
    }
  });

  test("settings use Conveyor's shell, drop the agent directory and credentials from every command and never trust a project", () => {
    expect(piSettings({ shell: "/usr/bin/bash", programVariables: ["EXAMPLE_API_KEY"], provider: "anthropic" })).toEqual({
      shellPath: "/usr/bin/bash",
      shellCommandPrefix: "unset PI_CODING_AGENT_DIR EXAMPLE_API_KEY",
      defaultProjectTrust: "never",
      enableInstallTelemetry: false,
      defaultProvider: "anthropic",
    });
    expect(piSettings({ shell: "/bin/bash", programVariables: [] })).not.toHaveProperty("defaultProvider");
  });

  test("under agentEgress every command first sources the run's command environment, and a missing one stops it", () => {
    expect(piSettings({ shell: "/usr/bin/bash", programVariables: ["EXAMPLE_API_KEY"], commandEnvironment: "/a/run/net/command-environment" })).toMatchObject({
      shellPath: "/usr/bin/bash",
      shellCommandPrefix: ". '/a/run/net/command-environment' || exit 126",
    });
  });

  test("under agentEgress every MCP server starts through the shell, which sources the command environment first", () => {
    const egress = { shell: "/usr/bin/bash", commandEnvironment: "/a/run/net/command-environment" };
    const servers = (piMcpConfiguration({
      mcp: { command: "/usr/bin/conveyor", args: ["__mcp"] },
      mcpServers: { serena: { command: "serena", args: ["start"], env: { SERENA_HOME: "/s" }, enabledTools: ["find_symbol"] } },
    }, egress) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers;
    expect(servers.conveyor).toEqual({ command: "/usr/bin/bash", args: ["-c", '. "$0" && exec "$@"', egress.commandEnvironment, "/usr/bin/conveyor", "__mcp"], exposure: "direct" });
    expect(servers.serena).toEqual({
      command: "/usr/bin/bash", args: ["-c", '. "$0" && exec "$@"', egress.commandEnvironment, "serena", "start"],
      env: { SERENA_HOME: "/s" }, exposure: "hidden", toolExposure: { find_symbol: "direct" },
    });
  });

  test("the result is the final message's JSON, inside at most one json fence", () => {
    expect(parsePiResult(result())).toEqual(VALID_RESULT);
    expect(parsePiResult(`\n\`\`\`json\n${result()}\n\`\`\`\n`)).toEqual(VALID_RESULT);
    expect(() => parsePiResult(`Here it is: ${result()}`)).toThrow();
  });
});

describe("pi runner", () => {
  test("returns the result, the usage summed over assistant messages and the session id, and reads the prompt from stdin", async () => {
    const f = await fixture();
    await writeFile(f.events, piEvents("sess-1", [
      assistant("", { stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] }),
      assistant(`\`\`\`json\n${result()}\n\`\`\``),
    ]));
    const events: unknown[] = [];

    const envelope = await f.run({ onEvent: (event) => events.push(event) });

    expect(envelope.stageResult).toEqual({ outcome: "success", status: "done", summary: "Done", reason: null, metrics: {} });
    expect(envelope.sessionId).toBe("sess-1");
    expect(envelope.usage).toEqual({ inputTokens: 206, cachedTokens: 180, outputTokens: 10 });
    expect(envelope.exitCode).toBe(0);
    expect((await f.captured()).stdin).toBe("Do the work");
    // Delta records are not stored; the completed messages are.
    expect(events.map((event) => (event as { type: string }).type)).not.toContain("message_update");
    expect(events.filter((event) => (event as { type: string }).type === "message_end")).toHaveLength(2);
    expect(existsSync(path.join(f.artifacts("run-1"), "home"))).toBe(false);
  });

  test("gives pi a private agent directory with the service's login and Conveyor's own settings and servers", async () => {
    const f = await fixture();
    await writeFile(path.join(f.service, "auth.json"), '{"anthropic":{"type":"api_key","key":"k"}}');
    await writeFile(path.join(f.service, "models.json"), '{"providers":{}}');
    await writeFile(path.join(f.service, "settings.json"), '{"defaultModel":"operator-choice","shellCommandPrefix":"curl example.com"}');
    await writeFile(path.join(f.service, "mcp.json"), '{"mcpServers":{"operator":{"command":"x"}}}');
    await writeFile(f.events, piEvents("sess-1", [assistant(result())]));

    // The harness level's EXAMPLE_API_KEY is pi's own; the deprecated credentialVariables still bring the service's LEGACY_API_KEY.
    process.env.LEGACY_API_KEY = "legacy";
    try {
      await f.run({
        runner: { type: "pi", command: "pi", credentialVariables: ["LEGACY_API_KEY"] },
        env: { EXAMPLE_API_KEY: "secret", LISTED_TOKEN: "listed" }, programVariables: ["EXAMPLE_API_KEY"],
      });
    } finally {
      delete process.env.LEGACY_API_KEY;
    }

    const seen = await f.captured();
    expect(seen.agentDir).toBe(path.join(f.artifacts("run-1"), "home", ".pi", "agent"));
    expect(seen.env.PI_CODING_AGENT_DIR).toBe(seen.agentDir);
    expect(seen.auth).toBe('{"anthropic":{"type":"api_key","key":"k"}}');
    expect(seen.models).toBe('{"providers":{}}');
    expect(seen.settings).toMatchObject({ shellCommandPrefix: "unset PI_CODING_AGENT_DIR EXAMPLE_API_KEY LEGACY_API_KEY", defaultProjectTrust: "never" });
    expect(seen.settings).not.toHaveProperty("defaultModel");
    expect(path.isAbsolute(seen.settings.shellPath as string)).toBe(true);
    expect(Object.keys(seen.mcp.mcpServers as object)).toEqual(["conveyor"]);
    expect(seen.env.EXAMPLE_API_KEY).toBe("secret");
    expect(seen.env.LEGACY_API_KEY).toBe("legacy");
    // Conveyor filters no name: what the run lists reaches it.
    expect(seen.env.LISTED_TOKEN).toBe("listed");
    expect(Object.values(seen.env)).not.toContain(f.service);
    expect(seen.args[seen.args.indexOf("--tools") + 1]).toBe("read,grep,find,ls,bash,mcp__conveyor__*");
  });

  test("a final message that is not the JSON result is an invalid-result error carrying the session id", async () => {
    const f = await fixture();
    for (const [text, message] of [
      ["I have finished the work.", "not a JSON result"],
      [result({ ...VALID_RESULT, outcome: "failure", reason: null }), "failed validation: reason"],
      ["", "did not contain the result"],
    ] as const) {
      await writeFile(f.events, piEvents("sess-invalid", [assistant(text)]));
      await expect(f.run()).rejects.toMatchObject({ kind: "invalid-result", sessionId: "sess-invalid", message: expect.stringContaining(message) });
    }
  });

  test("a failed or aborted model response fails the run although pi exits 0", async () => {
    const f = await fixture();
    await writeFile(f.events, [
      piEvents("s", [assistant("", { stopReason: "error", errorMessage: "500 internal server error" })]),
      JSON.stringify({ type: "auto_retry_end", success: false, attempt: 3, finalError: "500 internal server error" }),
    ].join("\n"));
    await expect(f.run()).rejects.toMatchObject({ kind: "process", exitCode: 0, message: expect.stringContaining("500 internal server error") });

    await writeFile(f.events, piEvents("s", [assistant("", { stopReason: "aborted" })]));
    await expect(f.run()).rejects.toMatchObject({ kind: "process", message: expect.stringContaining("aborted") });
  });

  test("a retry that ends in failure fails the run even after a final message", async () => {
    const f = await fixture();
    await writeFile(f.events, `${piEvents("s", [assistant(result())])}\n${JSON.stringify({ type: "auto_retry_end", success: false, attempt: 3, finalError: "connection lost" })}`);
    await expect(f.run()).rejects.toMatchObject({ kind: "process", message: expect.stringContaining("connection lost") });
  });

  test("usage and rate limits are usage-limit errors, so another agent can take over", async () => {
    const f = await fixture();
    for (const error of ["429 Too Many Requests", "insufficient_quota: You exceeded your current quota", "Server requested 18000s retry delay (max: 60s)"]) {
      await writeFile(f.events, piEvents("s", [assistant("", { stopReason: "error", errorMessage: error })]));
      await expect(f.run()).rejects.toMatchObject({ kind: "usage-limit", message: expect.stringContaining(error) });
    }
  });

  test("a non-zero exit is a process failure naming pi's error output", async () => {
    const f = await fixture();
    await writeFile(f.events, "");
    await expect(f.run({ env: { FAKE_EXIT: "2" } })).rejects.toMatchObject({ kind: "process", exitCode: 2 });
  });

  test("a stream without a session header or with a malformed record is a protocol error", async () => {
    const f = await fixture();
    await writeFile(f.events, JSON.stringify({ type: "message_end", message: assistant(result()) }));
    await expect(f.run()).rejects.toMatchObject({ kind: "protocol", message: expect.stringContaining("session header") });
    await writeFile(f.events, `${piEvents("s", [assistant(result())])}\nnot json`);
    await expect(f.run()).rejects.toMatchObject({ kind: "protocol", message: expect.stringContaining("invalid JSONL") });
  });

  test("a run's session is kept in the service's agent directory and the next run resumes it with --session", async () => {
    const f = await fixture();
    await writeFile(f.events, piEvents("sess-1", [assistant(result())]));
    await f.run({ prompt: "first" });
    const stored = path.join(f.service, "conveyor-sessions");
    const [record] = await readdir(stored);
    expect(record).toBe("2026-11-13T10-00-00-000Z_sess-1.jsonl");

    await writeFile(f.resumedEvents, piEvents("sess-1", [assistant(result({ ...VALID_RESULT, summary: "Continued" }))]));
    const resumed = await f.run({ run: "run-2", prompt: "second", resumeSessionId: "sess-1" });

    const seen = await f.captured();
    expect(seen.args[seen.args.indexOf("--session") + 1]).toBe(path.join(f.artifacts("run-2"), "home", ".pi", "agent", "sessions", record!));
    expect(seen.resumed).toContain('"prompt":"first"');
    expect(resumed).toMatchObject({ sessionId: "sess-1", stageResult: { summary: "Continued" } });
    const lines = (await readFile(path.join(stored, record!), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).prompt)).toEqual(["first", "second"]);
  });

  test("resuming a session whose record is gone fails before pi starts", async () => {
    const f = await fixture();
    await expect(f.run({ resumeSessionId: "missing" })).rejects.toThrow("cannot resume pi session missing");
    expect(existsSync(f.capture)).toBe(false);
  });

  test("a refreshed login is synchronised back to the service's agent directory", async () => {
    const f = await fixture();
    await writeFile(path.join(f.service, "auth.json"), '{"token":"old"}');
    await writeFile(f.events, piEvents("s", [assistant(result())]));
    await f.run({ env: { FAKE_AUTH: '{"token":"new"}' } });
    expect(await readFile(path.join(f.service, "auth.json"), "utf8")).toBe('{"token":"new"}');
    await f.run({ env: { FAKE_AUTH: "not json" } });
    expect(await readFile(path.join(f.service, "auth.json"), "utf8")).toBe('{"token":"new"}');
  });

  test("refuses full access, and agentEgress without control-plane hosts, before pi starts", async () => {
    const f = await fixture();
    await expect(f.run({ sandbox: "danger-full-access" })).rejects.toThrow("never with full access");
    await expect(f.run({ egress: { httpsHosts: [] } })).rejects.toThrow("names no controlPlaneHosts and pi has no default hosts for its provider");
    await expect(f.run({ egress: { httpsHosts: [] }, runner: { type: "pi", command: f.command, provider: "azure" } })).rejects.toThrow("default hosts for its provider azure");
    expect(existsSync(f.capture)).toBe(false);
  });

  test("a command that is not pi's npm package is refused before it starts", async () => {
    const f = await fixture();
    const other = path.join(f.root, "other-pi");
    await writeFile(other, "#!/bin/sh\necho started > \"$CAPTURE\"\n", { mode: 0o755 });
    await expect(f.run({ command: other, runner: { type: "pi", command: other } })).rejects.toThrow("is not part of an installed @earendil-works/pi-coding-agent package");
    expect(existsSync(f.capture)).toBe(false);
    expect(existsSync(path.join(f.artifacts("run-1"), "home"))).toBe(false);
  });
});
