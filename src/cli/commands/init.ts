import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { hashPassword } from "../../web/auth";
import { resolveSessionSecret } from "../../web/session-secret";
import { CliError, EXIT } from "../args";
import { printJson, stringOption, type Command } from "../command";
import { isInteractive, newPassword, prompt } from "../secret-input";
import { validUsername, withStore } from "./admin";

export const CONFIG_TEMPLATE = `# Conveyor configuration: the single entrypoint. Keep this directory in a private Git
# repository if you like; secrets.yaml stays out of it (see .gitignore).
#
# A section is written inline or included from another file:
#   !include <file>                  the file's content
#   !include_dir_named <dir>         one entry per file, named after the file
#   !include_dir_merge_named <dir>   the maps of every file, merged
#   !secret <key>                    a value from secrets.yaml
#   !include builtin:<file>          a packaged default (\`conveyor config builtin\` lists them)

settings:
  runners: 1

web:
  listen: 127.0.0.1:7788
  # publicUrl: https://conveyor.example.com

providers: !include builtin:providers.yaml
harnesses: !include builtin:harnesses.yaml
agents: !include builtin:agents.yaml
pipelines: !include builtin:pipelines.yaml

# One file per repository; the file name is the repository id.
repositories: !include_dir_named repositories/
`;

const REPOSITORIES_README = `# Repositories

One YAML file per repository; the file name (without .yaml) is its id. For example,
\`meal-planner.yaml\`:

\`\`\`yaml
items: github
code: github
ci: { mode: disabled }
address: owner/meal-planner
folder: ~/codes/meal-planner      # an existing Git checkout
pipeline: delivery
agentEgress:
  allowLoopbackMcp: true
  httpsHosts: [registry.npmjs.org]
\`\`\`
`;

/** Writes `content` unless the file exists; returns whether it wrote. */
async function writeNew(file: string, content: string, mode?: number): Promise<boolean> {
  if (await stat(file).catch(() => undefined)) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, mode === undefined ? {} : { mode });
  if (mode !== undefined) await chmod(file, mode);
  return true;
}

/** Ensures `.gitignore` lists `secrets.yaml`, keeping whatever else it holds. */
async function ignoreSecrets(directory: string): Promise<boolean> {
  const file = path.join(directory, ".gitignore");
  const current = await readFile(file, "utf8").catch(() => "");
  if (current.split(/\r?\n/).some((line) => line.trim() === "secrets.yaml" || line.trim() === "/secrets.yaml")) return false;
  await writeFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}secrets.yaml\n`);
  return true;
}

export const init: Command = {
  name: "init",
  summary: "create the Conveyor home, a starter configuration and the first administrator",
  options: {
    "admin-username": { type: "string", value: "<name>", description: "the first administrator's username (prompted on a terminal)" },
    "admin-password-file": { type: "string", value: "<file|->", description: "read the administrator's password from a file (- for stdin)" },
  },
  details: [
    "Safe to repeat: existing files are kept, a configuration cloned into <home>/config is used as is,",
    "and the administrator is created only while no dashboard account exists.",
  ].join("\n"),
  async run(context) {
    const { paths } = context;
    if (path.dirname(paths.config) !== paths.configDirectory || path.basename(paths.config) !== "conveyor.yaml") {
      throw new CliError("init writes <home>/config/conveyor.yaml; do not combine it with --config", EXIT.usage);
    }
    const created: string[] = [];
    for (const directory of [paths.home, paths.configDirectory, paths.state, paths.logs, paths.artifacts, paths.worktrees, paths.run]) {
      if (!(await stat(directory).catch(() => undefined))) created.push(directory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await chmod(paths.home, 0o700);
    if (await writeNew(paths.config, CONFIG_TEMPLATE)) created.push(paths.config);
    if (await writeNew(path.join(paths.configDirectory, "secrets.yaml"), "# Secrets referenced with !secret <key>. Never commit this file.\n{}\n", 0o600)) {
      created.push(path.join(paths.configDirectory, "secrets.yaml"));
    }
    if (await ignoreSecrets(paths.configDirectory)) created.push(path.join(paths.configDirectory, ".gitignore"));
    const repositories = path.join(paths.configDirectory, "repositories");
    if (await writeNew(path.join(repositories, "README.md"), REPOSITORIES_README)) created.push(repositories);

    const admin = await withStore(context, async (store) => {
      // The session secret lives beside the database; create it now so the first start finds it.
      await resolveSessionSecret(undefined, store.sqlite().filename, {});
      const existing = store.dashboardAccounts();
      if (existing.length > 0) return { created: false, username: existing.find((account) => account.role === "superuser")?.username ?? existing[0]!.username };
      const usernameOption = stringOption(context, "admin-username");
      const passwordFile = stringOption(context, "admin-password-file");
      if (!usernameOption && !isInteractive()) {
        throw new CliError("no dashboard account exists yet: pass --admin-username and --admin-password-file", EXIT.usage);
      }
      const username = validUsername(usernameOption ?? (await prompt("Administrator username: ")));
      store.seedDashboardSuperuser(username, hashPassword(await newPassword(passwordFile)));
      return { created: true, username };
    });

    if (context.json) {
      printJson(context, { home: paths.home, config: paths.config, created, administrator: admin });
      return;
    }
    context.out([
      `Conveyor home: ${paths.home}`,
      ...created.map((entry) => `  created ${entry}`),
      admin.created ? `Administrator ${admin.username} created.` : `Dashboard accounts exist (administrator: ${admin.username}); none created.`,
      "",
      "Next:",
      `  1. Add repositories under ${repositories}/ (one file each).`,
      "  2. Authenticate GitHub (gh auth login) and your agent CLIs.",
      `  3. conveyor doctor${context.options.home ? ` --home ${paths.home}` : ""}`,
      `  4. conveyor serve${context.options.home ? ` --home ${paths.home}` : ""}`,
    ].join("\n"));
  },
};
