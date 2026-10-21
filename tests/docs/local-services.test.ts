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

test("configuration guide shows a loopback TCP local service using the environment contract", async () => {
  const configuration = await readFile(path.join(import.meta.dir, "../../docs/configuration.md"), "utf8");

  expect(configuration).toContain('tcp: "127.0.0.1:6379"');
  expect(configuration).toContain("endpoint: 127.0.0.1:6379");
  expect(configuration).toContain("REDIS_URL: !secret redis_test_url");
  expect(configuration).toContain("`tcp` is a numeric loopback host listener");
});
