import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSink, formatRecord, Logger, Redactor, type LogRecord } from "../../src/log/logger";
import { followLog, logFiles, readLogRecords } from "../../src/log/reader";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-logs-"));
  directories.push(directory);
  return directory;
}

const record = (time: string, level: LogRecord["level"], message: string, fields: Record<string, unknown> = {}): LogRecord => ({ time, level, message, ...fields });

describe("Redactor", () => {
  test("removes configured secrets, credential environment values and token patterns", () => {
    const redactor = new Redactor(["hook-secret-value"], { GH_TOKEN: "env-token-value-123" });
    const text = redactor.text([
      "secret hook-secret-value and env-token-value-123",
      "gh token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "Authorization: Bearer abc.def.ghi-jkl",
      'headers {"authorization":"token zzzzzzzzzzzz"}',
      "curl -H 'proxy-authorization: Basic dXNlcjpwYXNz'",
    ].join("\n"));
    for (const leaked of ["hook-secret-value", "env-token-value-123", "ghp_abcdef", "github_pat_11", "sk-ant-api03", "abc.def.ghi", "zzzzzzzzzzzz", "dXNlcjpwYXNz"]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("Authorization: Bearer <redacted>");
    expect(redactor.value({ nested: ["hook-secret-value"], count: 3 })).toEqual({ nested: ["<redacted>"], count: 3 });
  });

  test("ignores values too short to redact safely", () => {
    expect(new Redactor(["abc"], {}).text("abc abcdef")).toBe("abc abcdef");
  });
});

describe("Logger", () => {
  test("filters by level, redacts every record and survives a failing sink", () => {
    const records: LogRecord[] = [];
    const logger = new Logger();
    logger.configure({
      level: "info",
      redactor: new Redactor(["top-secret-1"], {}),
      sinks: [{ write: () => { throw new Error("disk full"); } }, { write: (entry) => records.push(entry) }],
    });
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      logger.debug("hidden");
      logger.info("Stage started", { item: "conveyor:90", stage: "review" });
      logger.error("Provider failed", { repository: "conveyor" }, new Error("token top-secret-1 rejected"));
    } finally {
      process.stderr.write = stderr;
    }
    expect(records.map((entry) => entry.message)).toEqual(["Stage started", "Provider failed"]);
    expect(records[0]).toMatchObject({ level: "info", item: "conveyor:90", stage: "review" });
    expect(records[1]).toMatchObject({ level: "error", repository: "conveyor", error: "token <redacted> rejected" });
  });

  test("formats a readable line with the correlation fields", () => {
    expect(formatRecord(record("2026-10-06T10:00:00.000Z", "warn", "Stage stopped", { item: "conveyor:90", reason: "two words" })))
      .toBe('2026-10-06T10:00:00.000Z WARN  Stage stopped item=conveyor:90 reason="two words"');
  });
});

describe("FileSink", () => {
  test("rotates by size and keeps only the configured number of old files", async () => {
    const directory = await temporary();
    const sink = new FileSink(directory, 200, 2);
    for (let index = 0; index < 12; index += 1) sink.write(record(`2026-10-06T10:00:${String(index).padStart(2, "0")}.000Z`, "info", `message ${index}`));
    expect((await readdir(directory)).sort()).toEqual(["conveyor.log", "conveyor.log.1", "conveyor.log.2"]);
    for (const file of await logFiles(directory)) expect((await readFile(file)).byteLength).toBeLessThanOrEqual(200);
    const kept = (await readLogRecords(directory)).map((entry) => entry.message);
    expect(kept.at(-1)).toBe("message 11");
    expect(kept).toEqual([...kept].sort((left, right) => Number(left.split(" ")[1]) - Number(right.split(" ")[1])));
    expect(kept).not.toContain("message 0");
  });
});

describe("log reader", () => {
  test("reads rotations oldest first and filters by level, time, item and stage", async () => {
    const directory = await temporary();
    const line = (entry: LogRecord) => `${JSON.stringify(entry)}\n`;
    await writeFile(path.join(directory, "conveyor.log.2"), line(record("2026-10-06T08:00:00.000Z", "error", "oldest", { item: "conveyor:90" })));
    await writeFile(path.join(directory, "conveyor.log.1"), `${line(record("2026-10-06T09:00:00.000Z", "info", "middle", { item: "conveyor:91", stage: "review" }))}not json\n`);
    await writeFile(path.join(directory, "conveyor.log"), line(record("2026-10-06T10:00:00.000Z", "warn", "newest", { item: "conveyor:90", stage: "review" })));
    expect((await readLogRecords(directory)).map((entry) => entry.message)).toEqual(["oldest", "middle", "newest"]);
    expect((await readLogRecords(directory, { level: "warn" })).map((entry) => entry.message)).toEqual(["oldest", "newest"]);
    expect((await readLogRecords(directory, { since: Date.parse("2026-10-06T08:30:00Z") })).map((entry) => entry.message)).toEqual(["middle", "newest"]);
    expect((await readLogRecords(directory, { item: "conveyor:90", stage: "review" })).map((entry) => entry.message)).toEqual(["newest"]);
  });

  test("keeps records written just before a rotation the follower had not read yet", async () => {
    const directory = await temporary();
    const file = path.join(directory, "conveyor.log");
    await writeFile(file, "");
    const seen: string[] = [];
    const controller = new AbortController();
    const following = followLog(directory, {}, (entry) => seen.push(entry.message), controller.signal, 50);
    await Bun.sleep(80);
    // Between two polls: a record lands in the old file, which is then rotated.
    await appendFile(file, `${JSON.stringify(record("2026-10-06T10:00:01.000Z", "info", "last before rotation"))}\n`);
    await rename(file, `${file}.1`);
    await writeFile(file, `${JSON.stringify(record("2026-10-06T10:00:02.000Z", "info", "first after rotation"))}\n`);
    await Bun.sleep(150);
    controller.abort();
    await following;
    expect(seen).toEqual(["last before rotation", "first after rotation"]);
  });

  test("follows new records across a rotation", async () => {
    const directory = await temporary();
    const file = path.join(directory, "conveyor.log");
    await writeFile(file, `${JSON.stringify(record("2026-10-06T10:00:00.000Z", "info", "before"))}\n`);
    const seen: string[] = [];
    const controller = new AbortController();
    const following = followLog(directory, {}, (entry) => seen.push(entry.message), controller.signal, 20);
    await Bun.sleep(60);
    await appendFile(file, `${JSON.stringify(record("2026-10-06T10:00:01.000Z", "info", "appended"))}\n`);
    await Bun.sleep(80);
    await rename(file, `${file}.1`);
    await writeFile(file, `${JSON.stringify(record("2026-10-06T10:00:02.000Z", "info", "after rotation"))}\n`);
    await Bun.sleep(80);
    controller.abort();
    await following;
    expect(seen).toEqual(["appended", "after rotation"]);
  });
});
