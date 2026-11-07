import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCli } from "../../src/cli/main";
import { ConveyorStore } from "../../src/db/store";
import { createOperatorMcpHandler } from "../../src/operator-mcp/server";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (text) => out.push(text), err: (text) => err.push(text), environment: {}, interactive: false });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function home(): Promise<string> {
  const root = await shortTemporaryDirectory("conveyor-mcp-", { socketPath: "home/run/control.sock" });
  directories.push(root);
  await writeFile(path.join(root, "password"), "correct horse battery\n");
  const target = path.join(root, "home");
  const init = await cli("init", "--home", target, "--admin-username", "admin", "--admin-password-file", path.join(root, "password"));
  expect(init.code).toBe(0);
  return target;
}

const database = (target: string) => path.join(target, "state/conveyor.sqlite");

/** The one-shot request the operator MCP endpoint answers, with the token as a bearer. */
async function request(handler: (request: Request) => Promise<Response>, token: string): Promise<number> {
  const response = await handler(new Request("http://localhost/operator-mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }));
  return response.status;
}

describe("conveyor mcp token", () => {
  test("create prints the token once and the database holds only its hash", async () => {
    const target = await home();
    const created = await cli("mcp", "token", "create", "laptop", "--home", target, "--json");
    expect(created.code).toBe(0);
    const { token, id } = JSON.parse(created.out) as { token: string; id: string };
    expect(token.length).toBeGreaterThan(20);
    const raw = new Database(database(target), { readonly: true });
    try {
      const rows = raw.query("SELECT * FROM operator_mcp_tokens").all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(id);
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(String(rows[0]!.token_hash)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      raw.close();
    }
    const text = await cli("mcp", "token", "create", "second", "--home", target);
    expect(text.out).toMatch(/cvop_\S+/);
  });

  test("list shows name, id, creation time and revoked state, never a token value", async () => {
    const target = await home();
    const created = JSON.parse((await cli("mcp", "token", "create", "laptop", "--home", target, "--json")).out) as { token: string; id: string };
    await cli("mcp", "token", "create", "ci", "--home", target);
    const before = await cli("mcp", "token", "list", "--home", target);
    expect(before.out).toContain("laptop");
    expect(before.out).toContain(created.id);
    expect(before.out).toContain("active");
    expect(before.out).not.toContain(created.token);
    await cli("mcp", "token", "revoke", created.id, "--home", target);
    const listed = JSON.parse((await cli("mcp", "token", "list", "--home", target, "--json")).out) as Array<Record<string, unknown>>;
    expect(listed.map((token) => token.name).sort()).toEqual(["ci", "laptop"]);
    const revoked = listed.find((token) => token.id === created.id)!;
    expect(typeof revoked.createdAt).toBe("string");
    expect(typeof revoked.revokedAt).toBe("string");
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(JSON.stringify(listed)).not.toContain("token_hash");
    expect((await cli("mcp", "token", "list", "--home", target)).out).toContain("revoked");
  });

  test("revoke makes the token's next MCP request fail with 401; an unknown id fails", async () => {
    const target = await home();
    const created = JSON.parse((await cli("mcp", "token", "create", "laptop", "--home", target, "--json")).out) as { token: string; id: string };
    const store = await ConveyorStore.open(database(target));
    try {
      const handler = createOperatorMcpHandler({ facade: { store, status: () => ({}), findItem: () => null, dispatch: () => { throw new Error("unused"); } }, tokenIsActive: (hash) => store.operatorMcpTokenIsActive(hash) });
      expect(await request(handler, created.token)).toBe(200);
      expect((await cli("mcp", "token", "revoke", created.id, "--home", target)).code).toBe(0);
      expect(await request(handler, created.token)).toBe(401);
    } finally {
      store.close();
    }
    expect((await cli("mcp", "token", "revoke", "missing", "--home", target)).code).toBe(1);
  });
});
