import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

import { CliError, EXIT, parseArgs } from "../../src/cli/args";
import { doctorChecks } from "../../src/cli/commands/doctor";
import { runCli } from "../../src/cli/main";
import { Database } from "bun:sqlite";
import { ConveyorStore, databaseSchemaVersion, LATEST_SCHEMA_VERSION } from "../../src/db/store";
import { verifyPassword } from "../../src/web/auth";
import { referenceConfigDirectory } from "../config/reference-fixture";

const LEGACY = path.resolve(import.meta.dir, "../fixtures/legacy-pipeline");
const EXAMPLES = path.resolve(import.meta.dir, "../../examples/config");
const PASSWORD = "correct horse battery";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-cli-"));
  directories.push(directory);
  return directory;
}

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (text) => out.push(text), err: (text) => err.push(text), environment: {}, interactive: false });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** An initialised home with an administrator, its password read from a file. */
async function initialisedHome(): Promise<string> {
  const root = await temporary();
  const home = path.join(root, "home");
  await writeFile(path.join(root, "password"), `${PASSWORD}\n`);
  const result = await cli("init", "--home", home, "--admin-username", "admin", "--admin-password-file", path.join(root, "password"));
  expect(result.err).toBe("");
  expect(result.code).toBe(EXIT.ok);
  return home;
}

async function mode(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777;
}

describe("parseArgs", () => {
  const specs = { home: { type: "string", description: "" }, json: { type: "boolean", description: "" } } as const;

  test("reads --name value, --name=value, flags and positionals", () => {
    expect(parseArgs(["a", "--home", "/h", "b", "--json"], specs)).toEqual({ positionals: ["a", "b"], options: { home: "/h", json: true } });
    expect(parseArgs(["--home=/x", "--", "--json"], specs)).toEqual({ positionals: ["--json"], options: { home: "/x" } });
  });

  test("unknown, repeated and value-less options are usage errors", () => {
    for (const argv of [["--nope"], ["--home", "/a", "--home", "/b"], ["--home"], ["--home", "--json"], ["--json=1"]]) {
      const error = (() => { try { parseArgs(argv, specs); } catch (caught) { return caught; } })();
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(EXIT.usage);
    }
  });
});

