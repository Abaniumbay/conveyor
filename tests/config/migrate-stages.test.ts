import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

import { EXIT } from "../../src/cli/args";
import { runCli } from "../../src/cli/main";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (text) => out.push(text), err: (text) => err.push(text), environment: {}, interactive: false });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const cleanup = (script = "./a.ts") => `
      - id: cleanup
        concurrency: 1
        actions: [{ id: removeWorkspace, task: workspace.cleanup }]
        exit-gate:
          - { id: removed, task: workspace.removed, with: { note: "${script}" } }`;
const verify = `
      - id: verify
        concurrency: 1
        actions: [{ id: verifyScript, task: script.run, with: { script: /tmp/verify.ts, recovery: replay-safe } }]
        exit-gate: [{ id: verified, task: script.succeeded, with: { run: verifyScript } }]`;
const deploy = `
      - id: deploy
        concurrency: 1
        actions: [{ id: deployScript, task: script.run, with: { script: /tmp/deploy.ts, recovery: reconcile } }]
        exit-gate: [{ id: deployed, task: script.succeeded, with: { run: deployScript } }]`;

const repository = (name: string, pipeline: string) => `
  ${name}:
    source: github
    address: owner/${name}
    folder: /tmp/${name}
    pipeline: ${pipeline}`;

function configuration(pipelines: string, repositories: string): string {
  return `
settings: { database: /tmp/c.sqlite, logs: /tmp/logs, workspaces: /tmp/ws, artifacts: /tmp/art }
labels:
  stageTemplate: "conveyor:{stage}"
  states: { done: conveyor:done }
  metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" }
sources:
  github: { type: github }
pipelines:${pipelines}
repositories:${repositories}
`;
}

async function fixture(text: string): Promise<{ file: string; directory: string; home: string }> {
  const directory = await shortTemporaryDirectory("conveyor-migrate-stages-", { socketPath: "home/run/control.sock" });
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "conveyor.yaml");
  await writeFile(file, text);
  return { file, directory, home: path.join(directory, "home") };
}

const migrate = (file: string, home: string) => cli("config", "migrate", "--stages", "--from", file, "--home", home);
const migrated = async (directory: string) => parse(await readFile(path.join(directory, "conveyor.migrated.yaml"), "utf8")) as Record<string, any>;

