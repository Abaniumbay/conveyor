import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConsoleSink, log, type LogRecord } from "../../../src/log/logger";
import { prepareCodexRun } from "../../../src/plugins/codex/routing";

const directories: string[] = [];
const records: LogRecord[] = [];
beforeEach(() => {
  records.length = 0;
  log.configure({ sinks: [{ write: (record: LogRecord) => void records.push(record) } as never] });
});
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture(login?: string | { symlink: string }) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-codex-route-"));
  directories.push(root);
  const serviceHome = path.join(root, "service");
  const artifactsDirectory = path.join(root, "artifacts");
  const workspace = path.join(root, "workspace");
  await Promise.all([serviceHome, artifactsDirectory, workspace].map((d) => mkdir(d, { recursive: true })));
  if (typeof login === "string") await writeFile(path.join(serviceHome, "auth.json"), login);
  else if (login) {
    await writeFile(path.join(root, "elsewhere.json"), login.symlink);
    await symlink(path.join(root, "elsewhere.json"), path.join(serviceHome, "auth.json"));
  }
  return { serviceHome, artifactsDirectory, workspace };
}

const warnings = () => records.filter((record) => record.level === "warn");
const egress = { allow: ["example.com"] } as never;

describe("prepareCodexRun (shared by run, check and steering)", () => {
  test("a routed login gets no copy and no warning", async () => {
    const f = await fixture(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-fixture-REAL-KEY-1" }));
    const run = await prepareCodexRun({ ...f, variables: { CODEX_HOME: f.serviceHome }, egress });
    expect(run.route.routed).toBe(true);
    expect(run.promoteAuth).toBe(false);
    expect(existsSync(path.join(run.environment.CODEX_HOME!, "auth.json"))).toBe(false);
    expect(warnings()).toHaveLength(0);
  });

  test("a symlinked record is copied, so it is reported once", async () => {
    const real = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-fixture-REAL-KEY-1" });
    const f = await fixture({ symlink: real });
    const run = await prepareCodexRun({ ...f, variables: { CODEX_HOME: f.serviceHome }, egress });
    expect(run.route.routed).toBe(false);
    expect(await readFile(path.join(run.environment.CODEX_HOME!, "auth.json"), "utf8")).toBe(real);
    expect(warnings()).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("sk-fixture-REAL-KEY-1");
  });

  test("a key variable with no sandbox network is reported once", async () => {
    const f = await fixture();
    const run = await prepareCodexRun({ ...f, variables: { CODEX_HOME: f.serviceHome, OPENAI_API_KEY: "sk-fixture-ENV-KEY-1" }, egress: undefined });
    expect(run.route.routed).toBe(false);
    expect(run.environment.OPENAI_API_KEY).toBe("sk-fixture-ENV-KEY-1");
    expect(warnings()).toHaveLength(1);
    expect(String(warnings()[0]!.reason)).toContain("no sandbox network");
    expect(JSON.stringify(records)).not.toContain("sk-fixture-ENV-KEY-1");
  });

  test("no login at all stays quiet", async () => {
    const f = await fixture();
    const run = await prepareCodexRun({ ...f, variables: { CODEX_HOME: f.serviceHome }, egress: undefined });
    expect(run.route.routed).toBe(false);
    expect(warnings()).toHaveLength(0);
  });
});
