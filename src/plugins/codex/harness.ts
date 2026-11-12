import { homedir } from "node:os";
import path from "node:path";

import { runCodex } from "./codex";
import { runCodexCheck } from "./codex-check";
import { runCodexSteering } from "./codex-steering";
import { codexProfile } from "./profile";
import { readCodexQuota } from "./quota";
import type { Harness } from "../../harness/types";

/**
 * Codex as a harness. Agent sessions are persisted so `codex exec resume <SESSION_ID>` can continue
 * them; legacy stage producers run ephemeral. It also runs legacy verifier checks and the Operator.
 */
export const codexHarness: Harness = {
  id: "codex",
  capabilities: { sessionResume: true },
  profile: codexProfile,
  // Codex records its quota in the service user's own session logs, whichever runner ran it.
  quota: () => readCodexQuota(process.env.CODEX_HOME || path.join(homedir(), ".codex")),
  run: ({ answeredQuestion: _answeredQuestion, ...input }) => runCodex({ ...input, persistSession: true }),
  runEphemeral: (input) => runCodex(input),
  check: (input) => runCodexCheck(input),
  steer: (input) => runCodexSteering(input),
};
