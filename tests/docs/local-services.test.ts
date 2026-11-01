import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("configuration guide shows a Unix local service and its secret-backed command variable", async () => {
  const configuration = await readFile(path.join(import.meta.dir, "../../docs/configuration.md"), "utf8");

  expect(configuration).toContain("localServices:");
  expect(configuration).toContain("socket: /run/postgresql/.s.PGSQL.5432");
  expect(configuration).toContain("endpoint: 127.0.0.1:5432");
  expect(configuration).toContain("DATABASE_URL: !secret postgres_test_url");
  expect(configuration).toContain("Values under `environment` are set only for those commands");
});

test("operations guide explains test-database provisioning without the Docker socket", async () => {
  const operations = await readFile(path.join(import.meta.dir, "../../docs/operations.md"), "utf8");

  expect(operations).toContain("Provision one test database per repository");
  expect(operations).toContain("agentEgress.localServices");
  expect(operations).toContain("they never receive the Docker socket");
});

test("configuration guide shows a loopback TCP local service using the environment contract", async () => {
  const configuration = await readFile(path.join(import.meta.dir, "../../docs/configuration.md"), "utf8");

  expect(configuration).toContain('tcp: "127.0.0.1:6379"');
  expect(configuration).toContain("endpoint: 127.0.0.1:6379");
  expect(configuration).toContain("REDIS_URL: !secret redis_test_url");
  expect(configuration).toContain("`tcp` is a numeric loopback host listener");
});

test("SPEC and operations guide name the Codex confinement layer for each launch mode", async () => {
  const spec = await readFile(path.join(import.meta.dir, "../../SPEC.md"), "utf8");
  const operations = await readFile(path.join(import.meta.dir, "../../docs/operations.md"), "utf8");

  expect(spec).toContain("Codex confinement layer by launch mode");
  expect(spec).toContain("solely by Conveyor's wrapper");
  expect(spec).toContain("never disabled without the wrapper");
  expect(operations).toContain("Effective Codex confinement");
  expect(operations).toContain("Conveyor's wrapper is the only filesystem and network");
});
