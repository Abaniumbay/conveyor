// conveyor diagnostics export: a tarball to attach to a bug report. It never includes credentials
// or the database, and its manifest states what each file holds and which private material (issue
// content, repository details, agent output) it may contain, so the operator can review it first.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";

import { redactSecrets } from "../../config/compose";
import { loadConfig, type ConveyorConfig } from "../../config/load";
import { Redactor } from "../../log/logger";
import { logFiles } from "../../log/reader";
import { releaseStateFile } from "../../release/state";
import { BUILD } from "../../version";
import { CliError, EXIT } from "../args";
import { printJson, stringOption, type Command } from "../command";
import { control } from "../control-client";
import { doctorChecks } from "./doctor";
import { statePaths } from "./operations";

interface ManifestEntry {
  file: string;
  contents: string;
  /** Private material the file may hold; empty when none. */
  mayContain: string[];
}

export const EXCLUDED = [
  "the database (run history, agent transcripts, conversations, accounts)",
  "secrets.yaml, the session secret and every credential",
  "worktrees, run artifacts and backups",
];

/** Every secret a configuration holds: !secret values and the credential settings, wherever they came from. */
function configurationSecrets(config: ConveyorConfig): string[] {
  const values = [...(config.secrets ?? [])];
  if (config.web.sessionSecret) values.push(config.web.sessionSecret);
  if (config.web.push) values.push(config.web.push.privateKey);
  for (const source of Object.values(config.sources)) if (source.type === "github" && source.webhookSecret) values.push(source.webhookSecret);
  return values;
}

export const diagnosticsExport: Command = {
  name: "diagnostics export",
  summary: "write a redacted diagnostics bundle for a bug report, with a manifest of what it holds",
  options: { output: { type: "string", value: "<file.tar.gz>", description: "where to write it (default: ./conveyor-diagnostics-<time>.tar.gz)" } },
  async run(context) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = path.resolve(stringOption(context, "output") ?? `conveyor-diagnostics-${stamp}.tar.gz`);
    const work = await mkdtemp(path.join(tmpdir(), "conveyor-diagnostics-"));
    const name = `conveyor-diagnostics-${stamp}`;
    const bundle = path.join(work, name);
    await mkdir(bundle);
    try {
      const config = await loadConfig(context.paths.config, null, { home: context.paths.home }).catch(() => null);
      const redactor = new Redactor(config ? configurationSecrets(config) : []);
      const manifest: ManifestEntry[] = [];
      const add = async (file: string, content: string, contents: string, mayContain: string[] = []) => {
        await mkdir(path.dirname(path.join(bundle, file)), { recursive: true });
        await writeFile(path.join(bundle, file), redactor.text(content));
        manifest.push({ file, contents, mayContain });
      };

      await add("version.json", `${JSON.stringify(BUILD, null, 2)}\n`, "the Conveyor version, commit and runtime");
      const checks = await doctorChecks(context.paths.home, context.paths.config, async () => false);
      await add("doctor.json", `${JSON.stringify(checks, null, 2)}\n`, "the result of conveyor doctor", ["local paths and tool locations", "configuration error messages"]);
      if (config) {
        const { plans: _plans, secrets: _secrets, warnings, ...effective } = config;
        await add("config.yaml", stringify(redactSecrets(effective, configurationSecrets(config)), { aliasDuplicateObjects: false, lineWidth: 0 }), "the effective configuration, credentials redacted", ["repository details: addresses, folders, script paths", "agent instructions paths and settings"]);
        if (warnings?.length) await add("config-warnings.txt", `${warnings.join("\n")}\n`, "configuration warnings");
      }
      const status = await control<unknown>(context, "GET", "/v1/status").catch(() => null);
      await add("status.json", `${JSON.stringify(status ?? { running: false }, null, 2)}\n`, "the running service's status", ["private issue content: item references, titles and stop reasons, which can quote agent output"]);
      const releases = await readFile(releaseStateFile(context.paths.home), "utf8").catch(() => null);
      if (releases) await add("releases.json", releases, "upgrade and rollback history", ["local paths"]);
      const logs = (await statePaths(context)).logs;
      for (const file of await logFiles(logs)) {
        await add(`logs/${path.basename(file)}`, await readFile(file, "utf8"), "the service log (redacted again on export)", [
          "private issue content: item references and stop reasons, which can quote agent output",
          "repository details",
        ]);
      }
      await writeFile(path.join(bundle, "manifest.json"), `${JSON.stringify({ createdAt: new Date().toISOString(), conveyor: BUILD.version, files: manifest, excluded: EXCLUDED }, null, 2)}\n`);
      const flagged = [...new Set(manifest.flatMap((entry) => entry.mayContain))];
      await writeFile(path.join(bundle, "README.txt"), [
        "Conveyor diagnostics. Review before sharing.",
        "",
        "Not included: " + EXCLUDED.join("; ") + ".",
        "Credentials are redacted from every file. The files may still contain:",
        ...flagged.map((item) => `  - ${item}`),
        "",
        "manifest.json lists each file with what it holds.",
        "",
      ].join("\n"));
      const tar = Bun.spawn(["tar", "-C", work, "-czf", output, name], { stdout: "ignore", stderr: "pipe" });
      const [errors, code] = await Promise.all([new Response(tar.stderr).text(), tar.exited]);
      if (code !== 0) throw new CliError(`cannot write ${output}: ${errors.trim()}`, EXIT.failure);
      if (context.json) return printJson(context, { output, files: manifest, excluded: EXCLUDED });
      context.out([
        `Wrote ${output}`,
        `Not included: ${EXCLUDED.join("; ")}.`,
        "Review it before sharing; it may contain:",
        ...flagged.map((item) => `  - ${item}`),
      ].join("\n"));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
};
