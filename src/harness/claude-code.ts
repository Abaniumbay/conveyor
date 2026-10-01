import { runClaudeCode } from "../runner/claude-code";
import type { Harness } from "./types";

/** Claude Code as a harness (read-only agents). Sessions persist so `--resume` can continue them. */
export const claudeCodeHarness: Harness = {
  id: "claude-code",
  capabilities: { sessionResume: true },
  run: ({ answeredQuestion: _answeredQuestion, ...input }) => runClaudeCode(input),
};
