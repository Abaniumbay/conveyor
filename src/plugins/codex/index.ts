import type { HarnessPlugin } from "../../core/plugins";
import { codexHarness } from "./harness";

/** The Codex CLI as an agent harness. */
export const codexPlugin: HarnessPlugin = { role: "harness", type: "codex", create: () => codexHarness };
