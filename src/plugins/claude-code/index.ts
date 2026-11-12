import type { HarnessPlugin } from "../../core/plugins";
import { claudeCodeHarness } from "./harness";

/** The Claude Code CLI as an agent harness. */
export const claudeCodePlugin: HarnessPlugin = { role: "harness", type: "claude-code", create: () => claudeCodeHarness };
