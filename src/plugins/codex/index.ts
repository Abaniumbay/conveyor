import type { HarnessPlugin } from "../../core/plugins";
import { installedCommandCheck } from "../../harness/doctor";
import { codexAgentSettingsSchema, codexRunnerSchema } from "./config";
import { codexHarness } from "./harness";
import { codexProfile } from "./profile";

/** The Codex CLI as an agent harness. */
export const codexPlugin: HarnessPlugin = {
  role: "harness",
  type: "codex",
  configSchema: codexRunnerSchema,
  profile: codexProfile,
  agentSettingsSchema: codexAgentSettingsSchema,
  doctor: installedCommandCheck,
  create: () => codexHarness,
};
