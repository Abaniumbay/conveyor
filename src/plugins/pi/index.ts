import type { HarnessPlugin } from "../../core/plugins";
import { installedCommandCheck, type HarnessDoctorCheck, type HarnessDoctorInput } from "../../harness/doctor";
import type { Environment } from "../../isolation/environment";
import { piRunnerSchema } from "./config";
import { piHarness } from "./harness";
import { PI_PACKAGE, piInstallation } from "./launch";
import { piProfile } from "./profile";

/**
 * Whether the runner's pi is installed (by pi's official installer or as its npm package), with the
 * interpreter it runs on and, for the installer, the release its launcher picks.
 */
export function piDoctorCheck(input: HarnessDoctorInput, parent: Environment = process.env): HarnessDoctorCheck {
  const installed = installedCommandCheck(input);
  if (installed.status !== "ok") return installed;
  try {
    const found = piInstallation(input.runner.command, { PATH: parent.PATH ?? "" }, parent);
    const program = found.interpreter ? `${found.executable} on ${found.interpreter.path}` : found.executable;
    return { ...installed, detail: found.release ? `pi ${found.release.version} (official installer): ${program}` : program };
  } catch (error) {
    return {
      name: installed.name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: `install pi with its official installer, or as the npm package ${PI_PACKAGE} with Node.js 22.19 or newer on the service's PATH`,
    };
  }
}

/** The pi coding agent as an agent harness. */
export const piPlugin: HarnessPlugin = {
  role: "harness",
  type: "pi",
  configSchema: piRunnerSchema,
  profile: piProfile,
  doctor: piDoctorCheck,
  create: () => piHarness,
};
