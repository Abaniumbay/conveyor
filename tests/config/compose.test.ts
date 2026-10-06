import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { builtinDigest, builtinResolver } from "../../src/config/builtin";
import { composeConfig, redactSecrets } from "../../src/config/compose";
import { ConfigError, loadConfig } from "../../src/config/load";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Writes the files (relative path -> content) into a fresh home and returns its paths. */
async function home(files: Record<string, string>): Promise<{ home: string; config: string; entrypoint: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-compose-"));
  directories.push(root);
  const config = path.join(root, "config");
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(config, file)), { recursive: true });
    await writeFile(path.join(config, file), content);
  }
  return { home: root, config, entrypoint: path.join(config, "conveyor.yaml") };
}

const DEFAULTS = `providers: !include builtin:providers.yaml
harnesses: !include builtin:harnesses.yaml
agents: !include builtin:agents.yaml
pipelines: !include builtin:pipelines.yaml
`;

const LABELS = `{ enrollment: conveyor, stageTemplate: "conveyor:{stage}", states: { done: conveyor:done }, metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" } }`;

const repository = (folder: string, pipeline = "delivery") => `items: github
code: github
ci: { mode: disabled }
address: owner/meal-planner
folder: ${folder}
pipeline: ${pipeline}
agentEgress: { allowLoopbackMcp: true, httpsHosts: [registry.npmjs.org] }
overrides:
  stages:
    deploy:
      actions:
        deployScript: { with: { script: ./scripts/deploy.ts, recovery: replay-safe } }
`;

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ConfigError);
  return (error as Error).message;
}

