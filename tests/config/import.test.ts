import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfigError, loadConfig } from "../../src/config/load";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-import-"));
  directories.push(directory);
  return directory;
}

async function git(repository: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", repository, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

const LABELS = `
labels:
  stageTemplate: "conveyor:{stage}"
  states: { done: conveyor:done }
  metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" }
`;

function pipelineYaml(concurrency: number): string {
  return `
pipelines:
  default:
    stages:
      - id: deploy
        concurrency: ${concurrency}
        actions:
          - { id: deployScript, task: script.run, with: { script: ./stages/deploy.ts, recovery: replay-safe } }
        exit-gate:
          - { id: deployed, task: script.succeeded, with: { run: deployScript } }
`;
}

const AGENTS = `
runners:
  codex: { type: codex }
agents:
  kaveh:
    runner: codex
    instructions: ./instructions/kaveh.md
`;

/** A git repository holding reference configuration under examples/config. */
async function referenceRepository() {
  const repository = await temporaryDirectory();
  await git(repository, "init", "-q", "-b", "main");
  const base = path.join(repository, "examples/config");
  await write(path.join(base, "10-pipeline.yaml"), pipelineYaml(1));
  await write(path.join(base, "20-agents.yml"), AGENTS + "sources:\n  github: { type: github }\n" + LABELS);
  await write(path.join(base, "instructions/kaveh.md"), "v1 instructions\n");
  await write(path.join(base, "stages/deploy.ts"), "// v1 deploy\n");
  await write(path.join(base, "README.txt"), "not yaml\n");
  await git(repository, "add", "-A");
  await git(repository, "commit", "-q", "-m", "v1");
  await git(repository, "tag", "v1");
  const sha = await git(repository, "rev-parse", "HEAD");
  return { repository, base, sha };
}

function localYaml(repository: string, ref: string, extra = ""): string {
  return `
import: { repository: ${repository}, ref: ${ref}, path: examples/config }
settings:
  database: /tmp/conveyor.sqlite
  logs: /tmp/logs
  workspaces: /tmp/workspaces
  artifacts: ARTIFACTS
repositories:
  sample:
    source: github
    address: owner/sample
    folder: /tmp/sample
    pipeline: default
${extra}`;
}

async function localDirectory(repository: string, ref: string, extra = "") {
  const directory = await temporaryDirectory();
  const artifacts = path.join(directory, "artifacts");
  await write(path.join(directory, "local.yaml"), localYaml(repository, ref, extra).replace("ARTIFACTS", artifacts));
  return { directory, artifacts };
}

describe("pinned configuration import", () => {
  test("loads an imported pipeline with local repositories and compiles it", async () => {
    const { repository, sha } = await referenceRepository();
    const { directory, artifacts } = await localDirectory(repository, "v1");
    const config = await loadConfig(directory);
    expect(config.plans).toHaveLength(1);
    expect(config.pipelines.default?.stages).toHaveLength(1);
    expect(config.repositories.sample?.pipeline).toBe("default");
    expect(config.import).toEqual({ repository, ref: "v1", path: "examples/config", sha });
    expect(config.agents.kaveh?.instructions).toBe(path.join(artifacts, "config-imports", sha, "examples/config/instructions/kaveh.md"));
  });

  test("resolves relative paths into a materialised copy of every file at the ref", async () => {
    const { repository, sha } = await referenceRepository();
    const { directory, artifacts } = await localDirectory(repository, sha);
    const config = await loadConfig(directory);
    const copy = path.join(artifacts, "config-imports", sha, "examples/config");
    expect(await readFile(config.agents.kaveh!.instructions, "utf8")).toBe("v1 instructions\n");
    expect(await readFile(path.join(copy, "stages/deploy.ts"), "utf8")).toBe("// v1 deploy\n");
    expect(await readFile(path.join(copy, "10-pipeline.yaml"), "utf8")).toContain("deploy");
    const stage = config.pipelines.default!.stages[0]!;
    expect("actions" in stage && stage.actions[0]!.with?.script).toBe(path.join(copy, "stages/deploy.ts"));
    await expect(loadConfig(directory)).resolves.toMatchObject({ hash: config.hash });
  });

  test("ignores working-tree changes and later commits after the ref", async () => {
    const { repository, base, sha } = await referenceRepository();
    const { directory } = await localDirectory(repository, "v1");
    const before = await loadConfig(directory);
    await write(path.join(base, "instructions/kaveh.md"), "edited\n");
    await write(path.join(base, "10-pipeline.yaml"), pipelineYaml(9));
    await git(repository, "commit", "-q", "-am", "v2");
    await write(path.join(base, "10-pipeline.yaml"), pipelineYaml(8));
    const after = await loadConfig(directory);
    expect(after.import?.sha).toBe(sha);
    expect(after.hash).toBe(before.hash);
    expect(await readFile(after.agents.kaveh!.instructions, "utf8")).toBe("v1 instructions\n");
    expect(after.pipelines.default!.stages[0]!.concurrency).toBe(1);
  });

  test("the hash changes when the ref changes", async () => {
    const { repository, base } = await referenceRepository();
    await write(path.join(base, "10-pipeline.yaml"), pipelineYaml(2));
    await git(repository, "commit", "-q", "-am", "v2");
    const first = await loadConfig((await localDirectory(repository, "v1")).directory);
    const second = await loadConfig((await localDirectory(repository, "HEAD")).directory);
    expect(second.import?.sha).not.toBe(first.import?.sha);
    expect(second.hash).not.toBe(first.hash);
  });

  test("the hash changes with the ref even when the imported content is identical", async () => {
    const { repository } = await referenceRepository();
    await git(repository, "commit", "-q", "--allow-empty", "-m", "empty");
    const first = await loadConfig((await localDirectory(repository, "v1")).directory);
    const second = await loadConfig((await localDirectory(repository, "HEAD")).directory);
    expect(second.hash).not.toBe(first.hash);
  });

  test.each([
    ["pipeline", pipelineYaml(3), /pipelines.*"default"/],
    ["agent", "agents:\n  kaveh: { runner: codex, instructions: /tmp/x.md }\n", /agents.*"kaveh"/],
    ["runner", "runners:\n  codex: { type: json-process }\n", /runners.*"codex"/],
    ["provider", "sources:\n  github: { type: github }\n", /sources.*"github"/],
    ["labels", LABELS, /labels/],
  ])("rejects redefining an imported %s", async (_name, extra, pattern) => {
    const { repository } = await referenceRepository();
    const { directory } = await localDirectory(repository, "v1", extra);
    const failure = loadConfig(directory);
    await expect(failure).rejects.toThrow(ConfigError);
    await expect(failure).rejects.toThrow(pattern);
  });

  test("lets local files add entries next to imported ones", async () => {
    const { repository } = await referenceRepository();
    const { directory } = await localDirectory(
      repository,
      "v1",
      "  other:\n    source: github\n    address: owner/other\n    folder: /tmp/other\n    pipeline: default\n",
    );
    expect(Object.keys((await loadConfig(directory)).repositories)).toEqual(["sample", "other"]);
  });

  test("requires settings.artifacts locally", async () => {
    const { repository } = await referenceRepository();
    const directory = await temporaryDirectory();
    await write(
      path.join(directory, "local.yaml"),
      `import: { repository: ${repository}, ref: v1, path: examples/config }\nrepositories: {}\n`,
    );
    await expect(loadConfig(directory)).rejects.toThrow(/settings\.artifacts/);
  });

  test("rejects an unresolvable ref, a non-commit ref and a missing path", async () => {
    const { repository } = await referenceRepository();
    await expect(loadConfig((await localDirectory(repository, "nope")).directory)).rejects.toThrow(/ref "nope"/);
    const blob = await git(repository, "rev-parse", "HEAD:examples/config/README.txt");
    await expect(loadConfig((await localDirectory(repository, blob)).directory)).rejects.toThrow(/ref/);
    const { directory } = await localDirectory(repository, "v1");
    await write(path.join(directory, "local.yaml"), (await readFile(path.join(directory, "local.yaml"), "utf8")).replace("examples/config", "missing"));
    await expect(loadConfig(directory)).rejects.toThrow(/no YAML.*missing/);
  });

  test("rejects an import in more than one file and an unsafe path", async () => {
    const { repository } = await referenceRepository();
    const { directory } = await localDirectory(repository, "v1");
    await write(path.join(directory, "second.yaml"), `import: { repository: ${repository}, ref: v1, path: examples/config }\n`);
    await expect(loadConfig(directory)).rejects.toThrow(/only one.*import/);
    const other = await localDirectory(repository, "v1");
    await write(path.join(other.directory, "local.yaml"), (await readFile(path.join(other.directory, "local.yaml"), "utf8")).replace("examples/config", "../x"));
    await expect(loadConfig(other.directory)).rejects.toThrow(/import\.path/);
  });
});
