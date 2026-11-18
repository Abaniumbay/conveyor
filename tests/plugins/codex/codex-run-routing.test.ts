import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultRunVariables } from "../../../src/isolation/run-environment";
import { ConsoleSink, log, type LogRecord } from "../../../src/log/logger";
import { runCodexCheck } from "../../../src/plugins/codex/codex-check";
import { runCodexSteering } from "../../../src/plugins/codex/codex-steering";
import { bwrapUnavailableReason } from "../../support/bwrap";
import { writeLogin } from "../../support/codex-login";
import { shortTemporaryDirectory } from "../../support/short-temporary-directory";

const unavailable = bwrapUnavailableReason();
if (unavailable) console.warn(`SKIPPED codex check and steering routing tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);
const describeSandbox = unavailable ? describe.skip : describe;

const REAL_KEY = "sk-fixture-REAL-KEY-1";
const ENV_KEY = "sk-fixture-ENV-KEY-1";
const directories: string[] = [];
const records: LogRecord[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  records.length = 0;
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// The fake `codex`: records its `-c` overrides and the record it holds, overwrites that record with
// junk (as a hostile command could), and answers both as a check run and as a steering run.
const FAKE_CODEX = `#!/usr/bin/env bun
import fs from "node:fs";
const args = process.argv.slice(2);
await new Response(Bun.stdin.stream()).text();
const file = process.env.CODEX_HOME + "/auth.json";
let held = null;
try { held = fs.readFileSync(file, "utf8"); } catch {}
try { fs.writeFileSync(file, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "junk-from-sandbox" })); } catch {}
await Bun.write(process.env.CAPTURE, JSON.stringify({ args, held, apiKey: process.env.OPENAI_API_KEY ?? null }));
const out = args.indexOf("-o");
if (out >= 0) await Bun.write(args[out + 1], JSON.stringify({ version: 1, decision: "pass", status: "done", reason: null, evidence: [], requiredFixes: [], criteria: [] }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }));
`;

async function fixture(login?: unknown) {
  const directory = await shortTemporaryDirectory("conveyor-cr-", { socketPath: "artifacts/run-1/net/relay.sock", visibleInSandbox: true });
  directories.push(directory);
  const workspace = path.join(directory, "workspace");
  const artifacts = path.join(directory, "artifacts", "run-1");
  const serviceHome = path.join(directory, "service-codex");
  const executable = path.join(directory, "codex");
  await mkdir(workspace);
  await mkdir(artifacts, { recursive: true });
  await mkdir(serviceHome);
  await writeFile(executable, FAKE_CODEX);
  await chmod(executable, 0o755);
  if (login !== undefined) await writeLogin(serviceHome, login);
  const capture = path.join(artifacts, "capture.json");
  const env = { ...defaultRunVariables(), CODEX_HOME: serviceHome, CAPTURE: capture };
  return { directory, workspace, artifacts, serviceHome, executable, capture, env };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const egress = { httpsHosts: [], controlPlaneHosts: [] };
const entries = {
  check: (f: Fixture, extra: { env?: Record<string, string>; egress?: boolean }) =>
    runCodexCheck({
      command: f.executable, workspace: f.workspace, artifactsDirectory: f.artifacts, prompt: "Check",
      sandbox: "read-only", automaticApprovals: false, mcp: { command: "bun", args: [] },
      env: { ...f.env, ...extra.env }, ...(extra.egress === false ? {} : { egress }),
    }),
  steering: (f: Fixture, extra: { env?: Record<string, string>; egress?: boolean }) =>
    runCodexSteering({
      command: f.executable, workspace: f.workspace, artifactsDirectory: f.artifacts, prompt: "Steer",
      sandbox: "workspace-write", automaticApprovals: false,
      env: { ...f.env, ...extra.env }, ...(extra.egress === false ? {} : { egress }),
    }),
};

function captureWarnings(): LogRecord[] {
  log.configure({ sinks: [{ write: (record: LogRecord) => void records.push(record) }] });
  return records;
}

describeSandbox("Codex check and steering runs are routed like producer runs", () => {
  for (const [name, start] of Object.entries(entries)) {
    test(`${name}: a routed API-key login reaches the run as a placeholder and the host record survives`, async () => {
      const f = await fixture({ auth_mode: "apikey", OPENAI_API_KEY: REAL_KEY });
      const before = await readFile(path.join(f.serviceHome, "auth.json"), "utf8");
      const warnings = captureWarnings();

      await start(f, {});

      const seen = JSON.parse(await readFile(f.capture, "utf8")) as { args: string[]; held: string | null };
      const override = seen.args.find((arg) => arg.startsWith("openai_base_url="));
      expect(override).toMatch(/^openai_base_url="https?:\/\/127\.0\.0\.1:\d+/);
      expect(seen.held).not.toBeNull();
      expect(seen.held).not.toContain(REAL_KEY);
      expect(JSON.stringify(seen)).not.toContain(REAL_KEY);
      expect(await readFile(path.join(f.serviceHome, "auth.json"), "utf8")).toBe(before);
      expect(warnings.filter((record) => record.level === "warn")).toHaveLength(0);
    });

    test(`${name}: a symlinked record is copied and reported exactly once`, async () => {
      const f = await fixture();
      const real = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: REAL_KEY });
      await writeFile(path.join(f.directory, "elsewhere.json"), real);
      await symlink(path.join(f.directory, "elsewhere.json"), path.join(f.serviceHome, "auth.json"));
      const warnings = captureWarnings();

      await start(f, {});

      const seen = JSON.parse(await readFile(f.capture, "utf8")) as { args: string[] };
      expect(seen.args.some((arg) => arg.startsWith("openai_base_url="))).toBe(false);
      expect(warnings.filter((record) => record.level === "warn")).toHaveLength(1);
      expect(JSON.stringify(warnings)).not.toContain(REAL_KEY);
    });

    test(`${name}: a key variable with no sandbox network is reported exactly once`, async () => {
      const f = await fixture();
      const warnings = captureWarnings();

      await start(f, { egress: false, env: { OPENAI_API_KEY: ENV_KEY } });

      expect(warnings.filter((record) => record.level === "warn")).toHaveLength(1);
      expect(JSON.stringify(warnings)).not.toContain(ENV_KEY);
    });
  }
});