describe("single entrypoint", () => {
  test("a self-contained conveyor.yaml loads, with unset state paths defaulting to the home layout", async () => {
    const paths = await home({
      "conveyor.yaml": `${DEFAULTS}repositories:\n  meal-planner:\n${repository("../repos/meal-planner").replace(/^/gm, "    ")}`,
    });
    const config = await loadConfig(paths.entrypoint, undefined, { home: paths.home });
    expect(config.mode).toBe("entrypoint");
    expect(config.warnings).toEqual([]);
    expect(config.settings.database).toBe(path.join(paths.home, "state/conveyor.sqlite"));
    expect(config.settings.logs).toBe(path.join(paths.home, "logs"));
    expect(config.settings.workspaces).toBe(path.join(paths.home, "worktrees"));
    expect(config.settings.artifacts).toBe(path.join(paths.home, "artifacts"));
    expect(config.web.listen).toBe("127.0.0.1:7788");
    expect(config.repositories["meal-planner"]!.folder).toBe(path.join(paths.home, "repos/meal-planner"));
    expect(config.plans.map((plan) => plan.repositoryId)).toEqual(["meal-planner"]);
  });

  test("split with every tag: paths resolve relative to the file that declares them", async () => {
    const paths = await home({
      "conveyor.yaml": `settings: !include settings.yaml
web:
  listen: 127.0.0.1:7790
${DEFAULTS}repositories: !include_dir_named repositories/
`.replace("agents: !include builtin:agents.yaml", "agents: !include_dir_merge_named agents/"),
      "settings.yaml": "runners: 2\ndatabase: state/db.sqlite\n",
      "agents/00-builtin.yaml": "",
      "agents/10-local.yaml": `helper:
  name: Helper
  title: Assistant
  harness: codex
  model: gpt-test
  effort: low
  instructions: ./instructions/helper.md
  access: read-only
  tasks: [item.get]
`,
      "repositories/meal-planner.yaml": repository("~/codes/meal-planner"),
      "repositories/nested/ignored.yaml": "not: loaded\n",
      "repositories/README.md": "not yaml\n",
    });
    const config = await loadConfig(paths.entrypoint, null, { home: paths.home });
    expect(config.settings.runners).toBe(2);
    expect(config.settings.database).toBe(path.join(paths.config, "state/db.sqlite"));
    expect(config.web.listen).toBe("127.0.0.1:7790");
    expect(Object.keys(config.agents)).toEqual(["helper"]);
    expect(config.agents.helper!.instructions).toBe(path.join(paths.config, "agents/instructions/helper.md"));
    expect(Object.keys(config.repositories)).toEqual(["meal-planner"]);
    const meal = config.repositories["meal-planner"]!;
    expect(meal.folder).toBe(path.join(homedir(), "codes/meal-planner"));
    const override = meal.overrides!.stages.deploy!.actions!.deployScript as { with: { script: string } };
    expect(override.with.script).toBe(path.join(paths.config, "repositories/scripts/deploy.ts"));
  });

  test("nested includes resolve relative to each including file", async () => {
    const paths = await home({
      "conveyor.yaml": `web: !include parts/web.yaml\n${DEFAULTS}`,
      "parts/web.yaml": "listen: 127.0.0.1:7791\nsteering: !include steering/steering.yaml\n",
      "parts/steering/steering.yaml": "agent: omid\nworkspace: ./workspace\n",
    });
    const config = await loadConfig(paths.entrypoint, null, { home: paths.home });
    expect(config.web.listen).toBe("127.0.0.1:7791");
    expect(config.web.steering).toEqual({ agent: "omid", workspace: path.join(paths.config, "parts/steering/workspace") });

    await writeFile(path.join(paths.config, "parts/steering/steering.yaml"), "agent: nobody\nworkspace: ./workspace\n");
    expect(await failure(loadConfig(paths.entrypoint, null, { home: paths.home }))).toContain('- parts/steering/steering.yaml: agent references unknown agent "nobody"');
  });

  test("an include cycle is rejected with the include chain", async () => {
    const paths = await home({
      "conveyor.yaml": "agents: !include a.yaml\n",
      "a.yaml": "x: !include b.yaml\n",
      "b.yaml": "y: !include a.yaml\n",
    });
    expect(await failure(composeConfig(paths.entrypoint))).toBe("include cycle: conveyor.yaml -> a.yaml -> b.yaml -> a.yaml");
  });

  test("duplicate keys from directory tags are rejected, naming both files", async () => {
    const merged = await home({
      "conveyor.yaml": "agents: !include_dir_merge_named agents/\n",
      "agents/a.yaml": "kaveh: { name: A }\n",
      "agents/b.yaml": "kaveh: { name: B }\n",
    });
    expect(await failure(composeConfig(merged.entrypoint))).toBe("agents/b.yaml: kaveh: duplicate key: also defined by agents/a.yaml");

    const named = await home({
      "conveyor.yaml": "repositories: !include_dir_named repositories/\n",
      "repositories/caravan.yaml": "folder: /a\n",
      "repositories/caravan.yml": "folder: /b\n",
    });
    expect(await failure(composeConfig(named.entrypoint))).toBe('conveyor.yaml: repositories: duplicate key "caravan" from repositories/caravan.yml: also defined by repositories/caravan.yaml');
  });

  test("directory tags read files in a stable (sorted) order", async () => {
    const paths = await home({
      "conveyor.yaml": "repositories: !include_dir_named repositories/\nagents: !include_dir_merge_named agents/\n",
      "repositories/b.yaml": "n: 2\n",
      "repositories/a.yml": "n: 1\n",
      "agents/z.yaml": "zed: 1\n",
      "agents/m.yaml": "em: 1\n",
    });
    const { document } = await composeConfig(paths.entrypoint);
    expect(Object.keys(document.repositories as object)).toEqual(["a", "b"]);
    expect(Object.keys(document.agents as object)).toEqual(["em", "zed"]);
  });

  test("validation errors name the originating file and the key path inside it", async () => {
    const paths = await home({
      "conveyor.yaml": `${DEFAULTS}repositories: !include_dir_named repositories/\n`,
      "repositories/meal-planner.yaml": repository("/tmp", "delivry"),
    });
    const message = await failure(loadConfig(paths.entrypoint, null, { home: paths.home }));
    expect(message).toContain('- repositories/meal-planner.yaml: pipeline references unknown pipeline "delivry"');

    await writeFile(path.join(paths.config, "repositories/meal-planner.yaml"), repository("/tmp").replace("ci: { mode: disabled }", "ci: { mode: sometimes }"));
    expect(await failure(loadConfig(paths.entrypoint, null, { home: paths.home }))).toContain("- repositories/meal-planner.yaml: ci: Invalid input");
  });

  test("!secret reads secrets.yaml beside the entrypoint; secret values are collected for redaction", async () => {
    const paths = await home({
      "conveyor.yaml": `providers: !include providers.yaml\nweb:\n  sessionSecret: !secret session\n`,
      "providers.yaml": `items:\n  github: { type: github, webhookSecret: !secret github_webhook_secret, labels: ${LABELS} }\n`,
      "secrets.yaml": `github_webhook_secret: "hook-value-123"\nsession: "${"s".repeat(40)}"\n`,
    });
    const config = await loadConfig(paths.entrypoint, null, { home: paths.home });
    const github = config.sources.github!;
    expect(github.type === "github" && github.webhookSecret).toBe("hook-value-123");
    expect(config.web.sessionSecret).toBe("s".repeat(40));
    expect(config.secrets!.sort()).toEqual(["hook-value-123", "s".repeat(40)].sort());
    const shown = JSON.stringify(redactSecrets(config, config.secrets!));
    expect(shown).not.toContain("hook-value-123");
    expect(shown).not.toContain("s".repeat(40));
    expect(shown).toContain("<redacted>");
  });

  test("a missing secret names the key and never prints any secret value", async () => {
    const paths = await home({
      "conveyor.yaml": "providers: !include providers.yaml\n",
      "providers.yaml": `items:\n  github: { type: github, webhookSecret: !secret missing_key, labels: ${LABELS} }\n`,
      "secrets.yaml": "other: do-not-print-me\n",
    });
    const message = await failure(loadConfig(paths.entrypoint, null, { home: paths.home }));
    expect(message).toBe("providers.yaml: items.github.webhookSecret: !secret missing_key is not defined in secrets.yaml");
    expect(message).not.toContain("do-not-print-me");

    await rm(path.join(paths.config, "secrets.yaml"));
    expect(await failure(loadConfig(paths.entrypoint, null, { home: paths.home }))).toBe("providers.yaml: items.github.webhookSecret: !secret missing_key: secrets.yaml does not exist");
  });

  test("a missing include names the including chain", async () => {
    const paths = await home({ "conveyor.yaml": "agents: !include agents.yaml\n" });
    expect(await failure(composeConfig(paths.entrypoint))).toBe("cannot read agents.yaml (included from conveyor.yaml): file does not exist");
  });

  test("builtin: includes materialise the packaged defaults under the home, and unknown names are listed", async () => {
    const paths = await home({ "conveyor.yaml": DEFAULTS });
    const config = await loadConfig(paths.entrypoint, null, { home: paths.home });
    const copy = path.join(paths.home, "state/builtin", builtinDigest());
    expect(config.agents.kaveh!.instructions).toBe(path.join(copy, "instructions/kaveh.md"));
    expect(await readFile(config.agents.kaveh!.instructions, "utf8")).toContain("Kaveh");

    await writeFile(paths.entrypoint, "agents: !include builtin:nope.yaml\n");
    expect(await failure(loadConfig(paths.entrypoint, null, { home: paths.home }))).toStartWith("builtin:nope.yaml is not a packaged default; available: agents.yaml");
    await writeFile(paths.entrypoint, "agents: !include_dir_named builtin:instructions\n");
    expect(await failure(loadConfig(paths.entrypoint, null, { home: paths.home }))).toBe("conveyor.yaml: agents: !include_dir_named does not support builtin: paths");
  });

  test("a configuration directory still loads, with a deprecation warning", async () => {
    const paths = await home({ "a.yaml": "web: {}\n", "b.yaml": `settings: { runners: 3 }\nlabels: ${LABELS}\n` });
    const config = await loadConfig(paths.config, null);
    expect(config.mode).toBe("directory");
    // A directory keeps the v0.1 defaults: port 4300 and state under <root>/data.
    expect(config.web.listen).toBe("127.0.0.1:4300");
    expect(config.settings.database).toBe(path.join(paths.config, "data/conveyor.sqlite"));
    expect(config.warnings!.join("\n")).toContain("loading a configuration directory is deprecated");
  });
});
