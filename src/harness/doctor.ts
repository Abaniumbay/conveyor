// What `conveyor doctor` asks a harness plugin: whether a configured runner of its type can start.

import type { HarnessRunnerConfig } from "../config/schema";
import { agentLaunchCommand } from "../isolation/sandbox";

/** One doctor finding about a runner. */
export interface HarnessDoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** What to do about a warning or failure. */
  fix?: string;
}

export interface HarnessDoctorInput {
  /** The runner's configured name. */
  runnerName: string;
  runner: HarnessRunnerConfig;
  /** The executable a command resolves to on PATH, or null when it is not installed. */
  findTool(command: string): string | null;
}

/**
 * Whether the runner's command is installed and resolves to an executable: agents are launched
 * confined by their resolved path, so a command that does not resolve cannot start.
 */
export function installedCommandCheck({ runnerName, runner, findTool }: HarnessDoctorInput): HarnessDoctorCheck {
  const name = `harness ${runnerName}`;
  const found = findTool(runner.command);
  if (!found) {
    return { name, status: "fail", detail: `${runner.command} is not on PATH`, fix: `install ${runner.command} and authenticate it as the account Conveyor runs under` };
  }
  try {
    agentLaunchCommand({ command: found, env: {} });
  } catch {
    return {
      name,
      status: "fail",
      detail: `${runner.command} (${found}) cannot be resolved to an installed executable for confined launch`,
      fix: `point the runner's command at a working install: repair or reinstall ${runner.command} (a broken symlink is the usual cause), or set the command to its absolute path`,
    };
  }
  return { name, status: "ok", detail: found };
}
