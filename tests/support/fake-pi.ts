import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Installs a fake pi under `root` the way npm does: the package `@earendil-works/pi-coding-agent`
 * with its CLI at `dist/bundle/cli.js` (here a Bun script, so no Node is needed) and `bin/pi` a
 * symbolic link to it. `script` is the CLI's body, after its `#!` line.
 */
export async function installFakePi(root: string, script: string): Promise<{ command: string; packageRoot: string; bin: string }> {
  const packageRoot = path.join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  const cli = path.join(packageRoot, "dist", "bundle", "cli.js");
  const bin = path.join(root, "bin");
  await mkdir(path.dirname(cli), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.5.2", bin: { pi: "dist/bundle/cli.js" } }));
  await writeFile(cli, `#!/usr/bin/env bun\n${script}`);
  await chmod(cli, 0o755);
  const command = path.join(bin, "pi");
  await symlink(path.relative(bin, cli), command);
  return { command, packageRoot, bin };
}

/**
 * A fake pi CLI that behaves like pi where Conveyor depends on it: it reads the prompt from stdin,
 * appends to its session record (the `--session` file, or a new one in `--session-dir`), may refresh
 * its login, prints the JSON records in `$FAKE_EVENTS` (`$FAKE_EVENTS_RESUMED` when resuming) and
 * exits with `$FAKE_EXIT`. It records what it was given in `$CAPTURE`.
 */
export const FAKE_PI = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const read = (file) => (file && existsSync(file) ? readFileSync(file, "utf8") : null);
const stdin = await Bun.stdin.text();
const agentDir = process.env.PI_CODING_AGENT_DIR;
const resume = value("--session");
const capture = {
  args, stdin, env: { ...process.env }, agentDir,
  auth: read(agentDir + "/auth.json"), models: read(agentDir + "/models.json"),
  settings: JSON.parse(read(agentDir + "/settings.json") ?? "null"), mcp: JSON.parse(read(agentDir + "/mcp.json") ?? "null"),
  resumed: read(resume),
};
if (process.env.CAPTURE) await Bun.write(process.env.CAPTURE, JSON.stringify(capture));
const record = resume ?? value("--session-dir") + "/2026-11-13T10-00-00-000Z_" + (process.env.FAKE_SESSION ?? "sess-1") + ".jsonl";
appendFileSync(record, JSON.stringify({ type: "message", prompt: stdin }) + "\\n");
if (process.env.FAKE_AUTH) await Bun.write(agentDir + "/auth.json", process.env.FAKE_AUTH);
const events = read(resume && process.env.FAKE_EVENTS_RESUMED ? process.env.FAKE_EVENTS_RESUMED : process.env.FAKE_EVENTS);
if (events) process.stdout.write(events + "\\n");
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

/** A `bwrap` stand-in that runs the wrapped command directly, for tests of everything but the sandbox. */
export async function installPassThroughBwrap(bin: string): Promise<void> {
  await mkdir(bin, { recursive: true });
  const file = path.join(bin, "bwrap");
  await writeFile(file, `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`);
  await chmod(file, 0o755);
}

/** pi's JSON-mode records for a run: the session header, then an assistant message per entry. */
export function piEvents(sessionId: string, messages: Array<Record<string, unknown>>): string {
  const records: unknown[] = [
    { type: "session", version: 3, id: sessionId, timestamp: "2026-11-13T10:00:00.000Z", cwd: "/w" },
    { type: "agent_start" },
    ...messages.flatMap((message) => [
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } },
      { type: "message_end", message: { role: "assistant", api: "a", provider: "p", model: "m", timestamp: 1, ...message } },
    ]),
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled", aborted: false },
  ];
  return records.map((record) => JSON.stringify(record)).join("\n");
}

/** An assistant message with usage whose text is `text`. */
export function assistant(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 3, totalTokens: 108, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...extra,
  };
}

export const VALID_RESULT = { version: 1, outcome: "success", status: "done", summary: "Done", reason: null, metrics: {}, artifacts: [] };