describe("conveyor", () => {
  test("--version and version report the version and build metadata", async () => {
    const plain = await cli("--version");
    expect(plain.code).toBe(0);
    expect(plain.out).toMatch(/^conveyor \d+\.\d+\.\d+ \(development build, bun /);
    const json = JSON.parse((await cli("version", "--json")).out) as { version: string; commit: string; compiled: boolean };
    expect(json.commit).toBe("development");
    expect(json.compiled).toBe(false);
  });

  test("help lists the commands; unknown commands and options exit 2", async () => {
    const help = await cli("--help");
    expect(help.code).toBe(0);
    for (const command of ["init", "doctor", "config check", "config migrate", "serve", "admin reset-password"]) expect(help.out).toContain(command);
    expect(help.out).not.toContain("check-config");
    expect((await cli("frobnicate")).code).toBe(EXIT.usage);
    expect((await cli("config", "check", "--nope")).code).toBe(EXIT.usage);
    const commandHelp = await cli("init", "--help");
    expect(commandHelp.out).toContain("--admin-password-file <file|->");
  });
});

describe("conveyor init", () => {
  test("creates the home layout, a valid starter configuration, the administrator and the session secret", async () => {
    const home = await initialisedHome();
    for (const directory of ["config", "state", "logs", "artifacts", "worktrees", "run"]) {
      expect((await stat(path.join(home, directory))).isDirectory()).toBe(true);
    }
    expect(await mode(home)).toBe(0o700);
    expect(await readFile(path.join(home, "config/.gitignore"), "utf8")).toBe("secrets.yaml\n");
    expect(await mode(path.join(home, "config/secrets.yaml"))).toBe(0o600);
    expect(await mode(path.join(home, "state/session-secret"))).toBe(0o600);
    expect((await readFile(path.join(home, "state/session-secret"), "utf8")).trim().length).toBeGreaterThanOrEqual(32);

    const store = await ConveyorStore.open(path.join(home, "state/conveyor.sqlite"));
    const accounts = store.dashboardAccounts();
    store.close();
    expect(accounts.map(({ username, role }) => ({ username, role }))).toEqual([{ username: "admin", role: "superuser" }]);
    expect(verifyPassword(PASSWORD, accounts[0]!.passwordHash)).toBe(true);

    const check = await cli("config", "check", "--home", home);
    expect(check.code).toBe(0);
    expect(check.out).toStartWith("Configuration is valid");
  });

  test("is safe to repeat: keeps existing files and accounts, and only adds secrets.yaml to an existing .gitignore", async () => {
    const home = await initialisedHome();
    const config = path.join(home, "config/conveyor.yaml");
    await writeFile(config, `${await readFile(config, "utf8")}# operator edit\n`);
    await writeFile(path.join(home, "config/.gitignore"), "*.bak");
    const secret = await readFile(path.join(home, "state/session-secret"), "utf8");

    const again = await cli("init", "--home", home, "--json");
    expect(again.code).toBe(0);
    const report = JSON.parse(again.out) as { created: string[]; administrator: { created: boolean; username: string } };
    expect(report.administrator).toEqual({ created: false, username: "admin" });
    expect(report.created).toEqual([path.join(home, "config/.gitignore")]);
    expect(await readFile(config, "utf8")).toEndWith("# operator edit\n");
    expect(await readFile(path.join(home, "config/.gitignore"), "utf8")).toBe("*.bak\nsecrets.yaml\n");
    expect(await readFile(path.join(home, "state/session-secret"), "utf8")).toBe(secret);
  });

  test("without a terminal it needs the administrator's username and password file; short passwords are refused", async () => {
    const root = await temporary();
    const missing = await cli("init", "--home", path.join(root, "a"));
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.err).toContain("--admin-username and --admin-password-file");

    await writeFile(path.join(root, "short"), "short\n");
    const short = await cli("init", "--home", path.join(root, "b"), "--admin-username", "admin", "--admin-password-file", path.join(root, "short"));
    expect(short.code).toBe(EXIT.usage);
    expect(short.err).toContain("at least 12 characters");
    expect(short.err).not.toContain("short\n");

    const badName = await cli("init", "--home", path.join(root, "c"), "--admin-username", "no spaces", "--admin-password-file", path.join(root, "short"));
    expect(badName.code).toBe(EXIT.usage);
  });
});

describe("conveyor config", () => {
  test("show prints the effective configuration with !secret values redacted", async () => {
    const home = await initialisedHome();
    await writeFile(path.join(home, "config/secrets.yaml"), `session: "${"x".repeat(40)}"\n`);
    const config = path.join(home, "config/conveyor.yaml");
    await writeFile(config, (await readFile(config, "utf8")).replace("web:\n", "web:\n  sessionSecret: !secret session\n"));
    const shown = await cli("config", "show", "--home", home);
    expect(shown.code).toBe(0);
    expect(shown.out).not.toContain("x".repeat(40));
    expect(shown.out).toContain("sessionSecret: <redacted>");
    const json = JSON.parse((await cli("config", "show", "--home", home, "--json")).out) as { web: { sessionSecret: string } };
    expect(json.web.sessionSecret).toBe("<redacted>");
  });

  test("an invalid configuration exits 3 and names the file and key", async () => {
    const home = await initialisedHome();
    await writeFile(path.join(home, "config/repositories/broken.yaml"), "pipeline: nope\n");
    const result = await cli("config", "check", "--home", home);
    expect(result.code).toBe(EXIT.config);
    expect(result.err).toContain("- repositories/broken.yaml: ");
  });

  test("builtin lists and prints the packaged defaults", async () => {
    const list = await cli("config", "builtin");
    expect(list.out.split("\n")).toContain("builtin:agents.yaml");
    const agents = await cli("config", "builtin", "builtin:agents.yaml");
    expect(agents.out).toBe((await readFile(path.join(EXAMPLES, "agents.yaml"), "utf8")).trimEnd());
    expect((await cli("config", "builtin", "nope.yaml")).code).toBe(EXIT.usage);
  });
});