describe("config migrate --stages", () => {
  test("one pipeline becomes stages and no pipeline: line remains", async () => {
    const { file, directory, home } = await fixture(configuration(`\n  main:\n    stages:${verify}${deploy}`, repository("one", "main")));
    const result = await migrate(file, home);
    expect(result.err).toBe("");
    expect(result.code).toBe(EXIT.ok);
    const text = await readFile(path.join(directory, "conveyor.migrated.yaml"), "utf8");
    expect(text).not.toMatch(/pipeline/);
    const document = await migrated(directory);
    expect(document.stages.map((stage: { id: string }) => stage.id)).toEqual(["verify", "deploy"]);
    expect(document.repositories.one.pipeline).toBeUndefined();
  });

  test("identical stage ids use the first pipeline and write differences as overrides; originals stay unchanged; compare reports no differences", async () => {
    const other = deploy.replace("/tmp/deploy.ts", "/tmp/other-deploy.ts");
    const text = configuration(
      `\n  a:\n    stages:${verify}${deploy}\n  b:\n    stages:${verify}${other}`,
      repository("first", "a") + repository("second", "b"),
    );
    const { file, directory, home } = await fixture(text);
    const result = await migrate(file, home);
    expect(result.err).toBe("");
    expect(result.code).toBe(EXIT.ok);
    const document = await migrated(directory);
    expect(document.stages[1].actions[0].with.script).toBe("/tmp/deploy.ts");
    expect(document.repositories.first.overrides).toBeUndefined();
    expect(document.repositories.second.overrides.stages.deploy.actions.deployScript.with.script).toBe("/tmp/other-deploy.ts");
    expect(await readFile(file, "utf8")).toBe(text);
    expect(await readdir(directory)).toContain("conveyor.migrated.yaml");
    // `config compare` of the old and new plans, once per repository, with no differences.
    expect(result.out).toContain("first");
    expect(result.out).toContain("second");
    expect(result.out.match(/no differences/g)).toHaveLength(2);
  });

  test("a stage in only some pipelines is placed in its position and skipped by the repositories without it", async () => {
    const { file, directory, home } = await fixture(
      configuration(
        `\n  full:\n    stages:${verify}${deploy}${cleanup()}\n  short:\n    stages:${verify}${cleanup()}\n  unused:\n    stages:${cleanup()}`,
        repository("full", "full") + repository("short", "short"),
      ),
    );
    const result = await migrate(file, home);
    expect(result.err).toBe("");
    expect(result.code).toBe(EXIT.ok);
    const document = await migrated(directory);
    expect(document.stages.map((stage: { id: string }) => stage.id)).toEqual(["verify", "deploy", "cleanup"]);
    expect(document.repositories.short.overrides.stages.deploy).toEqual({ skip: true });
    expect(document.repositories.full.overrides).toBeUndefined();
    expect(document.pipelines).toBeUndefined();
    // The only reported differences are the newly skipped stage.
    expect(result.out).toContain("Repository short");
    expect(result.out).toContain("Stage deploy (only in");
    expect(result.out.match(/no differences/g)).toHaveLength(1);
  });

  test("differently ordered pipelines exit non-zero, list each repository's order and write no file", async () => {
    const { file, directory, home } = await fixture(
      configuration(`\n  a:\n    stages:${verify}${deploy}\n  b:\n    stages:${deploy}${verify}`, repository("first", "a") + repository("second", "b")),
    );
    const result = await migrate(file, home);
    expect(result.code).not.toBe(EXIT.ok);
    expect(result.err).toContain("first (pipeline a): verify, deploy");
    expect(result.err).toContain("second (pipeline b): deploy, verify");
    expect(await readdir(directory)).toEqual(["conveyor.yaml"]);
  });

  test("compatible partial orders merge into one list instead of being rejected", async () => {
    const { file, directory, home } = await fixture(
      configuration(
        `\n  ac:\n    stages:${verify}${cleanup()}\n  bc:\n    stages:${deploy}${cleanup()}\n  abc:\n    stages:${verify}${deploy}${cleanup()}`,
        repository("one", "ac") + repository("two", "bc") + repository("three", "abc"),
      ),
    );
    const result = await migrate(file, home);
    expect(result.err).toBe("");
    expect(result.code).toBe(EXIT.ok);
    const document = await migrated(directory);
    expect(document.stages.map((stage: { id: string }) => stage.id)).toEqual(["verify", "deploy", "cleanup"]);
  });

  test("a repository's existing overrides are kept next to the generated ones", async () => {
    const other = deploy.replace("/tmp/deploy.ts", "/tmp/other-deploy.ts");
    const text = configuration(
      `\n  a:\n    stages:${verify}${deploy}\n  b:\n    stages:${verify}${other}`,
      repository("first", "a") + repository("second", "b") +
        "\n    overrides:\n      stages:\n        deploy:\n          actions:\n            deployScript:\n              wait: { timeout: 5m }",
    );
    const { file, directory, home } = await fixture(text);
    const result = await migrate(file, home);
    expect(result.err).toBe("");
    expect(result.code).toBe(EXIT.ok);
    const deployOverride = (await migrated(directory)).repositories.second.overrides.stages.deploy.actions.deployScript;
    expect(deployOverride.with.script).toBe("/tmp/other-deploy.ts");
    expect(deployOverride.wait).toEqual({ timeout: "5m" });
  });

  test("a pipeline with a tagged value inside its stages is refused and nothing is written", async () => {
    const tagged = deploy.replace("/tmp/deploy.ts", "!secret deploy_script");
    const { file, directory, home } = await fixture(
      configuration(`\n  a:\n    stages:${verify}${tagged}`, repository("first", "a")),
    );
    const result = await migrate(file, home);
    expect(result.code).not.toBe(EXIT.ok);
    expect(result.err).toContain("!secret");
    expect(await readdir(directory)).toEqual(["conveyor.yaml"]);
  });
});
