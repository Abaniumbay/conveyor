import type { HarnessPlugin } from "../../core/plugins";
import { installedCommandCheck } from "../../harness/doctor";
import { claudeCodeRunnerSchema } from "./config";
import { claudeCodeHarness } from "./harness";
import { claudeCodeProfile } from "./profile";

/** The Claude Code CLI as an agent harness. */
export const claudeCodePlugin: HarnessPlugin = {
  role: "harness",
  type: "claude-code",
  configSchema: claudeCodeRunnerSchema,
  profile: claudeCodeProfile,
  doctor: installedCommandCheck,
  create: () => claudeCodeHarness,
};
