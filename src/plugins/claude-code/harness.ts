import { runClaudeCode } from "./claude-code";
import { claudeCodeProfile } from "./profile";
import type { Harness } from "../../harness/types";

/** Claude Code as a harness (read-only agents). Sessions persist so `--resume` can continue them. */
export const claudeCodeHarness: Harness = {
  id: "claude-code",
  capabilities: { sessionResume: true },
  profile: claudeCodeProfile,
  run: ({ answeredQuestion: _answeredQuestion, ...input }) => runClaudeCode(input),
};
