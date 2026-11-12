import { runCodex } from "./codex";
import { runCodexCheck } from "./codex-check";
import { runCodexSteering } from "./codex-steering";
import { codexProfile } from "./profile";
import type { Harness } from "../../harness/types";

/**
 * Codex as a harness. Agent sessions are persisted so `codex exec resume <SESSION_ID>` can continue
 * them; legacy stage producers run ephemeral. It also runs legacy verifier checks and the Operator.
 */
export const codexHarness: Harness = {
  id: "codex",
  capabilities: { sessionResume: true },
  profile: codexProfile,
  run: ({ answeredQuestion: _answeredQuestion, ...input }) => runCodex({ ...input, persistSession: true }),
  runEphemeral: (input) => runCodex(input),
  check: (input) => runCodexCheck(input),
  steer: (input) => runCodexSteering(input),
};