describe("conveyor config migrate", () => {
  async function migrate(from: string): Promise<{ code: number; out: string; target: string; home: string }> {
    const root = await temporary();
    const target = path.join(root, "migrated");
    const result = await cli("config", "migrate", "--from", from, "--to", target, "--home", path.join(root, "home"));
    return { ...result, target, home: path.join(root, "home") };
  }

  test("reproduces the production-shaped legacy directory with identical plans and configuration", async () => {
    const result = await migrate(LEGACY);
    expect(result.out).toContain("Compiled plans identical: yes");
    expect(result.out).toContain("Effective configuration identical: yes");
    expect(result.code).toBe(0);
    const entrypoint = await readFile(path.join(result.target, "conveyor.yaml"), "utf8");
    expect(entrypoint).toContain("providers: !include providers.yaml");
    expect(entrypoint).toContain("repositories: !include_dir_named repositories/");
    // The v0.1 default port is written out, so the dashboard does not move.
    expect(entrypoint).toContain("listen: 127.0.0.1:4300");
    expect(await readFile(path.join(result.target, ".gitignore"), "utf8")).toBe("secrets.yaml\n");
    const compare = await cli("config", "compare", LEGACY, path.join(result.target, "conveyor.yaml"), "--home", result.home);
    expect(compare.code).toBe(0);
  });

  test("copies instruction files into the new configuration", async () => {
    const { directory, base } = await referenceConfigDirectory();
    directories.push(base);
    const result = await migrate(directory);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Copied instructions:");
    expect(await readFile(path.join(result.target, "instructions/kaveh.md"), "utf8")).toBe(await readFile(path.join(EXAMPLES, "instructions/kaveh.md"), "utf8"));
    const agents = parse(await readFile(path.join(result.target, "agents.yaml"), "utf8")) as Record<string, { instructions: string }>;
    expect(agents.kaveh!.instructions).toBe("./instructions/kaveh.md");
  });

  test("inlines a pinned import from a Git checkout", async () => {
    const root = await temporary();
    const reference = path.join(root, "reference");
    await mkdir(path.join(reference, "config/instructions"), { recursive: true });
    const { directory } = await referenceConfigDirectory();
    directories.push(path.dirname(directory));
    for (const file of ["providers.yaml", "harnesses.yaml", "agents.yaml", "pipelines.yaml"]) {
      await writeFile(path.join(reference, "config", file), await readFile(path.join(directory, file), "utf8"));
    }
    for (const file of ["darya.md", "kaveh.md", "omid.md", "reviewer.md"]) {
      await writeFile(path.join(reference, "config/instructions", file), await readFile(path.join(directory, "instructions", file), "utf8"));
    }
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", reference, ...args], { stdout: "ignore", stderr: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reference");
    const local = path.join(root, "local");
    await mkdir(local);
    const localDocument = parse(await readFile(path.join(directory, "local.yaml"), "utf8")) as Record<string, unknown>;
    await writeFile(path.join(local, "local.yaml"), stringify({ import: { repository: reference, ref: "main", path: "config" }, ...localDocument }));

    const result = await migrate(local);
    expect(result.out).toContain("Compiled plans identical: yes");
    expect(result.out).toContain("Effective configuration identical: yes");
    expect(result.out).toContain("The pinned import (main = ");
    expect(result.code).toBe(0);
  });

  test("keeps !secret references: no secret value is written into the migrated files, which stay identical", async () => {
    const root = await temporary();
    const source = path.join(root, "source");
    await mkdir(path.join(source, "repositories"), { recursive: true });
    const labels = '{ enrollment: conveyor, stageTemplate: "conveyor:{stage}", states: { done: conveyor:done }, metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" } }';
    await writeFile(path.join(source, "secrets.yaml"), `hook: hook-secret-value-1\nsession: "${"s".repeat(40)}"\nunused: never-referenced\n`);
    await writeFile(path.join(source, "conveyor.yaml"), [
      "web:", "  sessionSecret: !secret session",
      "providers:", "  items:", `    github: { type: github, webhookSecret: !secret hook, labels: ${labels} }`, "",
    ].join("\n"));
    const result = await migrate(path.join(source, "conveyor.yaml"));
    expect(result.out).toContain("Effective configuration identical: yes");
    expect(result.out).toContain("2 secret value(s) stay in secrets.yaml");
    expect(result.code).toBe(0);
    for (const file of ["conveyor.yaml", "providers.yaml", ".gitignore"]) {
      const text = await readFile(path.join(result.target, file), "utf8");
      expect(text).not.toContain("hook-secret-value-1");
      expect(text).not.toContain("s".repeat(40));
    }
    expect(await readFile(path.join(result.target, "providers.yaml"), "utf8")).toContain("webhookSecret: !secret hook");
    expect(await readFile(path.join(result.target, "conveyor.yaml"), "utf8")).toContain("sessionSecret: !secret session");
    const secrets = parse(await readFile(path.join(result.target, "secrets.yaml"), "utf8")) as Record<string, string>;
    expect(secrets).toEqual({ hook: "hook-secret-value-1", session: "s".repeat(40) });
    expect(await mode(path.join(result.target, "secrets.yaml"))).toBe(0o600);
  });

  test("restores each !secret by where it was: equal plain values stay plain, keys sharing a value keep their own", async () => {
    const root = await temporary();
    const source = path.join(root, "source");
    await mkdir(source, { recursive: true });
    // hook's value equals the enrollment label, written in plain text; session and backup share one value.
    await writeFile(path.join(source, "secrets.yaml"), `hook: conveyor\nsession: "${"s".repeat(40)}"\nbackup: "${"s".repeat(40)}"\n`);
    await writeFile(path.join(source, "conveyor.yaml"), [
      "web:", "  sessionSecret: !secret backup",
      "providers:", "  items:",
      '    github: { type: github, webhookSecret: !secret hook, labels: { enrollment: conveyor, stageTemplate: "conveyor:{stage}", states: { done: conveyor:done }, metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" } } }',
      "",
    ].join("\n"));
    const result = await migrate(path.join(source, "conveyor.yaml"));
    expect(result.out).toContain("Effective configuration identical: yes");
    const providers = await readFile(path.join(result.target, "providers.yaml"), "utf8");
    expect(providers).toContain("webhookSecret: !secret hook");
    const entrypoint = await readFile(path.join(result.target, "conveyor.yaml"), "utf8");
    // The shared labels block is written at the top level; its value stays plain.
    expect(entrypoint).toContain("enrollment: conveyor");
    expect(entrypoint).not.toContain("!secret hook");
    expect(entrypoint).toContain("sessionSecret: !secret backup");
    expect(parse(await readFile(path.join(result.target, "secrets.yaml"), "utf8"))).toEqual({ backup: "s".repeat(40), hook: "conveyor" });
  });

  test("refuses a non-empty target", async () => {
    const root = await temporary();
    await writeFile(path.join(root, "keep"), "");
    const result = await cli("config", "migrate", "--from", LEGACY, "--to", root, "--home", path.join(root, "home"));
    expect(result.code).toBe(EXIT.config);
    expect(result.err).toContain("must not exist or must be an empty directory");
  });
});

