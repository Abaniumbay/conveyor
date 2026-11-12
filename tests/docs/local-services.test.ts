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
  expect(spec).toContain("Conveyor's wrapper is always Codex's only sandbox");
  expect(spec).toContain("network access for Codex and its commands is unrestricted, as for Claude Code");
  expect(spec).not.toContain("never disabled without the wrapper");
  expect(spec).toContain("A `danger-full-access` agent without `agentEgress` is confined by nothing beyond a private `/tmp`");
  expect(operations).toContain("A `danger-full-access` agent without `agentEgress` has only a private `/tmp`");
  expect(operations).toContain("Effective Codex confinement");
  expect(operations).toContain("Conveyor's wrapper is always Codex's only sandbox");
  expect(operations).toContain("network access for Codex and\nits commands is unrestricted, as for Claude Code");
  const architecture = await readFile(path.join(import.meta.dir, "../../docs/architecture.md"), "utf8");
  expect(architecture).toContain("Conveyor's wrapper is Codex's only sandbox in every launch");
});

test("operations guide describes opt-in auto-upgrade and no longer says there is none", async () => {
  const operations = await readFile(path.join(import.meta.dir, "../../docs/operations.md"), "utf8");

  expect(operations.toLowerCase()).not.toContain("no automatic upgrade");
  expect(operations).toContain("conveyor service auto-upgrade install");
  expect(operations).toContain("conveyor upgrade --latest --if-newer --no-wait");
  expect(operations).toContain("service auto-upgrade uninstall");
  expect(operations).toContain("minor ones included");
  expect(operations).toContain("cannot load your configuration, the switch stops");
});
