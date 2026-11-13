import type { HarnessPlugin } from "../../core/plugins";
import { installedCommandCheck, type HarnessDoctorCheck, type HarnessDoctorInput } from "../../harness/doctor";
import { piRunnerSchema } from "./config";
import { piHarness } from "./harness";
import { PI_PACKAGE, piInstallation } from "./launch";
import { piProfile } from "./profile";

/** Whether the runner's pi is installed as its npm package, with the interpreter it runs on. */
export function piDoctorCheck(input: HarnessDoctorInput): HarnessDoctorCheck {
  const installed = installedCommandCheck(input);
  if (installed.status !== "ok") return installed;
  try {
    const found = piInstallation(input.runner.command, { PATH: process.env.PATH ?? "" });
    return { ...installed, detail: found.interpreter ? `${found.executable} on ${found.interpreter.path}` : found.executable };
  } catch (error) {
    return {
      name: installed.name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: `install pi as the npm package ${PI_PACKAGE}, with Node.js 22.19 or newer on the service's PATH`,
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