describe("conveyor admin reset-password", () => {
  test("changes the password and signs out existing sessions; an unknown user fails", async () => {
    const home = await initialisedHome();
    const file = path.join(path.dirname(home), "new-password");
    await writeFile(file, "a much newer password\n");
    const result = await cli("admin", "reset-password", "admin", "--home", home, "--password-file", file);
    expect(result.code).toBe(0);
    const store = await ConveyorStore.open(path.join(home, "state/conveyor.sqlite"));
    const account = store.dashboardAccountByUsername("admin")!;
    store.close();
    expect(verifyPassword("a much newer password", account.passwordHash)).toBe(true);
    expect(account.sessionVersion).toBe(2);
    expect((await cli("admin", "reset-password", "nobody", "--home", home, "--password-file", file)).code).toBe(EXIT.failure);
  });
});

describe("conveyor serve", () => {
  test("refuses to start without a dashboard account and points at init", async () => {
    const root = await temporary();
    const home = path.join(root, "home");
    await mkdir(path.join(home, "config/repositories"), { recursive: true });
    await writeFile(path.join(home, "config/conveyor.yaml"), "providers: !include builtin:providers.yaml\nharnesses: !include builtin:harnesses.yaml\nweb: { listen: 127.0.0.1:0 }\n");
    const result = await cli("serve", "--home", home);
    expect(result.code).toBe(EXIT.failure);
    expect(result.err).toBe(`no dashboard account exists: run conveyor init --home ${home}`);
  });
});

