import { runClaudeCode } from "./claude-code";
import { claudeCodeProfile } from "./profile";
import { readClaudeQuota } from "./quota";
import type { Harness } from "../../harness/types";

/** Claude Code as a harness (read-only agents). Sessions persist so `--resume` can continue them. */
export const claudeCodeHarness: Harness = {
  id: "claude-code",
  capabilities: { sessionResume: true },
  profile: claudeCodeProfile,
  // Claude Code reports its quota in its stream, which Conveyor stores with the run's events.
  quota: ({ harnessEvents }) => readClaudeQuota(harnessEvents()),
  run: ({ answeredQuestion: _answeredQuestion, ...input }) => runClaudeCode(input),
};
