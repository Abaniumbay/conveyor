// The Conveyor home: configuration and operational data, independent of the installed executable
// and of the managed repositories. `--home`, then CONVEYOR_HOME, then ~/.conveyor select it.

import { homedir } from "node:os";
import path from "node:path";

export interface HomePaths {
  home: string;
  /** The configuration directory; may be the operator's private configuration repository. */
  configDirectory: string;
  /** The configuration entrypoint (or a deprecated configuration directory). */
  config: string;
  state: string;
  logs: string;
  artifacts: string;
  worktrees: string;
  /** Runtime files: the control socket. */
  run: string;
  controlSocket: string;
  backups: string;
}

export function resolveHome(option: string | undefined, environment: NodeJS.ProcessEnv = process.env): string {
  const chosen = option ?? environment.CONVEYOR_HOME ?? path.join(homedir(), ".conveyor");
  if (chosen === "~" || chosen.startsWith("~/")) return path.join(homedir(), chosen.slice(1));
  return path.resolve(chosen);
}

/** The home layout; `config` is `--config` when given, else `<home>/config/conveyor.yaml`. */
export function homePaths(home: string, configOption?: string): HomePaths {
  const configDirectory = path.join(home, "config");
  const run = path.join(home, "run");
  return {
    home,
    configDirectory: configOption ? path.dirname(path.resolve(configOption)) : configDirectory,
    config: configOption ? path.resolve(configOption) : path.join(configDirectory, "conveyor.yaml"),
    state: path.join(home, "state"),
    logs: path.join(home, "logs"),
    artifacts: path.join(home, "artifacts"),
    worktrees: path.join(home, "worktrees"),
    run,
    controlSocket: path.join(run, "control.sock"),
    backups: path.join(home, "backups"),
  };
}