describe("commands that open the database directly", () => {
  test("never migrate an existing database: doctor reads it read-only, admin refuses an older schema", async () => {
    const home = await initialisedHome();
    const database = path.join(home, "state/conveyor.sqlite");
    // Make it look like a database an older release left behind.
    const raw = new Database(database);
    raw.query("DELETE FROM schema_migrations WHERE version = ?").run(LATEST_SCHEMA_VERSION);
    raw.close();
    const checks = await doctorChecks(home, path.join(home, "config/conveyor.yaml"), async () => false);
    expect(checks.find((check) => check.name === "dashboard")).toMatchObject({ status: "ok", detail: "1 account(s)" });
    expect(databaseSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION - 1);

    const file = path.join(path.dirname(home), "new-password");
    await writeFile(file, "a much newer password\n");
    const reset = await cli("admin", "reset-password", "admin", "--home", home, "--password-file", file);
    expect(reset.code).toBe(EXIT.failure);
    expect(reset.err).toContain("this command does not migrate it");
    expect(databaseSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION - 1);
  });
});

describe("conveyor doctor", () => {
  const find = (checks: Awaited<ReturnType<typeof doctorChecks>>, name: string) => checks.find((check) => check.name === name);

  test("a missing home fails with the init fix", async () => {
    const root = await temporary();
    const result = await cli("doctor", "--home", path.join(root, "absent"), "--json");
    expect(result.code).toBe(EXIT.failure);
    const report = JSON.parse(result.out) as { ok: boolean; checks: Array<{ name: string; status: string; fix?: string }> };
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "home")).toMatchObject({ status: "fail", fix: `conveyor init --home ${path.join(root, "absent")}` });
  });

  test("reports a repository that is not a checkout and a listen port taken by another process", async () => {
    const home = await initialisedHome();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const config = path.join(home, "config/conveyor.yaml");
      await writeFile(config, (await readFile(config, "utf8")).replace("127.0.0.1:7788", `127.0.0.1:${port}`));
      await writeFile(path.join(home, "config/repositories/app.yaml"), [
        "items: github", "code: github", "ci: { mode: disabled }", "address: o/app", `folder: ${path.join(home, "missing")}`,
        "pipeline: delivery", "agentEgress: { allowLoopbackMcp: true, httpsHosts: [registry.npmjs.org] }", "",
      ].join("\n"));
      const checks = await doctorChecks(home, config, async () => false);
      expect(find(checks, "configuration")?.status).toBe("ok");
      expect(find(checks, "dashboard")?.status).toBe("ok");
      expect(find(checks, "repository app")).toMatchObject({ status: "fail", detail: `${path.join(home, "missing")} is not a Git checkout` });
      expect(find(checks, "listen")).toMatchObject({ status: "fail", detail: `127.0.0.1:${port} is in use by another process` });
      const running = await doctorChecks(home, config, async () => true);
      expect(find(running, "listen")?.status).toBe("ok");
    } finally {
      blocker.close();
    }
  });
});
